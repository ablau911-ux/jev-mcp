
/** Returns a secret kind for decoded text, or null. */
export type Detect = (decoded: string) => string | null;

interface Decoder {
  /** Suffix of the mask kind, e.g. `live_credential_hex`. */
  name: string;
  /** Candidate runs are maximal runs of these characters (found by a plain loop: linear, no regex stack). */
  chars: Uint8Array;
  /** A run continues across a line break (`\n`, `\r\n`) and the next line's indentation when that line goes on with the run (wrapped base64 / hex, bug r23 / r24). */
  wraps?: boolean;
  /** Shortest run worth decoding. */
  min: number;
  /** Decoded characters this run will produce, computed from the encoded run alone (before any decoding). */
  cost(span: string): number;
  /** Calls `visit` with each decoded form (chunk by chunk); stops and returns true when `visit` does. */
  forms(span: string, visit: (form: string) => boolean): boolean;
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** A lookup table of ASCII run characters (bug r28: a typed-array read per character, not a Set lookup). */
const charSet = (chars: string): Uint8Array => {
  const table = new Uint8Array(128);
  for (const c of chars) table[c.charCodeAt(0)] = 1;
  return table;
};

/** Decoded characters allowed per scanned character (all decoders, alignments and the nested level together). */
const BUDGET_PER_CHAR = 4;
/** Shortest base64 / hex run decoded, as found in the text (bug r36/r37: one decode path for every length). */
const ENCODED_MIN = 8;
/** Base64 characters of one decoded quantum: an alignment is decoded while its unpadded body still holds one. */
const QUANTUM = 4;
/** Shortest base64 run looked at: its unpadded body fills ENCODED_MIN once rounded up to quanta (5 characters). */
const BASE64_MIN_RUN = ENCODED_MIN - QUANTUM + 1;
/** Decode work always allowed, so short strings are scanned in full. */
const BUDGET_FLOOR = 65_536;
/** Encoded characters decoded per step (a multiple of 4, so base64 alignment is kept). */
const CHUNK = 256 * 1024;
/** Encoded characters shared by neighbouring chunks, so a secret across a chunk border is still seen whole. */
const OVERLAP = 8 * 1024;
const STEP = CHUNK - OVERLAP;
/**
 * The one decode buffer: decoded bytes never get their own allocation, so memory
 * stays flat whatever the input size. Safe because the scan is synchronous and every chunk
 * is turned into a string before anything else (a nested scan) writes here.
 */
const SCRATCH = Buffer.alloc(CHUNK);

/** Most characters of encoded runs a RunCache keeps (memory stays bounded; it is cleared when full). */
const CACHE_CHARS = 16 * 1024 * 1024;

/**
 * Results of decoded runs (bug r22b): each encoded run is decoded once; every later pass and
 * sink that meets the same run (the per-string scan, the residue scan, the serialized-payload
 * scan, the disk / MCP / log pipeline) reuses the result instead of decoding again.
 */
export class RunCache {
  private readonly runs = new Map<string, string | null>();
  private chars = 0;

  get(key: string): string | null | undefined {
    return this.runs.get(key);
  }

  set(key: string, kind: string | null): void {
    if (this.chars + key.length > CACHE_CHARS) this.clear();
    this.runs.set(key, kind);
    this.chars += key.length;
  }

  clear(): void {
    this.runs.clear();
    this.chars = 0;
  }
}

/** Remaining decode work for one scan; charged BEFORE anything is decoded. */
class ScanBudget {
  constructor(private left: number) {}

  /** Charges `n`; false (nothing charged) when the budget cannot cover it. */
  take(n: number): boolean {
    if (n > this.left) return false;
    this.left -= n;
    return true;
  }
}

/**
 * The normalisation layer of the secret guard. Each string is also read
 * in decoded forms: base64 (any length, four alignments), hex (upper or lower case, two
 * alignments), percent-encoding and `\uXXXX` / `\xXX` escapes, plus ONE nested level of the
 * same encodings (base64 of percent, percent of percent, hex of base64). When `detect` flags
 * a decoded form, the ORIGINAL encoded run is replaced. Runs of one decoder never overlap;
 * the decoded size of each run is computed from its length and charged to a budget
 * proportional to the text BEFORE decoding, and decoding goes chunk by chunk through one
 * shared buffer. A run that would need more work than is left is not decoded (bug r15: a
 * large hex dump is skipped, never refused); refusal stays for registered live secrets.
 */
export class EncodedScanner {
  private static readonly decoders: Decoder[] = [
    { name: "base64", chars: charSet(`${ALNUM}+/_-=`), min: BASE64_MIN_RUN, wraps: true, cost: (s) => EncodedScanner.base64Cost(s), forms: (s, v) => EncodedScanner.base64(s, v) },
    { name: "hex", chars: charSet("0123456789ABCDEFabcdef"), min: ENCODED_MIN, wraps: true, cost: (s) => EncodedScanner.hexCost(s), forms: (s, v) => EncodedScanner.hex(s, v) },
    { name: "percent", chars: charSet(`${ALNUM}._~+%-`), min: 6, cost: (s) => (s.includes("%") ? s.length : 0), forms: (s, v) => EncodedScanner.percent(s, v) },
    { name: "escaped", chars: charSet(`${ALNUM}._~+/=\\-`), min: 6, cost: (s) => (s.includes("\\") ? s.length : 0), forms: (s, v) => EncodedScanner.unescape(s, v) },
  ];

