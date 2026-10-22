/**
 * The line prefix, in this fixed order (bug r42): an optional diff marker (`+`, `-`, space), zero
 * or more blockquote markers (`>` and one optional space, each after up to 3 spaces as in
 * CommonMark, bug r43), an optional single comment marker (`#` and one optional space); or a `@@`
 * hunk header (blanked). The content's own indentation is not stripped, so content that starts
 * with `#` or `>` (a block scalar line) stays intact.
 */
const PREFIXES_RE = /^(?:@@.*$|[+\- ]?(?: {0,3}> ?)*(?:# ?)?)/;
/** The same, with indentation allowed before the FIRST blockquote marker only (`>   > x` keeps `> x` as content, bug r42). */
const FIRST_INDENT_RE = /^(?:@@.*$|[+\- ]?(?: {0,3}> ?)?(?:> ?)*(?:# ?)?)/;
/** A text that has such prefixed lines worth stripping. */
const PREFIXED_RE = /^(?:[+-]| {0,4}>| ?#|@@)/m;

/**
 * The text with a prefix removed from some lines; offsets map back to the original (bug r16 for
 * the YAML views, bug r29 for shell words). One line split and one join: linear.
 */
export class StrippedText {
  readonly text: string;
  private readonly starts: number[] = [];
  private readonly origins: number[] = [];

  constructor(source: string, strip: (line: string) => number) {
    const kept: string[] = [];
    let from = 0;
    let at = 0;
    for (const line of source.split("\n")) {
      const n = strip(line);
      this.starts.push(at);
      this.origins.push(from + n);
      kept.push(line.slice(n));
      at += line.length - n + 1;
      from += line.length + 1;
    }
    this.text = kept.join("\n");
  }

  /** The prefix-stripped readings of `source` (one, or two when nested blockquote indentation reads both ways); none when no line has a prefix. */
  static prefixes(source: string): StrippedText[] {
    if (!PREFIXED_RE.test(source)) return [];
    // Two readings of nested blockquote indentation (bug r43 CommonMark / bug r42 content), both kept when they differ.
    const nested = new StrippedText(source, (line) => PREFIXES_RE.exec(line)?.[0].length ?? 0);
    const first = new StrippedText(source, (line) => FIRST_INDENT_RE.exec(line)?.[0].length ?? 0);
    return first.text === nested.text ? [nested] : [nested, first];
  }

  /** The original offset of offset `pos` of the stripped text. */
  toSource(pos: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.starts[mid] ?? 0) <= pos) lo = mid;
      else hi = mid - 1;
    }
    return (this.origins[lo] ?? 0) + pos - (this.starts[lo] ?? 0);
  }
}
