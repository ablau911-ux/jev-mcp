import { execFile } from "node:child_process";
import { isAbsolute, posix } from "node:path";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { JevError } from "../core/JevError.js";
import { HunkIds } from "./HunkIds.js";
import type { DiffTarget } from "./RefSyntax.js";

export interface Hunk {
  /** `<file>#<n>`: the batch item id; stable across the session's diffs while the hunk is unchanged (HunkIds). */
  id: string;
  file: string;
  header: string;
  text: string;
  /** Every path of the file block (old and new names, renames, copies): a credential in any drops it. Defaults to `[file]`. */
  paths?: string[];
}

/** C escapes git uses in quoted paths (besides `\ooo` octal bytes). */
const QUOTE_ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };

export type GitRunner = (args: string[], cwd: string, timeoutMs: number) => Promise<string>;

/** Runs git read-only (no shell); the default GitRunner. */
export const execGit: GitRunner = (args, cwd, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/**
 * `$diff` source: runs `git diff` read-only in the workspace root and
 * splits the output per hunk, so each hunk can be judged alone (diff review recipe).
 * Hunks of credential files are dropped silently: a file block is dropped when ANY of its
 * paths is a credential (old or new name, `rename from/to`, `copy from/to`, `---`/`+++`).
 * Quoted git paths (octal-escaped UTF-8, `core.quotePath`) are unquoted first. Binary files
 * are skipped. Only the workspace is diffed (`--relative`), and a diff naming any path
 * outside it (absolute, or climbing out with `..`) is refused. The `a/` and `b/`
 * prefixes are forced (a user's `diff.noprefix` / `diff.mnemonicPrefix` would change them), and
 * a hunk's file comes from the unambiguous `---`/`+++` names, not the `diff --git` header.
 */
export class DiffSource {
  private readonly ids: HunkIds;

  constructor(
    private readonly isCredential: (path: string) => boolean,
    private readonly maxHunks: number,
    private readonly timeoutMs: number,
    private readonly git: GitRunner = execGit,
    idMemory: number = DEFAULT_CONFIG.refs.hunkIdMemory,
  ) {
    this.ids = new HunkIds(idMemory);
  }

  async hunks(target: DiffTarget, cwd: string): Promise<Hunk[]> {
    let out: string;
    try {
      out = await this.git(DiffSource.args(target), cwd, this.timeoutMs);
    } catch {
      throw JevError.invalid("$diff: git diff failed.", undefined, "Run inside a git work tree and check the ref name.");
    }
    const parsed = DiffSource.parse(out);
    if (parsed.some((h) => (h.paths ?? [h.file]).some((p) => DiffSource.escapes(p)))) {
      throw JevError.invalid("$diff: the diff names a file outside the allowed roots; refusing it.", undefined, "Diff only files inside the workspace, or pick another ref; nothing was sent.");
    }
    const hunks = parsed.filter((h) => !(h.paths ?? [h.file]).some((p) => this.isCredential(p)));
    // Break hunt: an empty diff is refused for jev_ask too, never sent as `[]`.
    if (hunks.length === 0) throw JevError.invalid("The diff is empty: it has no text hunks (binary and credential files are skipped).", undefined, "Nothing to review: stage changes or pick another ref; nothing was sent.");
    if (hunks.length > this.maxHunks) throw JevError.invalid(`$diff has ${hunks.length} hunks; the limit is ${this.maxHunks}.`, undefined, "Narrow the diff (a ref closer to HEAD, or stage fewer files).");
    return this.ids.assign(hunks);
  }

  static args(target: DiffTarget): string[] {
    const base = ["diff", "--no-color", "--no-ext-diff", "--unified=3", "--relative", "--src-prefix=a/", "--dst-prefix=b/"];
    if (target.mode === "staged") return [...base, "--cached"];
    if (target.mode === "ref") return [...base, target.ref, "--"];
    return [...base, "HEAD", "--"];
  }

  /** True when a diff path leaves the workspace: absolute, a drive letter, or `..` after normalising. */
  static escapes(path: string): boolean {
    const p = path.replace(/\\/g, "/");
    if (isAbsolute(p) || /^[A-Za-z]:/.test(p)) return true;
    const n = posix.normalize(p);
    return n === ".." || n.startsWith("../");
  }

  /** Splits unified diff text into hunks (pure; exposed for tests). */
  static parse(diff: string): Hunk[] {
    const hunks: Hunk[] = [];
    let file = "";
    let paths: string[] = [];
    let current: Hunk | null = null;
    let n = 0;
    for (const line of diff.split(/\r?\n/)) {
      if (line.startsWith("diff --git ")) {
        const [a, b] = DiffSource.headerPaths(line.slice("diff --git ".length));
        file = b;
        paths = a === b ? [b] : [a, b];
        n = 0;
        current = null;
        continue;
      }
      if (line.startsWith("@@")) {
        current = { id: `${file}#${++n}`, file, header: line, text: "", paths };
        hunks.push(current);
        continue;
      }
      if (!current) {
        const extra = DiffSource.metaPath(line);
        if (extra !== null) paths.push(extra);
        // `+++` names the file (`---` for a deletion, whose `+++` is /dev/null).
        if (extra !== null && (line.startsWith("--- ") || line.startsWith("+++ "))) file = extra;
      } else if (/^[ +\-\\]/.test(line)) current.text += (current.text ? "\n" : "") + line;
    }
    return hunks;
  }

  /** Old and new path of a `diff --git` header (quoted or plain), without the a/ and b/ prefixes. */
  static headerPaths(rest: string): [string, string] {
    if (rest.startsWith('"')) {
      const a = DiffSource.readQuoted(rest, 0);
      const tail = rest.slice(a.end).trimStart();
      const b = tail.startsWith('"') ? DiffSource.readQuoted(tail, 0).text : tail;
      return [DiffSource.strip(a.text, "a/"), DiffSource.strip(b, "b/")];
    }
    // Same name both sides ("a/P b/P"): split in the middle, even when P holds " b/".
    const mid = (rest.length - 1) / 2;
    if (rest[mid] === " " && rest.startsWith("a/") && rest.startsWith("b/", mid + 1) && rest.slice(2, mid) === rest.slice(mid + 3)) return [rest.slice(2, mid), rest.slice(mid + 3)];
    const at = rest.lastIndexOf(' "b/');
    if (rest.endsWith('"') && at >= 0) return [DiffSource.strip(rest.slice(0, at), "a/"), DiffSource.strip(DiffSource.readQuoted(rest, at + 1).text, "b/")];
    const m = /^a\/(.+) b\/(.+)$/.exec(rest);
    return m ? [m[1] ?? "", m[2] ?? ""] : [rest, rest];
  }

  /** Path named by an extended header line (rename/copy from/to, ---/+++), or null. */
  private static metaPath(line: string): string | null {
    const m = /^(?:rename from |rename to |copy from |copy to |--- |\+\+\+ )(.+)$/.exec(line);
    if (!m?.[1] || m[1] === "/dev/null") return null;
    // git ends an unquoted ---/+++ name holding a space with a TAB.
    const raw = m[1].startsWith('"') ? DiffSource.readQuoted(m[1], 0).text : m[1].replace(/\t$/, "");
    return line.startsWith("--- ") ? DiffSource.strip(raw, "a/") : DiffSource.strip(raw, "b/");
  }

  private static strip(path: string, prefix: string): string {
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  }

  /** Reads a git C-style quoted string starting at `start` (a `"`): simple escapes and `\ooo` octal bytes, decoded as UTF-8. */
  static readQuoted(s: string, start: number): { text: string; end: number } {
    const bytes: number[] = [];
    let i = start + 1;
    while (i < s.length && s[i] !== '"') {
      const c = s[i] as string;
      const oct = c === "\\" ? /^[0-7]{3}/.exec(s.slice(i + 1, i + 4)) : null;
      if (oct) {
        bytes.push(parseInt(oct[0], 8));
        i += 4;
      } else if (c === "\\" && i + 1 < s.length) {
        const next = s[i + 1] as string;
        bytes.push(QUOTE_ESCAPES[next] ?? next.charCodeAt(0));
        i += 2;
      } else {
        bytes.push(...Buffer.from(c, "utf8"));
        i++;
      }
    }
    return { text: Buffer.from(bytes).toString("utf8"), end: i + 1 };
  }
}