  /** Replaces every encoded run whose decoded form `detect` flags with `mask(<kind>_<encoding>)`. */
  static replace(text: string, detect: Detect, mask: (kind: string) => string, cache?: RunCache): string {
    if (text.length < BASE64_MIN_RUN) return text;
    return EncodedScanner.scan(text, detect, mask, new ScanBudget(BUDGET_FLOOR + BUDGET_PER_CHAR * text.length), 1, cache);
  }

  /** Kinds found in encoded runs of `text` (no replacement). */
  static find(text: string, detect: Detect, cache?: RunCache): string[] {
    const kinds: string[] = [];
    EncodedScanner.replace(
      text,
      detect,
      (kind) => {
        kinds.push(kind);
        return "";
      },
      cache,
    );
    return kinds;
  }

  /** One pass per decoder over the runs of `text`; a run already in `cache` is not decoded again (nor charged). */
  private static scan(text: string, detect: Detect, mask: (kind: string) => string, budget: ScanBudget, depth: number, cache?: RunCache): string {
    let out = text;
    for (const d of EncodedScanner.decoders) {
      out = EncodedScanner.mapRuns(out, d, (span) => {
        // A wrapped run is decoded once, as one run without its line breaks.
        const run = d.wraps ? span.replace(/\r?\n[ \t]*/g, "") : span;
        // A run its decoder cannot decode (percent without `%`, escapes without `\`, base64 under ENCODED_MIN
        // once its padding is gone) costs nothing to skip (bug r28/r37).
        if (d.cost(span) === 0) return span;
        const key = `${d.name}:${span}`;
        const known = cache?.get(key);
        const kind = known !== undefined ? known : EncodedScanner.kindOf(d, run, detect, budget, depth);
        if (known === undefined && kind !== undefined) cache?.set(key, kind);
        return kind === null || kind === undefined ? span : mask(`${kind}_${d.name}`);
      });
    }
    return out;
  }

  /** The kind hidden in one run, null for none, undefined when the budget cannot cover it (not decoded, not cached). */
  private static kindOf(d: Decoder, span: string, detect: Detect, budget: ScanBudget, depth: number): string | null | undefined {
    if (!budget.take(d.cost(span))) return undefined;
    let kind: string | null = null;
    d.forms(span, (form) => {
      kind = detect(form) ?? (depth > 0 ? EncodedScanner.nested(form, detect, budget, depth - 1) : null);
      return kind !== null;
    });
    return kind;
  }

  /** The plain kind hidden one encoding deeper in a decoded form, or null. */
  private static nested(form: string, detect: Detect, budget: ScanBudget, depth: number): string | null {
    if (form.length < BASE64_MIN_RUN) return null;
    let found: string | null = null;
    const inner: Detect = (decoded) => {
      const kind = detect(decoded);
      if (kind !== null) found ??= kind;
      return kind;
    };
    EncodedScanner.scan(form, inner, () => "", budget, depth);
    return found;
  }

  /** `text` with every maximal run of `d.chars` (at least `d.min` long) passed through `fn`. */
  private static mapRuns(text: string, d: Decoder, fn: (span: string) => string): string {
    const parts: string[] = [];
    let last = 0;
    let i = 0;
    while (i < text.length) {
      if (d.chars[text.charCodeAt(i)] !== 1) {
        i++;
        continue;
      }
      const start = i;
      while (i < text.length) {
        if (d.chars[text.charCodeAt(i)] === 1) {
          i++;
          continue;
        }
        const next = d.wraps ? EncodedScanner.wrapEnd(text, i, d) : i;
        if (next === i) break;
        i = next;
      }
      if (i - start < d.min) continue;
      const span = text.slice(start, i);
      const replaced = fn(span);
      if (replaced === span) continue;
      parts.push(text.slice(last, start), replaced);
      last = i;
    }
    if (last === 0) return text;
    parts.push(text.slice(last));
    return parts.join("");
  }

