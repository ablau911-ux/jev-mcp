/**
 * THE escape dialect of the secret guard (bug r35): POSIX shells escape with `\`, PowerShell
 * with a backtick; both are honoured everywhere a value is decoded or lines are joined
 * (ShellWords words, quotes, groups and nested strings; ValueSyntax continuations and quoted
 * literals). An escape character before a line break (`\n` or `\r\n`) continues the line.
 */
export class EscapeDialect {
  /** The escape characters: `\` (POSIX shells) and the backtick (PowerShell). */
  static readonly CHARS = "\\`";

  /** True when `c` escapes the next character. */
  static isEscape(c: string | undefined): boolean {
    return c !== undefined && c.length === 1 && EscapeDialect.CHARS.includes(c);
  }

  /** Length of a line continuation at `i` (escape + `\n` is 2, escape + `\r\n` is 3), or 0. */
  static continuation(text: string, i: number): number {
    if (!EscapeDialect.isEscape(text[i])) return 0;
    if (text[i + 1] === "\n") return 2;
    return text[i + 1] === "\r" && text[i + 2] === "\n" ? 3 : 0;
  }

  /** True when the line that ends at `lineEnd` (before its `\r\n` / `\n`) ends in an escape: it continues. */
  static continues(text: string, lineEnd: number): boolean {
    return EscapeDialect.isEscape(text[lineEnd - 1]);
  }

  /** True when escapes apply inside a string quoted with `quote`: a single-quoted string is literal (bug r36). */
  static escapesIn(quote: string | undefined): boolean {
    return quote !== "'";
  }

  /** True when the character at `i` is escaped (the character before it is an escape character). */
  static escaped(text: string, i: number): boolean {
    return EscapeDialect.isEscape(text[i - 1]);
  }

  /** What `\`/backtick decodes in a double-quoted string: a quote, an escape character, `$`, or a line break (removed). */
  static decodesInDoubleQuotes(c: string | undefined): boolean {
    return c === '"' || c === "$" || c === "\n" || EscapeDialect.isEscape(c);
  }
}
