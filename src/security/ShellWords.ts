import { EscapeDialect } from "./EscapeDialect.js";

/** One shell word: its source span `[start, end)`, its value (quotes and escapes resolved), and whether it starts a command. */
export interface ShellWord {
  start: number;
  end: number;
  text: string;
  first: boolean;
}

/** Unquoted command separators (bug r27): `;`, `&`, `&&`, `|`, `||`. */
const SEPARATORS = ";&|";
/** Characters that end a plain run inside a word: whitespace, separators, quotes, the escape characters. */
const PLAIN_STOP = new Set([...` \t\r\n;&|'"${EscapeDialect.CHARS}`].map((c) => c.charCodeAt(0)));

/**
 * A small shell-word tokenizer (bug r26/r27, Jev decision): whitespace separates words; an
 * unquoted `;` `&` `&&` `|` `||` separates commands (no spaces needed); single and double quotes
 * group (also across spaces and newlines); a backslash escapes the next character, `\"` inside
 * double quotes too; a backslash before `\n` / `\r\n` continues the line (inside a word or
 * between words, never an empty word). One logical line is read from `from` up to its first
 * unquoted, unescaped newline (or `until`). Linear, no dependency.
 */
export class ShellWords {
  /** The last text whose bracket closers were computed (closersOf), and those closers. */
  private static closersText: string | null = null;
  private static closers = new Map<number, number>();

  /** The words of the logical line that starts at `from`, and where that line ends. */
  static line(text: string, from: number, until = text.length): { words: ShellWord[]; end: number } {
    const words: ShellWord[] = [];
    let i = from;
    let first = true;
    while (i < until && text[i] !== "\n") {
      const c = text[i] ?? "";
      const cont = EscapeDialect.continuation(text, i);
      if (cont > 0 || c === " " || c === "\t" || c === "\r") {
        i += Math.max(cont, 1);
      } else if (SEPARATORS.includes(c)) {
        i += c !== ";" && text[i + 1] === c ? 2 : 1;
        first = true;
      } else {
        const word = ShellWords.word(text, i, until, first);
        words.push(word);
        first = false;
        i = word.end;
      }
    }
    return { words, end: i };
  }

  /**
   * The inside of a quoted string `text[from, until)` as the shell reads it (bug r28): in a double
   * quoted string `\"`, `\\`, `\$`, `` \` `` and `\`-newline are decoded; a single quoted one is
   * literal. `starts[i]` / `ends[i]` give the source span of decoded character `i`.
   */
  static unquote(text: string, from: number, until: number, double: boolean): { text: string; starts: number[]; ends: number[] } {
    let out = "";
    const starts: number[] = [];
    const ends: number[] = [];
    for (let i = from; i < until; ) {
      const escape = double && EscapeDialect.isEscape(text[i]) && i + 1 < until && EscapeDialect.decodesInDoubleQuotes(text[i + 1]);
      const ch = escape ? (text[i + 1] === "\n" ? "" : (text[i + 1] ?? "")) : (text[i] ?? "");
      const n = escape ? 2 : 1;
      if (ch !== "") {
        out += ch;
        starts.push(i);
        ends.push(i + n);
      }
      i += n;
    }
    return { text: out, starts, ends };
  }

  /** End of the run of plain characters (no whitespace, separator, quote or backslash) at `i` (bug r28: sliced, not copied one by one). */
  private static plainEnd(text: string, i: number, until: number): number {
    let j = i;
    while (j < until && !PLAIN_STOP.has(text.charCodeAt(j))) j++;
    return j;
  }

  /**
   * End of the balanced group that opens at `start` (`@(`, `(`, `[`, `{`; bug r32): after its
   * closer, quotes skipped and escapes (`\`, `` ` ``) honoured; an unclosed group ends at its line end.
   */
  static balancedEnd(text: string, start: number): number {
    const close = ShellWords.closersOf(text).get(text[start] === "@" ? start + 1 : start);
    if (close !== undefined) return close;
    const nl = text.indexOf("\n", start);
    return nl < 0 ? text.length : nl;
  }

  /** The end of the shell word that starts at `start` (a balanced group followed by more text is one word, bug r33). */
  static wordEnd(text: string, start: number): number {
    return ShellWords.word(text, start, text.length, false).end;
  }

  /**
   * The closer of every bracket group of `text`, by opener offset, in ONE pass with a stack
   * (bug r33: linear; an unclosed group never makes the scan restart). Inside a group quotes are
   * skipped; `\` and backtick escape. The last text's result is cached.
   */
  private static closersOf(text: string): Map<number, number> {
    if (text === ShellWords.closersText) return ShellWords.closers;
    const closers = new Map<number, number>();
    const stack: number[] = [];
    for (let i = 0; i < text.length; i++) {
      const c = text[i] ?? "";
      if (EscapeDialect.isEscape(c)) i++;
      else if (stack.length > 0 && (c === '"' || c === "'")) i = ShellWords.quoteEnd(text, i);
      else if (c === "(" || c === "[" || c === "{") stack.push(i);
      else if ((c === ")" || c === "]" || c === "}") && stack.length > 0) closers.set(stack.pop() as number, i + 1);
    }
    ShellWords.closersText = text;
    ShellWords.closers = closers;
    return closers;
  }

  /** Offset of the quote that closes the one at `i` (`\` and backtick escape inside double quotes, bug r33); the text end when unclosed. */
  private static quoteEnd(text: string, i: number): number {
    const q = text[i];
    for (let j = i + 1; j < text.length; j++) {
      if (EscapeDialect.escapesIn(q) && EscapeDialect.isEscape(text[j])) j++;
      else if (text[j] === q) return j;
    }
    return text.length;
  }

  /** The word that starts at `start` (it ends at whitespace or an unquoted separator). */
  private static word(text: string, start: number, until: number, first: boolean): ShellWord {
    let value = "";
    let i = start;
    while (i < until && !" \t\r\n;&|".includes(text[i] ?? "")) {
      const c = text[i] ?? "";
      const plain = ShellWords.plainEnd(text, i, until);
      const cont = EscapeDialect.continuation(text, i);
      if (plain > i) {
        value += text.slice(i, plain);
        i = plain;
      } else if (cont > 0) i += cont;
      // `\` (POSIX) and backtick (PowerShell, bug r34) escape the next character, a space or separator too.
      else if (EscapeDialect.isEscape(c)) {
        value += text[i + 1] ?? "";
        i += 2;
      } else if (c === "'") {
        const close = text.indexOf("'", i + 1);
        const end = close < 0 || close >= until ? until : close;
        value += text.slice(i + 1, end);
        i = end + 1;
      } else if (c === '"') {
        // `\` (POSIX) and backtick (PowerShell, bug r33) escape inside double quotes: `"` does not close the string.
        for (i++; i < until && text[i] !== '"'; i++) value += EscapeDialect.isEscape(text[i]) && i + 1 < until ? (text[++i] ?? "") : text[i];
        i++;
      } else {
        value += c;
        i++;
      }
    }
    return { start, end: Math.min(i, until), text: value, first };
  }
}
