import type { JoinedText } from "./JoinedText.js";
import type { ValueSpan, ValueSyntax } from "./ValueSyntax.js";
import { SpacedKeys, type SpacedKey } from "./SpacedKeys.js";
import { StrippedText } from "./StrippedText.js";
import { YamlValueScanner } from "./YamlValueScanner.js";

/** A token: letters and digits (the shape a split value must have). */
const TOKEN_SHAPE_RE = /^(?=[^]*[A-Za-z])(?=[^]*[0-9])/;

/**
 * Values next to secret-like keys (round 12, mask always): in `key = value`, `key: value`,
 * `key := value`, JSON pairs, subscripts, comparisons and the space-separated contexts of
 * SpacedKeys (`ENV K v`, `setx K v`, `--password v`, ...; the line rules, ValueSyntax), and in YAML-shaped
 * text as a YAML parser reads it (YamlValueScanner, bug r16), the value is masked in every format
 * and context unless ValueSyntax calls it inert (empty, placeholder, expansion). Masking never
 * refuses; only a registered live secret refuses (SecretGuard).
 */
export class KeyedValues {
  static readonly KIND = "keyed_secret";
  private readonly key: RegExp;
  private readonly inText: RegExp;
  private readonly yaml: YamlValueScanner;
  private readonly spaced: SpacedKeys;
  private spacedText: string | null = null;
  private valuesText: string | null = null;
  private valuesOut: Array<{ keyStart: number; span: ValueSpan }> = [];
  private spacedKeys: SpacedKey[] = [];

