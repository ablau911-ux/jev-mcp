import { isAlias, isMap, isScalar, isSeq, parseAllDocuments, type Document, type Scalar } from "yaml";
import { StrippedText } from "./StrippedText.js";
import type { ValueSpan } from "./ValueSyntax.js";

/** A value found by the YAML parser, with the start of its key (offsets in the original text). */
export interface YamlHit {
  keyStart: number;
  span: ValueSpan;
}

/** Longest text handed to the YAML parser; longer text keeps the line rules only. */
const MAX_PARSE = 512 * 1024;
/** Lines that are comments: the `#` and one following space are stripped (`# token:`). */
const COMMENT_RE = /^[ \t]*#[ \t]?/;
/** A unified-diff line: `+` / `-` / ` ` is stripped, a `@@` hunk header blanked. */
const DIFF_RE = /^(?:[+\- ]|@@.*$)/;
const BLOCK_TYPES = new Set(["BLOCK_LITERAL", "BLOCK_FOLDED"]);
const QUOTED_TYPES = new Set(["QUOTE_DOUBLE", "QUOTE_SINGLE"]);
/** A config key: one token, no whitespace (`INFO password:` or `The secret:` is a log line or prose, not YAML). */
const KEY_RE = /^[\w.-]+$/;
/** The guard's own marker (`[REDACTED:<kind>]`), which YAML would read as a flow sequence. */
const MARKER_RE = /^\[REDACTED:[a-z0-9_]+\]$/;
/** A Markdown code fence line: three or more backticks or tildes (group 1), then any info string. */
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})[^\n]*$/gm;
/** How many aliases are followed in a row (an alias of an alias...). */
const MAX_ALIAS_HOPS = 3;

/**
 * Values under secret-like keys in YAML-shaped text, found by a real YAML parser (bug r16,
 * Jev decision: eemeli/yaml, source ranges kept). The text is parsed as it is, and again with
 * comment prefixes (`# `), diff prefixes (`+`, `-`, ` `, `@@`) or both (`+ # `, bug r17)
 * stripped, so commented config and diff hunks are read too. For each pair whose key is secret-like, every scalar of
 * its value (a scalar, the items of a block or flow sequence, nested sequences, an anchored
 * node) is reported at its exact source span; a block scalar is its whole body (always a
 * secret). A nested map starts its own context; an alias holds no literal. Documents with
 * parse errors, text that is not YAML-shaped and keys with spaces (log lines, prose) are left to
 * the strict line rules (ValueSyntax), which cover every value on their own. Never throws on a
 * parse error. The last texts are cached.
 */
export class YamlValueScanner {
  private readonly cache = new Map<string, YamlHit[]>();
  /** The document being walked (an alias resolves against it). */
  private doc: Document.Parsed | null = null;
  private readonly shaped: RegExp;

  constructor(
    keyPattern: string,
    private readonly isSecretKey: (name: string) => boolean,
  ) {
    this.shaped = new RegExp(`(?:${keyPattern})["']?[ \\t]*:`, "i");
  }

  /** Every value under a secret-like key that the YAML parser finds in `text`. */
  hits(text: string): YamlHit[] {
    if (text.length > MAX_PARSE || !this.shaped.test(text)) return [];
    const cached = this.cache.get(text);
    if (cached) return cached;
    const found = new Map<string, YamlHit>();
    // The whole text, and each fenced code block on its own (bug r39: a Markdown fence makes the whole
    // document fail to parse; anchors resolve within their block). The spans are unioned.
    for (const region of YamlValueScanner.regions(text)) {
      for (const view of YamlValueScanner.views(region.part)) {
        for (const hit of this.parse(view)) {
          const end = region.map(hit.span.end - 1) + 1;
          const shifted = { keyStart: region.map(hit.keyStart), span: { ...hit.span, start: region.map(hit.span.start), end } };
          found.set(`${shifted.span.start}:${shifted.span.end}`, shifted);
        }
      }
    }
    const hits = [...found.values()].sort((a, b) => a.span.start - b.span.start);
    if (this.cache.size >= 16) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(text, hits);
    return hits;
  }

  /** The text as it is, and with comment / diff prefixes stripped when it has such lines. */
  /**
   * The parts parsed on their own, each with the map of its offsets to source offsets: the whole
   * text, the body of every fenced block, and (bug r40) the body of every fenced block of the
   * diff / comment prefix-stripped view (`+```yaml`, `# ```yaml`).
   */
  private static regions(text: string): Array<{ part: string; map: (i: number) => number }> {
    const regions = [{ part: text, map: (i: number) => i }];
    for (const [from, to] of YamlValueScanner.fences(text)) regions.push({ part: text.slice(from, to), map: (i) => i + from });
    for (const view of StrippedText.prefixes(text)) {
      for (const [from, to] of YamlValueScanner.fences(view.text)) regions.push({ part: view.text.slice(from, to), map: (i) => view.toSource(i + from) });
    }
    return regions;
  }

