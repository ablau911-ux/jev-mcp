import type { SecretPattern } from "../config/types.js";
import { EntryWalker } from "../core/EntryWalker.js";
import { JevError } from "../core/JevError.js";
import type { Entry, Questions } from "../core/types.js";
import { DEFAULT_SECRET_KEYS } from "../config/prompts.js";
import { EncodedScanner, RunCache } from "../security/EncodedScanner.js";
import { JoinedText } from "../security/JoinedText.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { KeyedValues } from "../security/KeyedValues.js";
import type { Redactor } from "../security/Redactor.js";
import { SpanUnion } from "../security/SpanUnion.js";
import { ValueSyntax } from "../security/ValueSyntax.js";

export interface GuardOptions {
  patterns: SecretPattern[];
  /** `redact` (default) masks each match as `[REDACTED:<kind>]`; `refuse` blocks the request. */
  mode: "refuse" | "redact";
  /** Regex source of secret-like key names; the built-in list when absent. */
  keyPattern?: string;
  /** Command words that start a space-separated `word KEY value` pair (`ENV`, `setx`, ...); the built-in list when absent. */
  commandWords?: string[];
  /** Placeholder values (ValueSyntax); the built-in list when absent. */
  placeholders?: string[];
  /** Connection-string keys (ValueSyntax); the built-in list when absent. */
  connectionKeys?: string[];
  /** Type-alias keywords (ValueSyntax); the built-in list when absent. */
  typeWords?: string[];
}

interface CompiledPattern {
  name: string;
  re: RegExp;
  /** The pattern anchored to a whole string (shortest match of a split secret). */
  whole: RegExp;
  /** A `key = value` pattern: placeholder and code values are not matches. */
  keyed: boolean;
}

export interface RedactReport {
  state: Entry;
  questions: Questions;
  /** How many secrets were masked, by kind. Values are never reported. */
  counts: Record<string, number>;
  total: number;
}

/**
 * Shortest piece of a pattern match that the field where it starts must hold for the joined
 * scan to count it (round 5): a token cut inside its body (`ghp_FAKEfake0123...` +
 * `...789zz`) is a split secret; a bare prefix literal (`"ghp_"`, then `"FAKEfake..."`) is code.
 */
