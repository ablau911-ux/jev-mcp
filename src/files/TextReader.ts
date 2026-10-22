import { JevError } from "../core/JevError.js";
import { LineIndex, type LineSpan } from "./LineIndex.js";
import type { PathGuard } from "./PathGuard.js";

/** Leading byte order mark (U+FEFF). */
const BOM_RE = new RegExp(`^${String.fromCharCode(0xfeff)}`);

/** Called with the byte size of a read BEFORE its bytes are read (a per-request ceiling may refuse it). */
export type Reserve = (bytes: number, path: string) => void;

/**
 * File text for refs, through PathGuard (roots + credential denylist): a whole file under the
 * per-file byte limit, or a line range / the tail of a file of ANY size, where only the needed
 * lines are read and the limit applies to them. Content must be UTF-8 text.
 */
export class TextReader {
  constructor(private readonly guard: PathGuard) {}

  async whole(path: string, reserve?: Reserve): Promise<string> {
    const { size } = await this.guard.stat(path);
    if (size <= this.guard.maxBytes) reserve?.(size, path);
    return TextReader.decode(await this.guard.readBytes(path), path);
  }

  /** Lines `start`..`end` (1-based, inclusive; an end past EOF is clamped), joined with `\n`. A start past EOF is refused. */
  async range(path: string, start: number, end: number, reserve?: Reserve): Promise<string> {
    const { real } = await this.guard.stat(path);
    const { span, lines } = await LineIndex.range(real, start, end);
    if (!span) throw JevError.invalid(`File ${path}: line range ${start}-${end} is beyond EOF (the file has ${lines} lines).`, undefined, `Use a range within lines 1-${lines}; nothing was sent.`);
    const bytes = await this.read(real, span, path, `Lines ${start}-${end} of ${path}`, reserve);
    return LineIndex.split(TextReader.decode(bytes, path)).join("\n");
  }

  /** The last `n` lines (fewer when they pass the byte limit) and how many earlier lines were left out. */
  async tail(path: string, n: number, reserve?: Reserve): Promise<{ text: string; skipped: number }> {
    const { real } = await this.guard.stat(path);
    const { span, skipped } = await LineIndex.tail(real, n, this.guard.maxBytes);
    if (!span) throw JevError.invalid(`File ${path}: its last line is larger than the limit of ${this.guard.maxBytes} bytes.`, undefined, "Pass a $file line range instead; nothing was sent.");
    return { text: TextReader.decode(await this.read(real, span, path, `The tail of ${path}`, reserve), path), skipped };
  }

  /**
   * UTF-8 text without a leading BOM; anything else is refused, never sent as garbage. NUL is
   * valid UTF-8, so binaries and BOM-less UTF-16 are caught by a NUL byte (the git rule).
   */
  static decode(bytes: Uint8Array, path: string): string {
    if (bytes.includes(0)) throw JevError.invalid(`File ${path} is binary or not UTF-8 text (it has NUL bytes).`, undefined, "Pass a UTF-8 text file; nothing was sent.");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(BOM_RE, "");
    } catch {
      throw JevError.invalid(`File ${path} is not valid UTF-8 text.`);
    }
  }

  private async read(real: string, span: LineSpan, path: string, what: string, reserve?: Reserve): Promise<Buffer> {
    const size = span.to - span.from;
    if (size > this.guard.maxBytes) throw JevError.invalid(`${what} is ${size} bytes; the limit is ${this.guard.maxBytes}.`, undefined, "Pass a narrower line range; nothing was sent.");
    reserve?.(size, path);
    return LineIndex.read(real, span);
  }
}
