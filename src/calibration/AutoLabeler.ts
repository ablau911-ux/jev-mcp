import { createHash } from "node:crypto";
import type { Hunk } from "../refs/DiffSource.js";
import type { DecisionLog, DecisionRecord } from "./DecisionLog.js";

type ProxySource = "hunk_edit" | "file_open" | "rerun";

export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Labels past decisions from ground truth that arrives later:
 * - hunk edits: a flagged hunk that is gone from a later, CHANGED `$diff` of the same scope
 *   (worktree, staged, ref) was acted on (label true), also when its whole file left that diff; one still present unchanged
 *   was kept (label false). A re-expansion of an unchanged diff (a dry-run validate, a rerun)
 *   and a diff of another scope are no evidence and label nothing (break hunt);
 * - file opens: a reranked file later read through `$file` was useful (label true);
 * - reruns: a batch item re-judged with `only_ids` that flips its verdict labels the first
 *   verdict wrong (false); an unchanged verdict labels it right (true).
 * Each decision is labelled at most once per source, across sessions, and never once the agent
 * labelled it: a proxy label must not replace the agent's ground truth.
 */
export class AutoLabeler {
  /** Hunk hashes per file of the previous diff of each scope: the baseline a later diff is compared to. */
  private readonly lastDiff = new Map<string, Map<string, Set<string>>>();

  constructor(private readonly log: DecisionLog) {}

  onDiff(hunks: Hunk[], scope = "worktree"): number {
    const files = new Map<string, Set<string>>();
    for (const h of hunks) {
      const set = files.get(h.file) ?? new Set<string>();
      set.add(textHash(h.text));
      files.set(h.file, set);
    }
    const before = this.lastDiff.get(scope);
    this.lastDiff.set(scope, files);
    if (!before || AutoLabeler.sameDiff(before, files)) return 0;
    let n = 0;
    for (const d of this.open("hunk", "hunk_edit")) {
      const key = d.subject?.key ?? "";
      const hash = d.subject?.hash ?? "";
      // Only a hunk of THIS scope's previous diff: absence from another scope proves nothing.
      if (d.verdict !== "yes" || !before.get(key)?.has(hash)) continue;
      // A file gone from the changed diff of the same scope has no hunks left: its flagged hunk was acted on.
      n += this.label(d, !(files.get(key)?.has(hash) ?? false), "hunk_edit");
    }
    return n;
  }

  private static sameDiff(a: Map<string, Set<string>>, b: Map<string, Set<string>>): boolean {
    if (a.size !== b.size) return false;
    for (const [file, set] of a) {
      const other = b.get(file);
      if (!other || other.size !== set.size || [...set].some((h) => !other.has(h))) return false;
    }
    return true;
  }

  onFileRead(path: string): number {
    let n = 0;
    for (const d of this.open("file", "file_open")) if (d.subject?.key === path && d.verdict === "yes") n += this.label(d, true, "file_open");
    return n;
  }

  /**
   * `verdicts` maps question name to the new verdict; decision ids are `<call id>.<question>`.
   * `hash` is the item's content hash (BatchShaper.itemHash): an unrelated batch that reused
   * the item id judged other content, so its decisions are not labelled.
   */
  onRerun(itemId: string, verdicts: Record<string, string | null>, hash?: string, open: DecisionRecord[] = this.open("item", "rerun")): number {
    let n = 0;
    for (const d of open) {
      if (d.subject?.key !== itemId || d.subject.hash !== hash) continue;
      // The call id has no '.', a question name may ('x.b'): cut at the first dot, not the last.
      const q = d.id.slice(d.id.indexOf(".") + 1);
      if (Object.hasOwn(verdicts, q)) n += this.label(d, d.verdict === verdicts[q], "rerun");
    }
    return n;
  }

  /** Every rerun of one batch against ONE read of the log (break hunt 1: it was read once per item). */
  onReruns(reruns: ReadonlyArray<readonly [string, Record<string, string | null>, string?]>): number {
    if (reruns.length === 0) return 0;
    const open = this.open("item", "rerun");
    return reruns.reduce((n, [itemId, verdicts, hash]) => n + this.onRerun(itemId, verdicts, hash, open), 0);
  }

  /** Decisions of this kind that neither this source nor the agent has labelled yet. */
  private open(kind: "hunk" | "file" | "item", source: ProxySource): DecisionRecord[] {
    const labelled = this.log.labelledBy(source, "agent");
    return this.log.decisions().filter((d) => d.subject?.kind === kind && !labelled.has(d.id));
  }

  private label(d: DecisionRecord, label: boolean, source: ProxySource): number {
    this.log.append({ type: "label", id: d.id, ts: new Date().toISOString(), label, source });
    return 1;
  }
}
