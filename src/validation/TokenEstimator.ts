export interface TokenFactors {
  /** Chars per token for Latin text and code strings (probe: 3.32). */
  text: number;
  /** Chars per token for JSON structure: keys, quotes, punctuation, numbers (probe: 1.48). */
  json: number;
  /** Chars per token for mostly non-Latin strings such as Hebrew (probe: 1.26). */
  nonLatin: number;
  /** Share of non-ASCII chars above which a string counts as non-Latin. */
  nonLatinShare: number;
  /** Chars per token for dense log-like or numeric text (stress area 8: 1.66). */
  dense: number;
  /** Share of digits at or above which a string counts as dense. */
  denseShare: number;
}

/**
 * Pre-flight token estimate with factors measured by the live probe (PROBE-RESULTS.md) and the
 * stress test (dense log-like text, about 1.6 chars/token).
 * chars/4 under-counted code by 17%, JSON by 63% and Hebrew by 69%. Each string leaf uses
 * the text or non-Latin factor; everything else in the JSON text uses the JSON factor.
 * `usage.input_tokens` stays authoritative; this only guards the 32k/64k limits.
 */
export class TokenEstimator {
  constructor(private readonly f: TokenFactors) {}

  estimate(value: unknown): number {
    const json = JSON.stringify(value) ?? "";
    let stringChars = 0;
    let tokens = 0;
    this.forEachString(value, (s) => {
      stringChars += s.length;
      tokens += s.length / this.factorFor(s);
    });
    const structure = Math.max(0, json.length - stringChars);
    return Math.ceil(tokens + structure / this.f.json);
  }

  factorFor(s: string): number {
    if (s.length === 0) return this.f.text;
    let nonAscii = 0;
    let digits = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c > 0x7f) nonAscii++;
      else if (c >= 0x30 && c <= 0x39) digits++;
    }
    if (nonAscii / s.length > this.f.nonLatinShare) return this.f.nonLatin;
    return digits / s.length >= this.f.denseShare ? Math.min(this.f.dense, this.f.text) : this.f.text;
  }

  /** Visits string values and object keys (keys are counted as JSON structure, so skipped). */
  private forEachString(value: unknown, fn: (s: string) => void): void {
    if (typeof value === "string") fn(value);
    else if (Array.isArray(value)) value.forEach((v) => this.forEachString(v, fn));
    else if (typeof value === "object" && value !== null) Object.values(value).forEach((v) => this.forEachString(v, fn));
  }
}
