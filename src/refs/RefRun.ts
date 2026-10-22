import { JevError } from "../core/JevError.js";
import type { Hunk } from "./DiffSource.js";
import { RefSyntax, type DiffTarget } from "./RefSyntax.js";

/** What the refs pulled in; drives the injection probe. */
export interface RefMeta {
  refs: number;
  /** Content from a log or from outside the workspace root (untrusted by default). */
  untrusted: boolean;
}

/**
 * One request's ref expansion (break hunt): a running byte total that refuses BEFORE a read
 * would pass the request body limit (no request can carry more), and one `git diff` per
 * distinct target however many `$diff` copies the state holds.
 */
export class RefRun {
  readonly meta: RefMeta = { refs: 0, untrusted: false };
  private bytes = 0;
  private readonly diffs = new Map<string, Promise<Hunk[]>>();

  constructor(private readonly maxBytes: number) {}

  /** Counts `n` bytes of expanded content; throws `too_large` past the limit. */
  reserve(n: number, what: string): void {
    this.bytes += n;
    if (this.bytes <= this.maxBytes) return;
    throw new JevError({ kind: "too_large", message: `Refs expand to more than ${this.maxBytes} bytes (the request body limit) at ${what}.`, fix: "Use line ranges, a $log tail or fewer refs, or split them into jev_batch items; nothing was sent.", loc: "$.state" });
  }

  /** Hunks of `target`, loaded once per request. */
  hunks(target: DiffTarget, load: () => Promise<Hunk[]>): Promise<Hunk[]> {
    const key = RefSyntax.diffKey(target);
    let hunks = this.diffs.get(key);
    if (!hunks) {
      hunks = load();
      this.diffs.set(key, hunks);
    }
    return hunks;
  }
}