  constructor(
    keyPattern: string,
    readonly syntax: ValueSyntax,
    commandWords: string[],
  ) {
    this.key = new RegExp(`(?:${keyPattern})$`, "i");
    // The key's end: an optional closing quote and subscript bracket (`x["k"] =`, `x[:k] =`, `ENV["K"] =`, bug r21),
    // then an assignment, a comparison (`==`, `===`, `!=`, `!==`, `.equals(`; bug r21b: mask always) or `:`.
    // A read-only access (`f(x["k"])`) has none of these.
    // Spaces may stand inside a subscript (`x[ 'k' ] =`, bug r22).
    this.inText = new RegExp(`(${keyPattern})(${String.raw`\\?["']?(?:[ \t]*\])?[ \t]*(?::=|:|!==?|={1,3}|\.equals(?:IgnoreCase)?\()[ \t]*`})`, "gi");
    this.yaml = new YamlValueScanner(keyPattern, (name) => this.isSecretKey(name));
    this.spaced = new SpacedKeys(commandWords, (name) => this.isSecretKey(name));
  }

  /** True when a key name (object key, argument name) ends in a credential word (`api_key`, `authToken`). */
  isSecretKey(name: string): boolean {
    return this.key.test(name);
  }

  /** True when `span` is a secret value under the policy above. */
  isSecret(span: ValueSpan): boolean {
    return span.block === true || span.braceQuoted === true || !this.syntax.isInert(span.text);
  }

  /** Every keyed value in `text` with the key's start, in order (space-separated contexts and YAML values included). */
  values(text: string): Array<{ keyStart: number; span: ValueSpan }> {
    // The same text is read by several passes (the joined scans, the residue check): the last result is reused (bug r28).
    if (text === this.valuesText) return this.valuesOut;
    this.valuesText = text;
    this.valuesOut = this.readValues(text);
    return this.valuesOut;
  }

  private readValues(text: string): Array<{ keyStart: number; span: ValueSpan }> {
    const out: Array<{ keyStart: number; span: ValueSpan }> = [...this.yaml.hits(text)];
    const spaced = this.spacedOf(text);
    for (const k of spaced) {
      const span = this.spacedSpan(text, k);
      if (span) out.push({ keyStart: k.keyStart, span });
    }
    this.lineRule(text, (i) => i, spaced, out);
    // The line rule also reads the diff / comment / blockquote prefix-stripped view, continuation measured on the
    // stripped indentation (bug r42: a blockquoted block scalar); its spans map back to the source and are unioned.
    for (const view of StrippedText.prefixes(text)) this.lineRule(view.text, (i) => view.toSource(i), spaced, out);
    return out.sort((a, b) => a.span.start - b.span.start);
  }

  /** The `key = value` / `key: value` line rule on `words` (a reading of the text); `map` turns its offsets into source offsets. */
  private lineRule(words: string, map: (i: number) => number, spaced: SpacedKey[], out: Array<{ keyStart: number; span: ValueSpan }>): void {
    let coveredUntil = 0;
    for (const m of words.matchAll(this.inText)) {
      // An opaque credential may itself contain key-looking assignments. Its complete
      // secret span already covers them; re-reading each suffix would be quadratic.
      if (m.index < coveredUntil) continue;
      const keyStart = map(m.index);
      // A key word the shell-word walk already read (`--password =x`, `setx API_TOKEN =x`) is not read again.
      if (KeyedValues.ownerAt(spaced, keyStart)) continue;
      const span = this.syntax.read(words, m.index, m.index + (m[1] ?? "").length, m.index + m[0].length);
      if (span) {
        out.push({ keyStart, span: { ...span, start: map(span.start), end: span.end > span.start ? map(span.end - 1) + 1 : map(span.start) } });
        if (this.isSecret(span)) coveredUntil = span.end;
      }
    }
  }

  /**
   * The value after the key `text[keyStart, keyEnd)` for the keyed patterns: the shell-word value
   * when the shell-word walk owns the key (`--password =x keepword`, bug r26), else ValueSyntax.read.
   */
  read(text: string, keyStart: number, keyEnd: number, valueStart: number): ValueSpan | null {
    const owner = KeyedValues.ownerAt(this.spacedOf(text), keyStart);
    return owner ? this.spacedSpan(text, owner) : this.syntax.read(text, keyStart, keyEnd, valueStart);
  }

  /** A space-separated key's value: its exact shell word, or (no word end) what ValueSyntax.read gives. */
  private spacedSpan(text: string, k: SpacedKey): ValueSpan | null {
    if (k.valueEnd === undefined) return this.syntax.read(text, k.keyStart, k.keyEnd, k.valueStart);
    return { key: text.slice(k.keyStart, k.keyEnd), start: k.valueStart, end: k.valueEnd, text: k.text ?? "" };
  }

  /**
   * The space-separated key whose key word holds `pos` (bug r28: a binary search over the keys in
   * key order, so the lookups stay linear in the input), or undefined.
   */
  private static ownerAt(keys: SpacedKey[], pos: number): SpacedKey | undefined {
    let lo = 0;
    let hi = keys.length - 1;
    let found: SpacedKey | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const k = keys[mid] as SpacedKey;
      if (k.keyStart <= pos) {
        found = k;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found && pos < found.keyEnd ? found : undefined;
  }

  /** The space-separated keys of `text` (the last text's are cached: every keyed pattern hit asks again). */
  private spacedOf(text: string): SpacedKey[] {
    if (text !== this.spacedText) {
      this.spacedText = text;
      this.spacedKeys = this.spaced.find(text);
    }
    return this.spacedKeys;
  }

  /** True when `text` holds a secret keyed value. */
  has(text: string): boolean {
    return this.values(text).some((v) => this.isSecret(v.span));
  }

  /** `[start, end)` of every secret keyed value in `text` (keys and quotes stay outside). */
  secretRanges(text: string): Array<[number, number]> {
    return this.values(text).filter((v) => this.isSecret(v.span)).map((v): [number, number] => [v.span.start, v.span.end]);
  }

  /**
   * Fields joined together (round 5): `[start, end)` of every secret value whose key sits
   * in an earlier field (`["token", "=", "kT8v..."]`), that does not start in an object key and
   * that has the shape of a token (letters and digits: code split into words, `["secret", "=",
   * "abcdefgh"]`, is not), cut before the next object key so a value never swallows the fields
   * after it. A value in its key's own field was judged per string.
   */
  splitRanges(joined: JoinedText): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const { keyStart, span } of this.values(joined.text)) {
      if (joined.fieldEnd(keyStart) > span.start || joined.isKeyAt(span.start) || !TOKEN_SHAPE_RE.test(span.text) || !this.isSecret(span)) continue;
      out.push([span.start, Math.min(span.end, joined.nextKeyStart(span.start))]);
    }
    return out;
  }
}
