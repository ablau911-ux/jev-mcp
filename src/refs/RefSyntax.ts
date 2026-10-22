import { JevError } from "../core/JevError.js";

export type DiffTarget = { mode: "worktree" } | { mode: "staged" } | { mode: "ref"; ref: string };

export type Ref =
  | { kind: "file"; path: string; start?: number; end?: number }
  | { kind: "diff"; target: DiffTarget }
  | { kind: "log"; path: string; tail?: number };

const SAFE_REF = /^(?!-)[\w./~^@{}-]{1,100}$/;

/**
 * Input-ref strings. A string value that is exactly one ref is replaced
 * server-side, so the agent never pastes state:
 * - `$file:src/a.ts`, `$file:src/a.ts#L10-80`, `$file:src/a.ts#L42`
 * - `$diff` (uncommitted vs HEAD), `$diff:staged`, `$diff:HEAD`, `$diff:<git ref>`
 * - `$log:build.log`, `$log:build.log#500` (tail N lines, frames trimmed)
 * A one-line string that names a ref kind in another case or without a target (`$FILE:a.ts`,
 * `$diff:`) is refused, never sent as literal text (break hunt).
 */
export class RefSyntax {
  static parse(value: string): Ref | null {
    if (!value.startsWith("$")) return null;
    if (value === "$diff") return { kind: "diff", target: { mode: "worktree" } };
    const m = /^\$(file|diff|log):(.+)$/s.exec(value);
    if (!m) return RefSyntax.nearMiss(value);
    const [, kind, rest = ""] = m;
    if (kind === "diff") return { kind: "diff", target: RefSyntax.diffTarget(rest) };
    if (kind === "log") return RefSyntax.log(rest);
    return RefSyntax.file(rest);
  }

  private static nearMiss(value: string): null {
    if (/[\r\n]/.test(value) || !/^\$(file|diff|log)(:|$)/i.test(value)) return null;
    throw JevError.invalid(`${value.slice(0, 80)} looks like a ref but is not one: refs are lowercase and need a target.`, undefined, "Use $file:path[#L10-80], $diff, $diff:staged, $diff:<ref> or $log:path[#N]; nothing was sent.");
  }

  /** One key per diff scope: `worktree`, `staged` or `ref:<name>`. */
  static diffKey(target: DiffTarget): string {
    return target.mode === "ref" ? `ref:${target.ref}` : target.mode;
  }

  private static diffTarget(rest: string): DiffTarget {
    if (rest === "staged" || rest === "cached") return { mode: "staged" };
    if (rest === "worktree") return { mode: "worktree" };
    if (!SAFE_REF.test(rest)) throw JevError.invalid("$diff: invalid git ref.", undefined, "Use $diff, $diff:staged, $diff:HEAD or $diff:<branch|tag|sha>.");
    return { mode: "ref", ref: rest };
  }

  private static file(rest: string): Ref {
    const m = /^(.+?)#L(\d+)(?:-L?(\d+))?$/.exec(rest);
    if (!m) return { kind: "file", path: rest };
    const start = Number(m[2]);
    const end = m[3] === undefined ? start : Number(m[3]);
    if (start < 1 || end < start) throw JevError.invalid(`$file: invalid line range in ${rest}.`, undefined, "Use #L<start>-<end> with 1 <= start <= end.");
    return { kind: "file", path: m[1] ?? "", start, end };
  }

  private static log(rest: string): Ref {
    const m = /^(.+?)#(\d+)$/.exec(rest);
    return m ? { kind: "log", path: m[1] ?? "", tail: Number(m[2]) } : { kind: "log", path: rest };
  }
}
