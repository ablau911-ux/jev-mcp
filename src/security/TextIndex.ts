/** A line that is one word (a heredoc closer candidate): its indent, the word, trailing blanks. */
const WORD_LINE_RE = /^([ \t]*)([A-Za-z_]\w*)[ \t]*$/;

/**
 * Line and `<<` offsets of one text, found once and reused by every keyed read on that text
 * (bug r45: per-key `lastIndexOf` / `indexOf` / line regexes made long single lines quadratic).
 * Only the last text is kept; a new text replaces it.
 */
export class TextIndex {
  private static last: TextIndex | undefined;
  private readonly newlines: number[] = [];
  private readonly heredocs: number[] = [];
  private readonly searches = new Map<RegExp, { from: number; at: number }>();
  private words: { exact: Map<string, number[]>; indented: Map<string, number[]> } | undefined;
  private readonly runs = new Map<number, number>();

  private constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      // A lone `\r` (CR-only progress logs) ends a line too; `\r\n` counts once, at its `\n` (break hunt).
      if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) this.newlines.push(i);
      else if (c === 60 && text.charCodeAt(i + 1) === 60) this.heredocs.push(i);
    }
  }

  static of(text: string): TextIndex {
    if (TextIndex.last?.text !== text) TextIndex.last = new TextIndex(text);
    return TextIndex.last;
  }

  /** Offset where the line holding `pos` starts. */
  lineStart(pos: number): number {
    const i = TextIndex.firstAtOrAfter(this.newlines, pos);
    return i === 0 ? 0 : this.newlines[i - 1]! + 1;
  }

  /** Offset where the line holding `pos` ends (before `\r\n` / `\n` / a lone `\r`). */
  lineEnd(pos: number): number {
    const i = TextIndex.firstAtOrAfter(this.newlines, pos);
    const end = i < this.newlines.length ? this.newlines[i]! : this.text.length;
    return this.text.charCodeAt(end) === 10 && this.text.charCodeAt(end - 1) === 13 ? end - 1 : end;
  }

  /**
   * Start of the first line at or after `from` that holds `word` alone (trailing blanks allowed;
   * leading blanks too when `indented`), or -1: a heredoc closer. One index per text, so a closer
   * search per key no longer scans to the end of the text (break hunt: quadratic).
   */
  closerLine(word: string, indented: boolean, from: number): number {
    const words = this.wordLines();
    const lines = (indented ? words.indented : words.exact).get(word);
    if (!lines) return -1;
    const i = TextIndex.firstAtOrAfter(lines, from);
    return i < lines.length ? lines[i]! : -1;
  }

  /** The lines that hold one word, by word: flush left (`exact`) and with any indent (`indented`). */
  private wordLines(): { exact: Map<string, number[]>; indented: Map<string, number[]> } {
    if (this.words) return this.words;
    const words = { exact: new Map<string, number[]>(), indented: new Map<string, number[]>() };
    const add = (map: Map<string, number[]>, word: string, at: number): void => {
      const list = map.get(word);
      if (list) list.push(at);
      else map.set(word, [at]);
    };
    for (let i = 0; i <= this.newlines.length; i++) {
      const start = i === 0 ? 0 : this.newlines[i - 1]! + 1;
      const m = WORD_LINE_RE.exec(this.text.slice(start, this.lineEnd(start)));
      if (!m) continue;
      if (m[1] === "") add(words.exact, m[2]!, start);
      add(words.indented, m[2]!, start);
    }
    this.words = words;
    return words;
  }

  /**
   * End of the joined run that starts on the line at `lineStart`: the end of the first line from
   * there that `continues` says does not go on (or of the last line). Every line of a run has the
   * same end, so it is found once per run (break hunt: a backtick chain was rescanned per key).
   */
  joinedRunEnd(lineStart: number, continues: (lineEnd: number) => boolean): number {
    const seen: number[] = [];
    let end: number;
    for (let line = lineStart; ; ) {
      const known = this.runs.get(line);
      if (known !== undefined) {
        end = known;
        break;
      }
      seen.push(line);
      end = this.lineEnd(line);
      const next = this.text.indexOf("\n", line) + 1;
      if (!continues(end) || next <= 0 || next >= this.text.length) break;
      line = next;
    }
    for (const s of seen) this.runs.set(s, end);
    return end;
  }

  /** True when a `<<` starts in `[from, to)`. */
  hasHeredocMark(from: number, to: number): boolean {
    const i = TextIndex.firstAtOrAfter(this.heredocs, from);
    return i < this.heredocs.length && this.heredocs[i]! < to;
  }

  /**
   * Index of the first match of global `re` at or after `from`, or -1. The last search is reused:
   * a search from `s` that found `m` answers every `from` in `[s, m]` (bug r45: a line without a
   * next field made each key scan to the end of the text).
   */
  nextMatch(re: RegExp, from: number): number {
    const hit = this.searches.get(re);
    if (hit && from >= hit.from && from <= hit.at) return hit.at === Infinity ? -1 : hit.at;
    re.lastIndex = from;
    const at = re.exec(this.text)?.index ?? Infinity;
    this.searches.set(re, { from, at });
    return at === Infinity ? -1 : at;
  }

  /** Index of the first entry >= `pos` in a sorted array (binary search). */
  private static firstAtOrAfter(sorted: number[], pos: number): number {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
