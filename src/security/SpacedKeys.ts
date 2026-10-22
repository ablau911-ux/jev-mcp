import { MultilineLiterals } from "./MultilineLiterals.js";
import { ShellWords, type ShellWord } from "./ShellWords.js";
import { StrippedText } from "./StrippedText.js";

/**
 * A space-separated key and its value: the key word, and either the exact value word
 * (`valueEnd`, `text`) or only where the value starts (the value END is ValueSyntax.read).
 */
export interface SpacedKey {
  keyStart: number;
  keyEnd: number;
  valueStart: number;
  valueEnd?: number;
  text?: string;
}

/** An `Env:` / `$env:` prefix of a key name (PowerShell). */
const ENV_PREFIX_RE = /^(?:\$?env:)/i;
/** A CLI flag word: `--password`, `-password`, `--api-token`. */
const FLAG_WORD_RE = /^--?([A-Za-z][\w-]*)$/;
/** A line that may hold a CLI flag (a word that starts with a dash, quoted too: `"--password"`, bug r31). */
const FLAG_LINE_RE = /(?:^|[ \t])["']?-/;
/** An env-style key at the start of a line: ALL_CAPS or with an `Env:` / `$env:` prefix (`API_TOKEN value`). */
const ENV_LINE_RE = /^[ \t]*((?:\$?env:)[\w.-]+|[A-Z][A-Z0-9_]*)[ \t]+(?=[^\s=:])/dgim;
const CAPS_RE = /^[A-Z][A-Z0-9_]*$/;
/** How deep quoted command strings are re-scanned (`sh -c "bash -c '...'"`, bug r27). */
const MAX_NESTING = 3;
/** The PowerShell value parameter with an attached value (`-Value:x`, bug r32), lower case. */
const ATTACHED_VALUE = "-value:";
/** A value that opens a balanced group (`@(`, `(`, `[`, `{`) runs to its closer (bug r32). */
const BALANCED_RE = /^@?[([{]/;

/** Where offsets of a (decoded) re-scanned string lie in the source text (bug r28). */
interface SourceMap {
  start(i: number): number;
  end(e: number): number;
}
const IDENTITY: SourceMap = { start: (i) => i, end: (e) => e };

/**
 * Space-separated key/value pairs, recognised only in their own contexts (bug r22, Jev
 * decision), read as shell words (ShellWords, bug r26):
 * - a secret-like CLI flag (`--password`, `--api-token`): the next word is its value, whatever
 *   it is (`-x`, `--x`, quoted, escaped);
 * - a command word from config `secretGuard.commandWords`, in any case (`setx K v`,
 *   `Set-Item -Path Env:K -Value v`, `set -x K v`): the word after the secret-like key is the
 *   value; a Dockerfile instruction (the command word in upper case at the start of a line,
 *   `ENV K v`) takes the rest of the line (ValueSyntax.read, bug r20);
 * - an env-style key at the start of a line (ALL_CAPS, `Env:` / `$env:`): ValueSyntax.read.
 * PowerShell `-Value v` / `-Value:v` gives the value in any parameter order (bug r31/r32), and a
 * value that opens `@(`, `(`, `[` or `{` runs to its balanced closer (bug r32).
 * The text is read twice and the results unioned (bug r30): as it is, and with diff and comment
 * line prefixes stripped (StrippedText, shared with the YAML path; bug r29), offsets mapped back.
 * A quoted word is re-scanned as a nested command line (`sh -c "..."`, up to 3 levels), and
 * unquoted `;` `&&` `||` `|` `&` start a new command (ShellWords). Prose without such a context
 * (`the token is stored`, `the --debug flag`) matches none.
 */
export class SpacedKeys {
  private readonly commands: string[][];
  /** The command words by their first word (bug r28: one lookup per word, not one per command). */
  private readonly byFirst = new Map<string, string[][]>();
  private readonly commandLine: RegExp | null;

  constructor(
    commandWords: string[],
    private readonly isSecretKey: (name: string) => boolean,
  ) {
    this.commands = commandWords.map((w) => w.trim().toLowerCase().split(/\s+/)).filter((w) => w[0]);
    for (const c of this.commands) this.byFirst.set(c[0] ?? "", [...(this.byFirst.get(c[0] ?? "") ?? []), c]);
    const words = this.commands.map((w) => w.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[ \\t]+"));
    this.commandLine = words.length === 0 ? null : new RegExp(`(?:^|[\\s;&|(])(?:${words.join("|")})(?=[ \\t])`, "i");
  }

  /** Every space-separated key under a secret-like name in `text`, with its value, in key order. */
  find(text: string): SpacedKey[] {
    const out: SpacedKey[] = [];
    // The UNION of two readings (bug r30): the text as it is (a PowerShell `-Password` at a line start keeps
    // its dash), and with diff / comment prefixes stripped (bug r29: `+ curl --password \` / `+   value`).
    this.scanLines(text, IDENTITY, out);
    for (const view of StrippedText.prefixes(text)) this.scanLines(view.text, { start: (i) => view.toSource(i), end: (e) => (e === 0 ? view.toSource(0) : view.toSource(e - 1) + 1) }, out);
    for (const m of text.matchAll(ENV_LINE_RE)) {
      const [start, end] = m.indices?.[1] ?? [-1, -1];
      const name = m[1] ?? "";
      if ((ENV_PREFIX_RE.test(name) || CAPS_RE.test(name)) && this.isSecretKey(name.replace(ENV_PREFIX_RE, ""))) out.push({ keyStart: start, keyEnd: end, valueStart: m.index + m[0].length });
    }
    const seen = new Set<string>();
    return out
      .filter((k) => {
        const id = `${k.keyStart}:${k.valueStart}:${k.valueEnd ?? ""}`;
        return !seen.has(id) && seen.add(id) !== undefined;
      })
      .sort((a, b) => a.keyStart - b.keyStart);
  }

  /** The flag / command lines of `words` (a reading of the text), offsets mapped to the source by `map`. */
  private scanLines(words: string, map: SourceMap, out: SpacedKey[]): void {
    for (let at = 0; at < words.length; ) {
      const nl = words.indexOf("\n", at);
      const lineEnd = nl < 0 ? words.length : nl;
      const line = words.slice(at, lineEnd);
      if (FLAG_LINE_RE.test(line) || this.commandLine?.test(line)) {
        const parsed = ShellWords.line(words, at);
        this.walk(words, parsed.words, out, 0, map);
        at = Math.max(parsed.end, lineEnd) + 1;
      } else at = lineEnd + 1;
    }
  }

  /** The flags and command pairs of one logical line of `text`; `map` turns its offsets into source offsets. */
  private walk(text: string, words: ShellWord[], out: SpacedKey[], depth = 0, map: SourceMap = IDENTITY): void {
    for (const w of words) if (depth < MAX_NESTING) this.nested(text, w, out, depth + 1, map);
    for (let i = 0; i < words.length; i++) {
      const w = words[i] as ShellWord;
      // The DECODED word counts (bug r31: `"--password"`, `'--token'`, `--password` + backtick continuation).
      const flag = w.text.startsWith("-") ? FLAG_WORD_RE.exec(w.text) : null;
      const next = words[i + 1];
      if (flag && next && this.isSecretKey(flag[1] ?? "")) {
        out.push(SpacedKeys.pair(text, w, next, false, map));
        i++;
        continue;
      }
      const n = this.commandAt(words, i);
      if (n > 0) i = this.command(text, words, i, n, out, map);
    }
  }

  /**
   * A quoted word is re-scanned as a command line of its own (bug r27: `sh -c "client --password
   * X"`, `bash -lc '...'`), its words at their source spans; nesting stops at MAX_NESTING.
   */
  private nested(text: string, w: ShellWord, out: SpacedKey[], depth: number, map: SourceMap): void {
    const q = text[w.start];
    if ((q !== '"' && q !== "'") || w.end - w.start < 2 || text[w.end - 1] !== q) return;
    // A command line has at least two words: a string without whitespace or a separator holds none (bug r28: speed).
    if (!/[\s;&|]/.test(text.slice(w.start + 1, w.end - 1))) return;
    // The string is decoded as the shell reads it (bug r28: `\"`, `\\`, `\$`); its words map back to source spans.
    const d = ShellWords.unquote(text, w.start + 1, w.end - 1, q === '"');
    const inner: SourceMap = {
      start: (i) => map.start(d.starts[i] ?? w.end - 1),
      end: (e) => (e === 0 ? map.start(w.start + 1) : map.end(d.ends[e - 1] ?? w.end - 1)),
    };
    for (let at = 0; at < d.text.length; ) {
      const line = ShellWords.line(d.text, at);
      this.walk(d.text, line.words, out, depth, inner);
      at = line.end + 1;
    }
  }

  /** How many words the command word at `i` spans (`set -x` is two), or 0. */
  private commandAt(words: ShellWord[], i: number): number {
    for (const c of this.byFirst.get(words[i]?.text.toLowerCase() ?? "") ?? []) if (c.every((part, k) => words[i + k]?.text.toLowerCase() === part)) return c.length;
    return 0;
  }

  /** The `KEY value` after a command word (`-Path K -Value v` named style too); returns the last word used. */
  private command(text: string, words: ShellWord[], i: number, n: number, out: SpacedKey[], map: SourceMap): number {
    const byValue = this.namedValue(text, words, i + n, out, map);
    if (byValue >= 0) return byValue;
    let k = i + n;
    const named = words[k]?.text.startsWith("-") === true;
    if (named) k++;
    const key = words[k];
    let v = k + 1;
    if (named && words[v]?.text.startsWith("-") && words[v + 1]) v++;
    const value = words[v];
    if (!key || !value || !this.isSecretKey(key.text.replace(ENV_PREFIX_RE, ""))) return i + n - 1;
    const head = words[i] as ShellWord;
    const dockerfile = head.first && text.slice(head.start, head.end) === text.slice(head.start, head.end).toUpperCase();
    out.push(SpacedKeys.pair(text, key, value, dockerfile, map));
    return v;
  }

  /**
   * PowerShell named parameters (bug r31): in the command's words (up to the next command, or the
   * next command word: break hunt, a line of `env` words was rescanned to its end per word, which
   * was quadratic), the word after `-Value` is the value, in any parameter order; the key is the
   * command's secret-like non-parameter word (`Env:API_TOKEN`, `-Name token`). `-Value` itself
   * stays. Returns the last word used, or -1 when the command has no such pair.
   */
  private namedValue(text: string, words: ShellWord[], from: number, out: SpacedKey[], map: SourceMap): number {
    let end = from;
    while (end < words.length && (end === from || (!words[end]?.first && this.commandAt(words, end) === 0))) end++;
    const value = SpacedKeys.valueParam(text, words, from, end);
    if (!value) return -1;
    const key = words.slice(from, end).find((w) => w !== value && !w.text.startsWith("-") && this.isSecretKey(w.text.replace(ENV_PREFIX_RE, "")));
    if (!key) return -1;
    out.push(SpacedKeys.pair(text, key, value, false, map));
    return end - 1;
  }

  /** The value of `-Value v` (the next word) or `-Value:v` (bug r32: only the text after the colon), or undefined. */
  private static valueParam(text: string, words: ShellWord[], from: number, end: number): ShellWord | undefined {
    for (let j = from; j < end; j++) {
      const w = words[j] as ShellWord;
      const lower = w.text.toLowerCase();
      if (lower === "-value" && j + 1 < end) return words[j + 1];
      if (lower.startsWith(ATTACHED_VALUE) && lower.length > ATTACHED_VALUE.length) {
        const colon = text.indexOf(":", w.start);
        return { start: colon + 1, end: w.end, text: w.text.slice(ATTACHED_VALUE.length), first: false };
      }
    }
    return undefined;
  }

  /** The key word and its value word (exact span), or only the value start (`toLineEnd`: ValueSyntax.read decides the end). */
  private static pair(text: string, key: ShellWord, value: ShellWord, toLineEnd: boolean, map: SourceMap): SpacedKey {
    const base = { keyStart: map.start(key.start), keyEnd: map.end(key.end), valueStart: map.start(value.start) };
    if (toLineEnd) return base;
    // A value that opens `@(`, `(`, `[` or `{` runs to its balanced closer (bug r32: `@("a", "b")`, `["a", "b"]`).
    let end = BALANCED_RE.test(text.slice(value.start, value.start + 2)) ? Math.max(value.end, ShellWords.balancedEnd(text, value.start)) : value.end;
    // A group followed by more text without a space is one word (bug r33: `[string]"X"`, `[string]X`).
    if (end < text.length && !/[\s;&|]/.test(text[end] ?? " ")) end = ShellWords.wordEnd(text, end);
    // A value that opens a multi-line literal (e.g. `$(cat <<EOF … EOF)`) runs to its closer (bug r45).
    end = Math.max(end, MultilineLiterals.end(text, value.start));
    return { ...base, valueEnd: map.end(end), text: end === value.end ? value.text : text.slice(value.start, end) };
  }
}
