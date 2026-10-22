import { TextIndex } from "./TextIndex.js";

/** Where a closer was found: its start, and the offset just after it. */
interface Closer {
  index: number;
  end: number;
}

/** Finds the closer at or after `from` (the end of the opener `open`), or null when there is none. */
type CloserSearch = (text: string, from: number, open: RegExpExecArray) => Closer | null;

/** One kind of multi-line string literal: how it opens at the value start, and how its closer is found. */
interface LiteralKind {
  name: string;
  /** Sticky: matches at the value start (a heredoc opener may follow other text on the value's first line). */
  open: RegExp;
  close: CloserSearch;
  /** Only a literal whose closer is NOT on the opening line counts (a one-line backtick string is a plain quoted value). */
  multiLineOnly?: boolean;
}

/** The closer searches of the literal kinds. */
class Closers {
  /** The first match of global `re` at or after `from`. */
  static regex(re: RegExp): CloserSearch {
    return (text, from) => {
      re.lastIndex = from;
      const c = re.exec(text);
      return c ? { index: c.index, end: c.index + c[0].length } : null;
    };
  }

  /**
   * The first `quote` at or after `from` that an odd run of backslashes does not escape (`\"""`,
   * r45). indexOf, then one backward count per candidate: linear (break hunt: the former
   * variable-length lookbehind re-walked a backslash run at every position, quadratic).
   */
  static unescaped(quote: string): CloserSearch {
    return (text, from) => {
      for (let at = text.indexOf(quote, from); at >= 0; at = text.indexOf(quote, at + 1)) {
        let run = 0;
        while (at - run - 1 >= 0 && text.charCodeAt(at - run - 1) === 92) run++;
        if (run % 2 === 0) return { index: at, end: at + quote.length };
      }
      return null;
    };
  }

  /**
   * A heredoc closer: a line that is the delimiter alone (`<<-`: indent allowed), looked up in the
   * text's line index (break hunt: a regex scan per key to the end of the text was quadratic).
   */
  static heredoc(text: string, from: number, m: RegExpExecArray): Closer | null {
    const index = TextIndex.of(text);
    const at = index.closerLine(m[3] ?? "", m[1] === "-", from);
    if (at < 0) return null;
    const end = index.lineEnd(at);
    // The `\r` of a `\r\n` belongs to the closer, as the former `\r?$` regex read it.
    return { index: at, end: text.charCodeAt(end) === 13 && text.charCodeAt(end + 1) === 10 ? end + 1 : end };
  }
}

/** THE table of multi-line string literal kinds (bug r44). */
const KINDS: LiteralKind[] = [
  // A closer is three quotes NOT preceded by an odd run of backslashes (`\"""` is an escaped quote, r45).
  { name: "triple-double", open: /"""/y, close: Closers.unescaped('"""') },
  { name: "triple-single", open: /'''/y, close: Closers.unescaped("'''") },
  { name: "powershell-here-double", open: /@"[ \t]*(?=\r?\n)/y, close: Closers.regex(/^"@/gm) },
  { name: "powershell-here-single", open: /@'[ \t]*(?=\r?\n)/y, close: Closers.regex(/^'@/gm) },
  { name: "heredoc", open: /[^\n]*?<<(-?)[ \t]*(['"]?)([A-Za-z_]\w*)\2/y, close: Closers.heredoc },
  { name: "template", open: /`/y, close: Closers.regex(/(?<!\\)`/g), multiLineOnly: true },
];

/**
 * Multi-line string literals as ONE class (bug r44): TOML / Python `"""` and `'''`, PowerShell
 * here-strings `@"` / `@'` (closer at a line start), shell heredocs (`<<EOF`, `<<-EOF`,
 * `<<'EOF'`, `<<"EOF"`) and multi-line JS / TS template literals. A value that opens one runs to
 * its matching closer, across lines; an unterminated one runs to the end of the text. The text
 * after the closer stays. ValueSyntax.read asks here first; the value end stays its decision.
 */
export class MultilineLiterals {
  /** End (after the closer) of the multi-line literal that opens at `start`, or -1 when none opens there. */
  static end(text: string, start: number): number {
    const index = TextIndex.of(text);
    for (const kind of KINDS) {
      // The heredoc opener scans the rest of the line; skip it unless a `<<` is there (bug r45: linear).
      if (kind.name === "heredoc" && !index.hasHeredocMark(start, index.lineEnd(start))) continue;
      kind.open.lastIndex = start;
      const m = kind.open.exec(text);
      if (!m) continue;
      const c = kind.close(text, start + m[0].length, m);
      if (kind.name === "heredoc" && !MultilineLiterals.realHeredoc(m, c !== null)) continue;
      const end = c ? c.end : text.length;
      if (kind.multiLineOnly && !text.slice(start, end).includes("\n")) continue;
      return end;
    }
    return -1;
  }

  /**
   * A `<<` is a heredoc only outside quotes on its line, and only when its closer line exists or
   * the delimiter looks like one (`<<EOF`, `<<'x'`): `"doc <<EOF"` and the shift `a << b` are not (r45).
   * An unclosed `<<` glued to an operand on its left (`id<<SHIFT`, `f(x)<<N`) is a shift (break hunt).
   */
  private static realHeredoc(m: RegExpExecArray, closed: boolean): boolean {
    const before = m[0].slice(0, m[0].lastIndexOf("<<"));
    if (MultilineLiterals.openQuote(before)) return false;
    if (closed) return true;
    if (/[\w)\]]$/.test(before)) return false;
    const delimiter = m[0].slice(m[0].lastIndexOf("<<") + 2);
    return /^-?(['"]).+\1$/.test(delimiter) || /^-?[A-Z_][A-Z0-9_]*$/.test(delimiter);
  }

  /** True when `text` ends inside a shell quote: `'` inside `"…"` and `"` inside `'…'` do not count (`"it's"`). */
  private static openQuote(text: string): boolean {
    let quote = "";
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      if (c === "\\" && quote !== "'") i++;
      else if (quote === "" && (c === '"' || c === "'")) quote = c;
      else if (c === quote) quote = "";
    }
    return quote !== "";
  }
}
