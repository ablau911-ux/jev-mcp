import { open } from "node:fs/promises";

/** Byte span `[from, to)` of whole lines in a file. */
export interface LineSpan {
  from: number;
  to: number;
}

const CR = 0x0d;
const LF = 0x0a;
const CHUNK_BYTES = 64 * 1024;

/**
 * Finds line boundaries by streaming a file in chunks, so a line range or the tail of a file
 * of ANY size is located without loading the file whole (break hunt: ranges and `$log` tails
 * of files over the byte limit). One rule everywhere: a line ends at `\r\n`, `\r` or `\n`, and
 * a final line break does not start an extra empty line.
 */
export class LineIndex {
  /** Splits text by the same rule (`""` has no lines). */
  static split(text: string): string[] {
    if (text === "") return [];
    const lines = text.split(/\r\n|\r|\n/);
    if (lines.at(-1) === "") lines.pop();
    return lines;
  }

  /** Span of lines `start`..`end` (1-based; an end past EOF is clamped); `span` is null when `start` is past EOF. */
  static async range(real: string, start: number, end: number): Promise<{ span: LineSpan | null; lines: number }> {
    let from = -1;
    let to = -1;
    const seen = await LineIndex.scan(real, (line, offset) => {
      if (line === start) from = offset;
      if (line <= end) return true;
      to = offset;
      return false;
    });
    if (from < 0) return { span: null, lines: seen.lines };
    return { span: { from, to: to < 0 ? seen.size : to }, lines: seen.lines };
  }

  /**
   * Span of the last `n` lines, dropping the oldest of them until the span fits `maxBytes`;
   * `skipped` counts every line before the span. `span` is null when the last line alone is
   * larger than `maxBytes`. Line starts are kept in a ring of at most `n` (and `maxBytes + 1`).
   */
  static async tail(real: string, n: number, maxBytes: number): Promise<{ span: LineSpan | null; skipped: number }> {
    const cap = Math.max(0, Math.min(n, maxBytes + 1));
    const ring: number[] = [];
    let head = 0;
    const seen = await LineIndex.scan(real, (_line, offset) => {
      if (cap === 0) return true;
      if (ring.length < cap) ring.push(offset);
      else {
        ring[head] = offset;
        head = (head + 1) % cap;
      }
      return true;
    });
    const starts = [...ring.slice(head), ...ring.slice(0, head)];
    const firstLine = seen.lines - starts.length + 1;
    const i = starts.findIndex((offset) => seen.size - offset <= maxBytes);
    if (i >= 0) return { span: { from: starts[i] as number, to: seen.size }, skipped: firstLine + i - 1 };
    return starts.length === 0 ? { span: { from: seen.size, to: seen.size }, skipped: seen.lines } : { span: null, skipped: seen.lines };
  }

  /** The bytes of a span. */
  static async read(real: string, span: LineSpan): Promise<Buffer> {
    const fh = await open(real, "r");
    try {
      const buf = Buffer.alloc(span.to - span.from);
      let got = 0;
      while (got < buf.length) {
        const { bytesRead } = await fh.read(buf, got, buf.length - got, span.from + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      return buf.subarray(0, got);
    } finally {
      await fh.close();
    }
  }

  /** Calls `onStart(line, offset)` at each line start (1-based) until it returns false; returns the lines seen and the bytes scanned. */
  private static async scan(real: string, onStart: (line: number, offset: number) => boolean): Promise<{ lines: number; size: number }> {
    const fh = await open(real, "r");
    try {
      const buf = Buffer.allocUnsafe(CHUNK_BYTES);
      let pos = 0;
      let line = 0;
      let atStart = true;
      let afterCR = false;
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, CHUNK_BYTES, pos);
        if (bytesRead === 0) return { lines: line, size: pos };
        for (let i = 0; i < bytesRead; i++) {
          const b = buf[i] as number;
          if (afterCR && b === LF) {
            afterCR = false;
            continue;
          }
          afterCR = false;
          if (atStart) {
            atStart = false;
            if (!onStart(++line, pos + i)) return { lines: line, size: pos + i };
          }
          if (b === LF) atStart = true;
          else if (b === CR) atStart = afterCR = true;
        }
        pos += bytesRead;
      }
    } finally {
      await fh.close();
    }
  }
}
