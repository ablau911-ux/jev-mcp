import { createHash } from "node:crypto";
import type { Hunk } from "./DiffSource.js";

/**
 * Session-stable hunk ids (break hunt: `only_ids` judged a different hunk once the diff gained
 * a hunk above it). A hunk keeps its `<file>#<n>` id in every later diff while its file and text
 * are unchanged; a new or edited hunk gets the next unused number of its file, and numbers are
 * never reused, so a stale id matches nothing instead of another hunk. In a fresh session ids
 * are positional (`#1`, `#2`, ...). The newest `memory` contents are remembered.
 */
export class HunkIds {
  private readonly byContent = new Map<string, string>();
  private readonly last = new Map<string, number>();

  constructor(private readonly memory: number) {}

  assign(hunks: Hunk[]): Hunk[] {
    const occurrences = new Map<string, number>();
    return hunks.map((h) => {
      const digest = createHash("sha256").update(h.file).update("\0").update(h.text).digest("hex").slice(0, 32);
      const k = occurrences.get(digest) ?? 0;
      occurrences.set(digest, k + 1);
      const key = `${digest}:${k}`;
      const id = this.byContent.get(key) ?? this.next(h.file);
      this.remember(key, id);
      return { ...h, id };
    });
  }

  private next(file: string): string {
    const n = (this.last.get(file) ?? 0) + 1;
    this.last.set(file, n);
    return `${file}#${n}`;
  }

  private remember(key: string, id: string): void {
    this.byContent.delete(key);
    this.byContent.set(key, id);
    for (const old of this.byContent.keys()) {
      if (this.byContent.size <= this.memory) break;
      this.byContent.delete(old);
    }
  }
}