  /**
   * `[from, to)` of the body of every fenced code block (```` ``` ````, `~~~`, any info string;
   * closed by a fence of the same character, at least as long, without an info string; an
   * unclosed one runs to the end of the text, bug r40). One pass.
   */
  private static fences(text: string): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let open: { marker: string; body: number } | null = null;
    for (const m of text.matchAll(FENCE_RE)) {
      const marker = m[1] ?? "";
      if (!open) open = { marker, body: m.index + m[0].length + 1 };
      else if (marker[0] === open.marker[0] && marker.length >= open.marker.length && m[0].trim() === marker) {
        out.push([Math.min(open.body, m.index), m.index]);
        open = null;
      }
    }
    if (open) out.push([Math.min(open.body, text.length), text.length]);
    return out;
  }

  private static views(text: string): StrippedText[] {
    const views = [new StrippedText(text, () => 0)];
    if (/^[ \t]*#/m.test(text)) views.push(new StrippedText(text, (line) => COMMENT_RE.exec(line)?.[0].length ?? 0));
    if (/^(?:[+-]|@@)/m.test(text)) views.push(new StrippedText(text, (line) => DIFF_RE.exec(line)?.[0].length ?? 0));
    // Diff, comment and blockquote prefixes in any combination (`+ # `, `> `, `+> `; bug r17/r41).
    views.push(...StrippedText.prefixes(text));
    return views;
  }

  /** Hits of one view; a document with errors adds nothing. */
  private parse(view: StrippedText): YamlHit[] {
    const out: YamlHit[] = [];
    try {
      // prettyErrors off: a document with errors is dropped unread, and pretty errors cost a source scan each
      // (break hunt: 40k errors on a long line of flow mappings made the parse super-linear).
      for (const doc of parseAllDocuments(view.text, { logLevel: "silent", uniqueKeys: false, prettyErrors: false })) {
        if (doc.errors.length > 0) continue;
        this.doc = doc;
        this.walk(doc.contents, view, out);
      }
    } catch {
      return [];
    }
    return out;
  }

  /** Visits every pair of a map, and every item of a sequence, outside a secret context. */
  private walk(node: unknown, view: StrippedText, out: YamlHit[]): void {
    if (isSeq(node)) for (const item of node.items) this.walk(item, view, out);
    if (!isMap(node)) return;
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? pair.key : null;
      const keyStart = key?.range ? view.toSource(key.range[0]) : -1;
      if (key && keyStart >= 0 && KEY_RE.test(String(key.value)) && this.isSecretKey(String(key.value))) {
        this.secret(pair.value, keyStart, view, out);
      } else this.walk(pair.value, view, out);
    }
  }

  /** The value of a secret key: every scalar in it, through sequences; a map starts its own context. */
  private secret(node: unknown, keyStart: number, view: StrippedText, out: YamlHit[], hops = 0): void {
    const range = (node as { range?: [number, number] } | null)?.range;
    if (range && MARKER_RE.test(view.text.slice(range[0], range[1]).trim())) return;
    if (isScalar(node)) {
      const span = YamlValueScanner.span(node, view);
      if (span) out.push({ keyStart, span });
    } else if (isSeq(node)) for (const item of node.items) this.secret(item, keyStart, view, out, hops);
    else if (isMap(node)) this.walk(node, view, out);
    // An alias under a secret key masks the anchored node at its own source span, wherever the anchor sits (bug r38).
    else if (isAlias(node) && this.doc && hops < MAX_ALIAS_HOPS) this.secret(node.resolve(this.doc), keyStart, view, out, hops + 1);
  }

  /** The source span of a scalar: inside its quotes, or the body of a block scalar. */
  private static span(node: Scalar, view: StrippedText): ValueSpan | null {
    if (!node.range) return null;
    let [start, end] = node.range;
    const block = BLOCK_TYPES.has(node.type ?? "");
    const src = view.text.slice(start, end);
    if (block) start += src.indexOf("\n") + 1;
    else if (QUOTED_TYPES.has(node.type ?? "")) [start, end] = [start + 1, end - 1];
    while (start < end && /\s/.test(view.text[start] ?? "")) start++;
    while (end > start && /\s/.test(view.text[end - 1] ?? "")) end--;
    if (end <= start) return null;
    const text = block ? view.text.slice(start, end) : String(node.value ?? "");
    return { key: "", start: view.toSource(start), end: view.toSource(end), text, ...(block ? { block: true } : {}) };
  }

}
