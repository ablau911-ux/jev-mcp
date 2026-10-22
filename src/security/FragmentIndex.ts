/** Base of the 32-bit polynomial rolling hash (wraps mod 2^32 with Math.imul). */
const BASE = 257;
/** Bits of the hash used by the cheap pre-filter in front of the Map lookup. */
const FILTER_MASK = 0xffff;

interface WindowGroup {
  /** The window's content (a candidate is confirmed by an exact compare). */
  window: string;
  /** Start offsets (in the secret) of every window with this content. */
  starts: number[];
}

/**
 * Finds every place where a fixed-length window (k-gram) of one registered secret occurs in
 * a text, in ONE pass over the text (the split-secret scan must be linear). The
 * secret's windows are hashed once into a table; the text is read with a 32-bit rolling hash
 * (Math.imul, bug r28: a few integer steps per character), and a candidate window is
 * confirmed by an exact string compare, so a hash collision never counts as a match.
 */
export class FragmentIndex {
  private readonly table = new Map<number, WindowGroup[]>();
  private readonly filter = new Uint8Array(FILTER_MASK + 1);
  /** BASE^m mod 2^32: the weight of the character leaving the window. */
  private readonly powM: number;
  /** Number of distinct window contents in the secret. */
  readonly groups: number;

  constructor(
    readonly secret: string,
    /** Window length (the shortest fragment that counts). */
    readonly m: number,
  ) {
    let pow = 1;
    for (let i = 0; i < m; i++) pow = Math.imul(pow, BASE);
    this.powM = pow;
    const byWindow = new Map<string, WindowGroup>();
    this.roll(secret, (pos, h) => {
      const window = secret.slice(pos, pos + m);
      const known = byWindow.get(window);
      if (known) known.starts.push(pos);
      else {
        const group = { window, starts: [pos] };
        byWindow.set(window, group);
        this.table.set(h, [...(this.table.get(h) ?? []), group]);
        this.filter[h & FILTER_MASK] = 1;
      }
      return false;
    }, false);
    this.groups = byWindow.size;
  }

  /**
   * Calls `hit(pos, starts, group)` for every text offset `pos` whose window equals the
   * secret windows starting at `starts`. Return true from `hit` to stop the scan early.
   */
  scan(text: string, hit: (pos: number, starts: number[], group: WindowGroup) => boolean): void {
    this.roll(text, (pos, h) => {
      const group = this.table.get(h)?.find((g) => text.startsWith(g.window, pos));
      return group !== undefined && hit(pos, group.starts, group);
    }, true);
  }

  /** The rolling hash of every window of length m in `s`; `fn(start, hash)` per complete window (`filtered`: only past the pre-filter), true stops. */
  private roll(s: string, fn: (pos: number, h: number) => boolean, filtered: boolean): void {
    const m = this.m;
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (Math.imul(h, BASE) + s.charCodeAt(i)) | 0;
      if (i >= m) h = (h - Math.imul(s.charCodeAt(i - m), this.powM)) | 0;
      if (i >= m - 1 && (!filtered || this.filter[h & FILTER_MASK] !== 0) && fn(i + 1 - m, h)) return;
    }
  }
}

export type { WindowGroup };