  /** Characters decoded when `length` encoded characters are read in overlapping chunks. */
  private static chunked(length: number): number {
    if (length <= 0) return 0;
    const chunks = length <= CHUNK ? 1 : 1 + Math.ceil((length - CHUNK) / STEP);
    return length + (chunks - 1) * OVERLAP;
  }

  /** After a line break at `i` (`\n` or `\r\n`) and the next line's indentation, when that line goes on with the run: where it goes on; else `i`. */
  private static wrapEnd(text: string, i: number, d: Decoder): number {
    let next = text[i] === "\r" && text[i + 1] === "\n" ? i + 2 : text[i] === "\n" ? i + 1 : i;
    if (next === i) return i;
    while (text[next] === " " || text[next] === "\t") next++;
    return d.chars[text.charCodeAt(next)] === 1 ? next : i;
  }

  private static base64Std(token: string): string {
    return token.includes("=") ? token.replace(/=/g, "") : token;
  }

  private static base64Cost(token: string): number {
    const len = EncodedScanner.base64Std(token).length;
    // The minimum is measured on the unpadded body rounded up to whole quanta, so a run with and without its `=` padding counts alike (bug r37).
    if (Math.ceil(len / QUANTUM) * QUANTUM < ENCODED_MIN) return 0;
    let cost = 0;
    for (let o = 0; o < 4 && len - o >= QUANTUM; o++) cost += Math.ceil((EncodedScanner.chunked(len - o) * 3) / 4);
    return cost;
  }

  /** Mostly printable text of a base64 run (URL-safe too), at each of its four alignments. */
  static base64(token: string, visit: (form: string) => boolean): boolean {
    const std = EncodedScanner.base64Std(token);
    for (let o = 0; o < 4 && std.length - o >= QUANTUM; o++) {
      if (EncodedScanner.chunks(std, o, (piece) => EncodedScanner.decode(piece, "base64", true), visit)) return true;
    }
    return false;
  }

  private static hexCost(run: string): number {
    const second = run.length > 16 ? EncodedScanner.chunked(run.length - 1) : 0;
    return Math.ceil((EncodedScanner.chunked(run.length) + second) / 2);
  }

  private static hex(run: string, visit: (form: string) => boolean): boolean {
    const decode = (piece: string) => EncodedScanner.decode(piece.slice(0, piece.length - (piece.length % 2)), "hex", false);
    if (EncodedScanner.chunks(run, 0, decode, visit)) return true;
    return run.length > 16 && EncodedScanner.chunks(run, 1, decode, visit);
  }

  /** Decodes `s` from `offset` in overlapping chunks; stops when `visit` returns true. */
  private static chunks(s: string, offset: number, decode: (piece: string) => string | null, visit: (form: string) => boolean): boolean {
    for (let start = offset; start < s.length; start += STEP) {
      const form = decode(s.slice(start, start + CHUNK));
      if (form !== null && visit(form)) return true;
      if (start + CHUNK >= s.length) break;
    }
    return false;
  }

  /** Decodes into the shared buffer; base64 forms must be mostly printable (else null). */
  private static decode(piece: string, encoding: "base64" | "hex", printableOnly: boolean): string | null {
    const n = SCRATCH.write(piece, 0, CHUNK, encoding);
    if (!printableOnly) return SCRATCH.toString("latin1", 0, n);
    return EncodedScanner.printable(n) ? SCRATCH.toString("utf8", 0, n) : null;
  }

  private static percent(run: string, visit: (form: string) => boolean): boolean {
    if (!run.includes("%")) return false;
    return visit(run.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))));
  }

  private static unescape(run: string, visit: (form: string) => boolean): boolean {
    if (!run.includes("\\")) return false;
    return visit(run.replace(/\\(?:u([0-9A-Fa-f]{4})|x([0-9A-Fa-f]{2}))/g, (_, u?: string, x?: string) => String.fromCharCode(parseInt(u ?? x ?? "0", 16))));
  }

  /** True when the first `n` decoded bytes are mostly printable. */
  private static printable(n: number): boolean {
    if (n < 4) return false;
    let printable = 0;
    for (let i = 0; i < n; i++) {
      const b = SCRATCH[i] as number;
      if ((b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d || b >= 0x80) printable++;
    }
    return printable / n >= 0.9;
  }

}
