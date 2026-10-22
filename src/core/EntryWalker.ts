import type { Entry, Questions } from "./types.js";

/** Pure helpers over JSON-like trees. Only `forEachStringOrKey` visits object keys and numbers as strings. */
export class EntryWalker {
  /**
   * Sets `out[key]` as an own field. A plain `out[key] = v` runs the prototype setter for a
   * `__proto__` key (an own key after JSON.parse) and the field is silently dropped (break hunt).
   */
  static setField(out: Record<string, unknown>, key: string, value: unknown): void {
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  }

  /** Returns a copy with every string value mapped through `fn`. */
  static mapStrings(value: Entry, fn: (s: string) => string): Entry {
    if (typeof value === "string") return fn(value);
    if (Array.isArray(value)) return value.map((v) => EntryWalker.mapStrings(v, fn));
    if (typeof value === "object" && value !== null) {
      const out: Record<string, Entry> = {};
      for (const [k, v] of Object.entries(value)) EntryWalker.setField(out, k, EntryWalker.mapStrings(v, fn));
      return out;
    }
    return value;
  }

  /** Calls `fn` for every string value. */
  static forEachString(value: unknown, fn: (s: string) => void): void {
    if (typeof value === "string") fn(value);
    else if (Array.isArray(value)) value.forEach((v) => EntryWalker.forEachString(v, fn));
    else if (typeof value === "object" && value !== null) {
      Object.values(value).forEach((v) => EntryWalker.forEachString(v, fn));
    }
  }

  /**
   * Calls `fn` for every string value, every object key AND every number as its text (secret
   * checks; bug r5: numeric fragments of a secret are joined and checked like strings).
   */
  static forEachStringOrKey(value: unknown, fn: (s: string) => void): void {
    if (typeof value === "string") fn(value);
    else if (typeof value === "number") fn(String(value));
    else if (Array.isArray(value)) value.forEach((v) => EntryWalker.forEachStringOrKey(v, fn));
    else if (typeof value === "object" && value !== null) {
      for (const [k, v] of Object.entries(value)) {
        fn(k);
        EntryWalker.forEachStringOrKey(v, fn);
      }
    }
  }

  /**
   * True when `value` nests deeper than `max` levels. Iterative with an early exit, so a
   * hostile 100k-level tree never overflows the stack.
   */
  static deeperThan(value: unknown, max: number): boolean {
    const stack: Array<[unknown, number]> = [[value, 0]];
    while (stack.length > 0) {
      const [v, d] = stack.pop() as [unknown, number];
      if (typeof v !== "object" || v === null) continue;
      if (d + 1 > max) return true;
      for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, d + 1]);
    }
    return false;
  }

  /** Nesting depth in objects/arrays: a scalar is 0, `{}` or `[]` is 1. */
  static depth(value: unknown): number {
    if (typeof value !== "object" || value === null) return 0;
    const children = Array.isArray(value) ? value : Object.values(value);
    let max = 0;
    for (const child of children) max = Math.max(max, EntryWalker.depth(child));
    return max + 1;
  }

  /** Path of the first non-finite number (NaN/Infinity), or null. */
  static findNonFinite(value: unknown, path = "$"): string | null {
    if (typeof value === "number") return Number.isFinite(value) ? null : path;
    if (typeof value === "bigint") return path;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const hit = EntryWalker.findNonFinite(value[i], `${path}[${i}]`);
        if (hit) return hit;
      }
    } else if (typeof value === "object" && value !== null) {
      for (const [k, v] of Object.entries(value)) {
        const hit = EntryWalker.findNonFinite(v, `${path}.${k}`);
        if (hit) return hit;
      }
    }
    return null;
  }

  /** Path of the first integer beyond Number.MAX_SAFE_INTEGER (big ids belong in strings), or null. */
  static findUnsafeInteger(value: unknown, path = "$"): string | null {
    if (typeof value === "number") return Number.isFinite(value) && Number.isInteger(value) && !Number.isSafeInteger(value) ? path : null;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const hit = EntryWalker.findUnsafeInteger(value[i], `${path}[${i}]`);
        if (hit) return hit;
      }
    } else if (typeof value === "object" && value !== null) {
      for (const [k, v] of Object.entries(value)) {
        const hit = EntryWalker.findUnsafeInteger(v, `${path}.${k}`);
        if (hit) return hit;
      }
    }
    return null;
  }

  /** Maps strings in state and in every question's instructions and criteria. */
  static mapRequestStrings(state: Entry, questions: Questions, fn: (s: string) => string): { state: Entry; questions: Questions } {
    const outQuestions: Questions = {};
    for (const [id, q] of Object.entries(questions)) {
      const copy = { ...q };
      if (q.instructions !== undefined) copy.instructions = EntryWalker.mapStrings(q.instructions, fn);
      if (q.criteria !== undefined) copy.criteria = EntryWalker.mapStrings(q.criteria, fn);
      outQuestions[id] = copy;
    }
    return { state: EntryWalker.mapStrings(state, fn), questions: outQuestions };
  }

  /** Canonical JSON with sorted object keys (stable cache keys). */
  static canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((v) => EntryWalker.canonical(v)).join(",")}]`;
    if (typeof value === "object" && value !== null) {
      const keys = Object.keys(value).sort();
      const parts = keys.map((k) => `${JSON.stringify(k)}:${EntryWalker.canonical((value as Record<string, unknown>)[k])}`);
      return `{${parts.join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
  }
}
