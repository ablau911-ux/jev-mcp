import { EntryWalker } from "../core/EntryWalker.js";
import type { Entry } from "../core/types.js";

/**
 * The strings, keys and numbers of a tree joined in document order with a separator (finding 19:
 * a secret split between fields), with the field boundaries kept, so a scan can tell which
 * fields a match touches and mask ranges of the joined text back in the tree's leaves
 * (round 5: disk records and MCP results mask a keyed value split over items).
 */
export class JoinedText {
  readonly text: string;
  /** Offset in `text` where each part starts. */
  private readonly starts: number[] = [];

  constructor(
    readonly parts: readonly string[],
    readonly sep: string,
    /** Indexes of the parts that are object keys (when known). */
    private readonly keyParts: ReadonlySet<number> = new Set(),
  ) {
    let at = 0;
    for (const p of parts) {
      this.starts.push(at);
      at += p.length + sep.length;
    }
    this.text = parts.join(sep);
  }

  /** Every string, key and number of `value` in document order, with the indexes of the keys. */
  static partsWithKeys(value: Entry): { parts: string[]; keys: Set<number> } {
    const parts: string[] = [];
    const keys = new Set<number>();
    const walk = (v: unknown): void => {
      if (typeof v === "string") parts.push(v);
      else if (typeof v === "number") parts.push(String(v));
      else if (Array.isArray(v)) v.forEach(walk);
      else if (typeof v === "object" && v !== null) {
        for (const [k, child] of Object.entries(v)) {
          keys.add(parts.length);
          parts.push(k);
          walk(child);
        }
      }
    };
    walk(value);
    return { parts, keys };
  }

  /** End offset (in `text`) of the part that holds offset `pos`. */
  fieldEnd(pos: number): number {
    const i = this.partAt(pos);
    return (this.starts[i] ?? 0) + (this.parts[i]?.length ?? 0);
  }

  /** True when offset `pos` lies in a part that is an object key. */
  isKeyAt(pos: number): boolean {
    return this.keyParts.has(this.partAt(pos));
  }

  /** Start offset of the first object key after the part that holds `pos` (the text length when none). */
  nextKeyStart(pos: number): number {
    for (let i = this.partAt(pos) + 1; i < this.parts.length; i++) if (this.keyParts.has(i)) return this.starts[i] ?? this.text.length;
    return this.text.length;
  }

  /** Index of the part that holds offset `pos`. */
  private partAt(pos: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.starts[mid] ?? 0) <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Masks every leaf character of `value` that falls inside one of `ranges` of its joined text;
   * each masked run becomes `mask`. A masked number becomes the mask string.
   */
  static maskRanges(value: Entry, sep: string, ranges: (joined: JoinedText) => Array<[number, number]>, mask: string): Entry {
    const { parts, keys } = JoinedText.partsWithKeys(value);
    const joined = new JoinedText(parts, sep, keys);
    const hit = new Uint8Array(joined.text.length);
    let any = false;
    for (const [start, end] of ranges(joined)) {
      hit.fill(1, start, end);
      any = true;
    }
    if (!any) return value;
    const masked = joined.parts.map((p, i) => {
      const at = joined.starts[i] ?? 0;
      return JoinedText.replaceMarked(p, hit.subarray(at, at + p.length), mask);
    });
    let next = 0;
    return JoinedText.rebuild(value, () => masked[next++] ?? "");
  }

  /** `text` with every run of marked characters (`hit[i] === 1`) replaced by `mask`. */
  static replaceMarked(text: string, hit: Uint8Array, mask: string): string {
    const out: string[] = [];
    let i = 0;
    while (i < text.length) {
      const start = i;
      const masked = hit[i] === 1;
      while (i < text.length && (hit[i] === 1) === masked) i++;
      out.push(masked ? mask : text.slice(start, i));
    }
    return out.join("");
  }

  /** `key`, or `key#2`, `key#3`, ... when `out` already has it (bug r14: masked keys that collide stay distinct). */
  static uniqueKey(out: Record<string, unknown>, key: string): string {
    if (!Object.prototype.hasOwnProperty.call(out, key)) return key;
    let n = 2;
    while (Object.prototype.hasOwnProperty.call(out, `${key}#${n}`)) n++;
    return `${key}#${n}`;
  }

  /** Same walk order as EntryWalker.forEachStringOrKey; `next()` yields each leaf's new text. */
  private static rebuild(value: Entry, next: () => string): Entry {
    if (typeof value === "string") return next();
    if (typeof value === "number") {
      const text = next();
      return text === String(value) ? value : text;
    }
    if (Array.isArray(value)) return value.map((v) => JoinedText.rebuild(v, next));
    if (typeof value !== "object" || value === null) return value;
    const out: Record<string, Entry> = {};
    for (const v of Object.values(value)) {
      const key = JoinedText.uniqueKey(out, next());
      EntryWalker.setField(out, key, JoinedText.rebuild(v, next));
    }
    return out;
  }
}
