import type { BatchItem } from "../core/BatchRunner.js";
import { JevError } from "../core/JevError.js";
import type { Entry, ImageSpec, Questions } from "../core/types.js";
import type { RefResolver } from "../refs/RefResolver.js";
import { RefSyntax } from "../refs/RefSyntax.js";

/** The built items and the ONE original-id to item-id mapping (masked ids, `#2` suffixes) that `only_ids` resolves through (bug r25). */
export interface BuiltItems {
  items: BatchItem[];
  ids: Map<string, string>;
}

export interface RawItem {
  id: string;
  state: Entry;
  images?: Record<string, ImageSpec>;
  questions?: Questions;
}

/**
 * Builds jev_batch items: explicit `items`, or `items_from` refs so the
 * agent never pastes content. `"$diff"` / `"$diff:staged"` / `"$diff:<ref>"` gives one item
 * per hunk (`{file, hunk, diff}`); a list of `"$file:..."` refs gives one item per file
 * (`{path, text}`, expanded later by the request pipeline). Every id passes the secret guard;
 * two different ids that mask to the same text stay distinct (`#2`, `#3`, ...).
 */
export class BatchItemSource {
  constructor(
    private readonly refs: RefResolver,
    /** Secret guard for item ids: ids end up in rows, output files and logs. */
    private readonly scrubId: (id: string) => string = (id) => id,
  ) {}

  async build(items: RawItem[] | undefined, itemsFrom: string | string[] | undefined): Promise<BuiltItems> {
    return BatchItemSource.unique(await this.collect(items, itemsFrom), this.scrubId);
  }

  /**
   * Masked ids; when masking makes two ids equal, later ones get `#2`, `#3`... (true duplicates
   * stay duplicates). Returns the items and the original-to-final id mapping it assigned.
   */
  private static unique(items: BatchItem[], scrub: (id: string) => string): BuiltItems {
    const masked = items.map((i) => scrub(i.id));
    const taken = new Set(masked.filter((m, k) => m === items[k]?.id));
    const ids = new Map<string, string>();
    const out = items.map((item, k) => {
      const base = masked[k] ?? item.id;
      if (base === item.id) {
        ids.set(item.id, item.id);
        return item;
      }
      let id = ids.get(item.id) ?? base;
      for (let n = 2; !ids.has(item.id) && taken.has(id); n++) id = `${base}#${n}`;
      taken.add(id);
      ids.set(item.id, id);
      return { ...item, id };
    });
    return { items: out, ids };
  }

  private async collect(items: RawItem[] | undefined, itemsFrom: string | string[] | undefined): Promise<BatchItem[]> {
    if (items && itemsFrom) throw JevError.invalid("Give items or items_from, not both.", undefined, "Use items_from for $diff hunks or $file lists, items for your own states.");
    if (items) return items.map((i) => ({ ...i, subject: { kind: "item" as const, key: i.id } }));
    if (itemsFrom === undefined) throw JevError.invalid("items or items_from is required.", undefined, 'Example: items_from: "$diff:staged".');
    return Array.isArray(itemsFrom) ? this.files(itemsFrom) : this.diff(itemsFrom);
  }

  private async diff(ref: string): Promise<BatchItem[]> {
    const parsed = RefSyntax.parse(ref);
    if (parsed?.kind !== "diff") throw JevError.invalid(`items_from string must be a $diff ref, got ${ref}.`, undefined, 'Use "$diff", "$diff:staged", "$diff:HEAD" or a list of "$file:..." refs.');
    // DiffSource.hunks already refuses an empty diff.
    const hunks = await this.refs.hunks(parsed.target);
    return hunks.map((h) => ({ id: h.id, state: { file: h.file, hunk: h.header, diff: h.text }, subject: { kind: "hunk" as const, key: h.file, text: h.text } }));
  }

  private files(refs: string[]): BatchItem[] {
    return refs.map((ref) => {
      const parsed = RefSyntax.parse(ref);
      if (parsed?.kind !== "file" && parsed?.kind !== "log") throw JevError.invalid(`items_from list entries must be $file or $log refs, got ${ref}.`);
      const id = ref.replace(/^\$(file|log):/, "");
      // Subject kind "item", not "file": "file" is the rerank recipe's kind, and the file_open
      // auto-label would mark these verdicts correct on any later read of the path (break: file_open self-label).
      return { id, state: { path: parsed.path, text: ref }, subject: { kind: "item" as const, key: id } };
    });
  }
}