const MIN_PIECE = 8;
/** A key and its assignment (password then `=`, secret then `:`, Go `:=`, an opening quote): not counted toward MIN_PIECE (bug r6). */
const ASSIGNMENT_RE = /^[^:=]*(?::=|[:=])[\s"']*/;
const MASK_RE = /\[REDACTED:[a-z0-9_]+\]/g;
/** The key (group 1) and separator of a `key = value` pattern match, up to the value. */
const KEY_SEP_RE = /^([^:=]*?)\\?["']?[ \t]*(?::=|[:=])[ \t]*/;
/** Mask kind of a live credential that arrived encoded (base64, hex, percent, escapes). */
const ENCODED_LIVE_PREFIX = "live_credential_";
/** Mask kind of a non-live secret split between fields (bug r9: masked, not refused). */
export const SPLIT_KIND = "split_secret";
/** Longest pattern match whose shortest whole match is searched (the search is quadratic in it). */
const MAX_SHORTEST = 512;
/** Only callers holding a validated request may introduce question-label context. */
export type GuardContext = "data" | "request" | "questions" | "question" | "labels" | "output" | "probabilities";

/**
 * Non-negotiable secret guard (project policy): code may go to
 * TypeSafe, secrets never. There is no override: no tool argument, env var or config key
 * turns it off or shrinks it. It scans every string AND every object key: live secrets read
 * at runtime (the TypeSafe key, the tea token), the patterns (whole PEM blocks, AWS, GitHub,
 * Gitea, Slack, JWT, Bearer, generic `secret=...`, connection strings), `key: value` pairs
 * whose value alone looks harmless, and encoded runs (base64, hex, percent, `\u`/`\x`
 * escapes; EncodedScanner) that decode to any of these. JSON numbers are scanned as text.
 * Messages never quote a value. OutboundSanitizer runs it once more on the complete wire payload.
 */
export class SecretGuard {
  private readonly patterns: CompiledPattern[];
  private readonly values: KeyedValues;
  private readonly syntax: ValueSyntax;
  private readonly runCaches: [RunCache, RunCache] = [new RunCache(), new RunCache()];
  private cachedFor = -1;

  constructor(
    private readonly options: GuardOptions,
    private readonly redactor: Redactor,
  ) {
    this.patterns = options.patterns.map((p) => {
      const flags = (p.flags ?? "").replace("g", "");
      return { name: p.name, re: new RegExp(p.pattern, `${flags}g`), whole: new RegExp(`^(?:${p.pattern})$`, flags), keyed: p.keyed === true };
    });
    const guard = DEFAULT_CONFIG.secretGuard;
    this.syntax = new ValueSyntax(options.placeholders ?? guard.placeholders, options.connectionKeys ?? guard.connectionKeys, options.typeWords ?? guard.typeWords);
    this.values = new KeyedValues(options.keyPattern ?? DEFAULT_SECRET_KEYS, this.syntax, options.commandWords ?? DEFAULT_CONFIG.secretGuard.commandWords);
  }

  get mode(): "refuse" | "redact" {
    return this.options.mode;
  }

  /** Masks every secret in state, instructions and criteria, keys included (redact mode); refuse mode leaves text as is. */
  redact(state: Entry, questions: Questions): RedactReport {
    const counts: Record<string, number> = {};
    if (this.options.mode !== "redact") return { state, questions, counts, total: 0 };
    const outQuestions: Questions = {};
    for (const [id, q] of Object.entries(questions)) {
      const copy = { ...q };
      if (q.instructions !== undefined) copy.instructions = this.redactTree(q.instructions, counts);
      if (q.criteria !== undefined) copy.criteria = this.redactTree(q.criteria, counts, true);
      outQuestions[id] = copy;
    }
    const outState = this.redactTree(state, counts);
    return { state: outState, questions: outQuestions, counts, total: SecretGuard.total(counts) };
  }

  /**
   * Masks secrets in every string and object key of a tree. A string value whose key makes
   * it a secret (`{password: "..."}`) is masked whole. Two keys that become equal after
   * masking would silently drop data, so that request is refused instead. In a label map
   * (`labels`, SecretGuard.isLabelMap) the keys are labels, not field names: each value is free text.
   */
  redactTree(value: Entry, counts: Record<string, number>, labels = false, context: GuardContext = "data"): Entry {
    if (typeof value === "string") return this.redactString(value, counts);
    if (typeof value === "number") return this.redactNumber(value, (s) => this.redactString(s, counts));
    if (Array.isArray(value)) return value.map((v, i) => this.redactTree(v, counts, false, SecretGuard.childContext(context, String(i))));
    if (typeof value !== "object" || value === null) return value;
    const out: Record<string, Entry> = {};
    for (const [k, v] of Object.entries(value)) {
      const key = JoinedText.uniqueKey(out, this.redactString(k, counts));
      const item = !labels && context !== "labels" && !(context === "probabilities" && typeof v === "number") && (typeof v === "string" || typeof v === "number" || (Array.isArray(v) && this.isSecretKey(k)));
      EntryWalker.setField(out, key, item ? this.redactItem(k, v, counts) : this.redactTree(v, counts, false, SecretGuard.childContext(context, k, value)));
    }
    return out;
  }

  /**
   * True when `parent[key]` is a question's criteria (`{type, criteria: {label: description}}`):
   * its keys are labels the caller chose (`missing_api_key`), not field names, so the pair rule
   * never masks a description or a value under them; each is still scanned as free text (break hunt).
   */
  private static childContext(context: GuardContext, key: string, parent?: unknown): GuardContext {
    if (context === "output") return key === "probabilities" && SecretGuard.probabilityAnswer(parent) ? "probabilities" : "output";
    if (context === "request" && key === "1") return "questions";
    if (context === "questions") return "question";
    if (context === "question" && key === "criteria") return "labels";
    return "data";
  }

  /** Only trusted output sinks may recognize numeric probability maps in answer shapes. */
  private static probabilityAnswer(value: unknown): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const a = value as Record<string, unknown>;
    const probability = (n: unknown): boolean => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
    const map = a.probabilities;
    if (typeof map !== "object" || map === null || Array.isArray(map) || Object.keys(map).length === 0 || !Object.values(map).every(probability)) return false;
    const choice = typeof a.choice === "string" && probability(a.confidence) && Object.hasOwn(map, a.choice);
    const score = a.type === "score" && typeof a.score === "number" && Number.isFinite(a.score) && probability(a.confidence);
    const shaped = (typeof a.verdict === "string" || a.verdict === null) && probability(a.p) && ["auto", "confirm", "review"].includes(String(a.decision));
    return choice || score || shaped;
  }

  redactString(s: string, counts: Record<string, number>): string {
    const bump = (kind: string) => (counts[kind] = (counts[kind] ?? 0) + 1);
    const mask = (kind: string) => {
      bump(kind);
      return SecretGuard.mask(kind);
    };
    // Bug r20: live secrets, known-token patterns and keyed values are found on the original text and unioned.
    const union = new SpanUnion();
    for (const r of this.redactor.secretRanges(s)) union.add(r.start, r.end, r.kind, 3);
    for (const p of this.patterns) for (const [start, end] of this.patternHits(p, s)) union.add(start, end, p.name, 2);
    for (const [start, end] of this.values.secretRanges(s)) union.add(start, end, KeyedValues.KIND, 1);
    return EncodedScanner.replace(union.apply(s, mask), (decoded) => this.plainKind(decoded), mask, this.runCache(true));
  }

  /** Errors for anything still secret (refuse mode, or a secret that survived), keys included. */
  check(values: unknown[], context: GuardContext = "data"): string[] {
    const errors = new Set<string>();
    for (const value of values) {
      EntryWalker.forEachStringOrKey(value, (s) => {
        for (const kind of this.findings(s)) errors.add(SecretGuard.message(kind));
      });
      // The value alone was scanned above (encoded forms included); the pair adds key context only.
      this.forEachPair(value, (k, v) => {
        const kind = this.pairKind(k, v);
        if (kind !== undefined) errors.add(SecretGuard.message(kind));
      }, context);
    }
    return [...errors];
  }

  /** Kinds of secret in one string: live secrets, patterns, and base64 tokens that decode to either. */
  findings(s: string, keyed = true): string[] {
    // The guard's own markers stay in place: a value that is only a marker is inert, and the next field never becomes the value.
    const text = s;
    const kinds = new Set<string>();
    if (this.redactor.containsSecret(text)) kinds.add("live_credential");
    for (const name of this.matches(text, keyed)) kinds.add(name);
    for (const kind of EncodedScanner.find(text, (decoded) => this.plainKind(decoded, keyed), this.runCache(keyed))) kinds.add(kind);
    return [...kinds];
  }

  /** True when a live credential can be put together from fragments of `parts`. */
  assembledFrom(parts: string[]): boolean {
    return this.redactor.assembledFrom(parts);
  }

  /**
   * The narrowed scan of `parts` joined with `sep` (round 5): registered live secrets and
   * secret values whose key sits in an earlier field. With `patterns` (the wire), also a pattern
   * match cut inside its body: the field where it starts holds MIN_PIECE+ characters of it, so
   * an unregistered bare prefix literal (`"ghp_"`) glued to other fields is not refused.
   */
  joinedFindings(parts: string[], sep: string, patterns = false, keys?: ReadonlySet<number>): string[] {
    // The guard's own markers stay (bug r10/r17): a key before one (`PASSWORD=[REDACTED]`) reads the marker as its (inert) value, never the next field.
    const joined = new JoinedText(parts, sep, keys);
    const kinds = new Set<string>();
    if (this.redactor.containsSecret(joined.text)) kinds.add("live_credential");
    if (this.values.splitRanges(joined).length > 0) kinds.add(KeyedValues.KIND);
    if (patterns) for (const p of this.patterns) if (this.cutRanges(p, joined).length > 0) kinds.add(p.name);
    return [...kinds];
  }

  /**
   * `[start, end)` of every match of `p` in the joined text that a field boundary cuts and whose
   * field (where the match starts) holds MIN_PIECE+ characters of it.
   */
  private cutRanges(p: CompiledPattern, joined: JoinedText): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const [start, end] of this.patternHits(p, joined.text)) {
      // A match inside one field was judged per string; only a match cut by a field boundary is split.
      if (end <= joined.fieldEnd(start)) continue;
      const piece = joined.text.slice(start, joined.fieldEnd(start));
      const body = piece.replace(ASSIGNMENT_RE, "");
      // The value's piece in its own field decides placeholder / expansion (round 7), as for keyed values.
      const exempt = p.keyed && this.syntax.isInert(body);
      if (body.length >= MIN_PIECE && !exempt) out.push([start, end]);
    }
    return out;
  }

  /**
   * Masks a split secret that is NOT a registered live secret (bug r9: only a live secret
   * refuses): every keyed value split from its key and, with `patterns`, every pattern match cut inside its
   * body, of the fields joined with no separator and with one space, in the leaves that hold it.
   */
  maskSplit(value: Entry, patterns: boolean): Entry {
    const mask = SecretGuard.mask(SPLIT_KIND);
    // Ranges are clipped so a greedy run never swallows the fields after the secret: a keyed
    // value ends before the next object key, a pattern match at its shortest whole match.
    const ranges = (j: JoinedText): Array<[number, number]> => [
      ...this.values.splitRanges(j),
      ...(patterns ? this.patterns.flatMap((p) => this.cutRanges(p, j).map(([s, e]): [number, number] => [s, SecretGuard.shortestEnd(p, j.text, s, e)])) : []),
    ];
    return JoinedText.maskRanges(JoinedText.maskRanges(value, "", ranges, mask), " ", ranges, mask);
  }

  /** End of the shortest whole match of `p` that starts at `start` (a long match is kept whole). */
  private static shortestEnd(p: CompiledPattern, text: string, start: number, end: number): number {
    if (end - start > MAX_SHORTEST) return end;
    for (let e = start + 1; e < end; e++) if (p.whole.test(text.slice(start, e))) return e;
    return end;
  }

  /** True when a key name is credential-like (`token`, `api_key`, `password`, ...). */
  isSecretKey(name: string): boolean {
    return this.values.isSecretKey(name);
  }

  /** Masks every live-secret fragment in the strings and keys of a tree (a record that holds a split secret). */
  maskFragments(value: Entry): Entry {
    const mask = (s: string) => this.redactor.maskFragments(s, (kind) => SecretGuard.mask(kind));
    if (typeof value === "string") return mask(value);
    if (typeof value === "number") return this.redactNumber(value, mask);
    if (Array.isArray(value)) return value.map((v) => this.maskFragments(v));
    if (typeof value !== "object" || value === null) return value;
    const out: Record<string, Entry> = {};
    for (const [k, v] of Object.entries(value)) EntryWalker.setField(out, JoinedText.uniqueKey(out, mask(k)), this.maskFragments(v));
    return out;
  }

  /** Pattern names and the keyed kind found in one string; `keyed = false` (a serialized payload whose pairs were judged per string) leaves out the key = value patterns and keyed values. */
  matches(s: string, keyed = true): string[] {
    // The guard's own markers stay in place: a value that is only a marker is inert, and the next field never becomes the value.
    const text = s;
    const names = this.patterns.filter((p) => (keyed || !p.keyed) && this.patternHits(p, text).length > 0).map((p) => p.name);
    if (keyed && this.values.has(text)) names.push(KeyedValues.KIND);
    return names;
  }

  /**
   * `[start, end)` of every match of `p` in `text`. For a `key = value` pattern a match whose
   * value is not a secret under the syntax policy (ValueSyntax, round 8) is not a match: the
   * same rule as the keyed values, on every sink.
   */
  private patternHits(p: CompiledPattern, text: string): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const m of text.matchAll(p.re)) {
      const end = p.keyed ? this.keyedMatchEnd(text, m.index, m[0]) : m.index + m[0].length;
      if (end >= 0) out.push([m.index, end]);
    }
    return out;
  }

  /**
   * End of a `key = value` match under the shared value policy (KeyedValues.isSecret): -1 when
   * the value is not a secret, else the end of the match or of the whole value, whichever is
   * later (bug r13: `PASSWORD=$(cat x` masks the whole value, not the pattern's piece).
   */
  private keyedMatchEnd(text: string, at: number, match: string): number {
    const sep = KEY_SEP_RE.exec(match);
    if (!sep) return at + match.length;
    const span = this.values.read(text, at, at + (sep[1] ?? "").length, at + sep[0].length);
    if (!span || !this.values.isSecret(span)) return -1;
    // A connection-string field ends at its `;` (ValueSyntax): the pattern's greedy run never crosses it.
    return span.field === true ? span.end : Math.max(at + match.length, span.end);
  }

  static mask(kind: string): string {
    return `[REDACTED:${kind}]`;
  }

  /**
   * Refuses when this pass masked an encoded live credential. Judged by the kinds the
   * guard itself counted, never by marker text in the input: the guard's own `[REDACTED:...]`
   * marker passes unchanged (bug r16).
   */
  static refuseEncodedLive(counts: Record<string, number>): void {
    if (Object.keys(counts).some((k) => k.startsWith(ENCODED_LIVE_PREFIX))) throw SecretGuard.refused("The request (an encoded live credential)");
  }

  static total(counts: Record<string, number>): number {
    return Object.values(counts).reduce((a, b) => a + b, 0);
  }

  /** The refusal used when a secret cannot be masked (refuse mode, model ids, binary parts). */
  static refused(what: string): JevError {
    return new JevError({ kind: "secret", message: `${what} contains a secret; refusing to send it.`, fix: "Remove the credential and call again; nothing was sent.", loc: "$" });
  }

  /** A secret kind in plain (decoded) text, or null. */
  /**
   * The decoded-run results shared by every pass and sink (bug r22b), one per `keyed` mode. They
   * hold while the set of live secrets is unchanged; a new live secret clears them.
   */
  private runCache(keyed: boolean): RunCache {
    if (this.redactor.registered !== this.cachedFor) {
      this.cachedFor = this.redactor.registered;
      this.runCaches.forEach((c) => c.clear());
    }
    return this.runCaches[keyed ? 0 : 1];
  }

  private plainKind(text: string, keyed = true): string | null {
    if (this.redactor.containsSecret(text)) return "live_credential";
    return this.matches(text, keyed)[0] ?? null;
  }

  /** A number is scanned as its text; it becomes the mask string only when it is secret. */
  private redactNumber(value: number, redact: (s: string) => string): Entry {
    const text = String(value);
    const masked = redact(text);
    return masked === text ? value : masked;
  }

  /** A `{password: <value>}` pair (also each string item of `{token: [...]}`): masked whole when the pair is a secret. */
  private redactPair(key: string, value: string, counts: Record<string, number>): string {
    const masked = this.redactString(value, counts);
    // Bug r13: a value still secret after its inner masks (`{token: "hello token=x world"}`) is masked whole.
    const kind = this.pairKind(key, masked);
    if (kind === undefined) return masked;
    counts[kind] = (counts[kind] ?? 0) + 1;
    return SecretGuard.mask(kind);
  }

  /**
   * The value of `key`. Under a secret key the context flows into nested arrays (bug r13/r14):
   * every string and number inside is a pair with that key. An object starts its own context
   * (its keys name its values: a question named `secret` keeps its `type` and `instructions`).
   */
  private redactItem(key: string, item: Entry, counts: Record<string, number>): Entry {
    if (typeof item === "string") return this.redactPair(key, item, counts);
    if (typeof item === "number") return this.redactNumber(item, (s) => this.redactPair(key, s, counts));
    if (Array.isArray(item)) return item.map((v) => this.redactItem(key, v, counts));
    return this.redactTree(item, counts);
  }

  /**
   * Residue the masking left (bug r13: the final scan re-masks, it never refuses for it): every
   * string or number that still holds a secret, alone or as a pair with its key, is masked whole.
   */
  maskResidue(value: Entry, counts: Record<string, number>, key?: string, labels = false, context: GuardContext = "data"): Entry {
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value);
      const pair = key !== undefined && this.pairKind(key, text) !== undefined;
      if (!pair && this.findings(text).length === 0) return value;
      counts[KeyedValues.KIND] = (counts[KeyedValues.KIND] ?? 0) + 1;
      // Bug r43: the whole LINE holding the residue is masked; neighbour lines stay (the whole value when a line alone does not show it).
      const lines = pair ? null : this.maskLines(text);
      return lines ?? SecretGuard.mask(KeyedValues.KIND);
    }
    if (Array.isArray(value)) return value.map((v, i) => this.maskResidue(v, counts, key, false, SecretGuard.childContext(context, String(i))));
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.maskResidue(v, counts, labels || context === "labels" || (context === "probabilities" && typeof v === "number") ? undefined : k, false, SecretGuard.childContext(context, k, value))]));
  }

  /** The string with every line that holds a finding masked whole, or null when no single line shows it or a finding is left. */
  private maskLines(text: string): string | null {
    if (!text.includes("\n")) return null;
    const out = text.split("\n").map((line) => (this.findings(line).length > 0 ? SecretGuard.mask(KeyedValues.KIND) : line)).join("\n");
    return out === text || this.findings(out).length > 0 ? null : out;
  }

  /**
   * The kind of secret in an object pair, or undefined: a pattern that needs the key
   * (`{token: <40 hex>}`), else (round 12, mask always) any string under a credential-named
   * key unless it is inert (empty, placeholder, expansion).
   */
  private pairKind(key: string, value: string): string | undefined {
    // A key that is itself text (`password=x`) is scanned as a string; only a plain key name pairs with its value.
    if (!/[\s:=]/.test(key)) {
      const text = `${key}: ${value}`;
      const pattern = this.patterns.find((p) => this.patternHits(p, text).length > 0);
      if (pattern) return pattern.name;
    }
    return this.values.isSecretKey(key) && !this.syntax.isInert(value.replace(MASK_RE, "")) ? KeyedValues.KIND : undefined;
  }

  /** Every key / value pair of a tree; a label map's entries (SecretGuard.isLabelMap) are not pairs. */
  private forEachPair(value: unknown, fn: (k: string, v: string) => void, context: GuardContext = "data"): void {
    if (Array.isArray(value)) value.forEach((v, i) => this.forEachPair(v, fn, SecretGuard.childContext(context, String(i))));
    else if (typeof value === "object" && value !== null) {
      for (const [k, v] of Object.entries(value)) {
        // A number is a value like a string (bug r26: `{password: 123456}` refuses in refuse mode).
        if (context !== "labels" && !(context === "probabilities" && typeof v === "number") && (typeof v === "string" || typeof v === "number")) fn(k, String(v));
        else if (context !== "labels" && Array.isArray(v) && this.isSecretKey(k)) this.forEachItem(k, v, fn);
        else this.forEachPair(v, fn, SecretGuard.childContext(context, k, value));
      }
    }
  }

  /** Every string and number in the (nested) arrays under secret key `k` as a pair; an object starts its own context. */
  private forEachItem(k: string, value: unknown, fn: (k: string, v: string) => void): void {
    if (typeof value === "string" || typeof value === "number") fn(k, String(value));
    else if (Array.isArray(value)) value.forEach((v) => this.forEachItem(k, v, fn));
    else this.forEachPair(value, fn);
  }

  private static message(kind: string): string {
    return kind === "live_credential"
      ? "$: request contains a live credential (TypeSafe key or tea token); refusing to send it."
      : `$: request matches secret pattern "${kind}"; remove it.`;
  }

}
