import { relative, isAbsolute } from "node:path";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { EntryWalker } from "../core/EntryWalker.js";
import { JevError } from "../core/JevError.js";
import type { Entry } from "../core/types.js";
import type { PathGuard } from "../files/PathGuard.js";
import { TextReader, type Reserve } from "../files/TextReader.js";
import type { DiffSource, Hunk } from "./DiffSource.js";
import type { LogTrimmer } from "./LogTrimmer.js";
import { RefRun, type RefMeta } from "./RefRun.js";
import { RefSyntax, type DiffTarget, type Ref } from "./RefSyntax.js";

export type { RefMeta } from "./RefRun.js";

interface LegacyFileRef {
  $file: string;
  start_line?: number;
  end_line?: number;
}

const LEGACY_KEYS = new Set(["$file", "start_line", "end_line"]);

function isLegacy(value: unknown): value is LegacyFileRef {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "$file");
}

/**
 * Expands input refs anywhere in state: `$file:path#L10-80`, `$diff[:...]`,
 * `$log:path[#N]`, and the legacy `{"$file": path, start_line, end_line}` object. Paths go
 * through PathGuard (roots + credential denylist after realpath, silent refusal); every
 * expanded text still passes the secret guard and validation afterwards. One request's refs
 * expand one at a time under a byte ceiling (`maxBytes`, the request body limit), and each
 * distinct `$diff` target runs git once (RefRun).
 */
export class RefResolver {
  /** Observers for auto-labels: files read and diffs expanded. */
  readonly onFileRead: Array<(path: string) => void> = [];
  /** `scope`: the diff target key (`worktree`, `staged`, `ref:<name>`; RefSyntax.diffKey). */
  readonly onDiff: Array<(hunks: Hunk[], scope: string) => void> = [];
  private readonly text: TextReader;

  constructor(
    private readonly guard: PathGuard,
    private readonly diff: DiffSource,
    private readonly logs: LogTrimmer,
    private readonly maxNesting: number = DEFAULT_CONFIG.limits.maxNesting,
    private readonly maxBytes: number = DEFAULT_CONFIG.limits.bodyBytes,
  ) {
    this.text = new TextReader(guard);
  }

  async resolve(value: Entry): Promise<Entry> {
    return (await this.resolveWithMeta(value)).value;
  }

  async resolveWithMeta(value: Entry): Promise<{ value: Entry; meta: RefMeta }> {
    RefResolver.checkDepth(value, this.maxNesting, "$.state");
    const run = new RefRun(this.maxBytes);
    return { value: await this.walk(value, run), meta: run.meta };
  }

  async readText(path: string): Promise<string> {
    return this.text.whole(path);
  }

  /** Hunks of a `$diff` ref, for jev_batch `items_from`. */
  async hunks(target: DiffTarget): Promise<Hunk[]> {
    const hunks = await this.diff.hunks(target, await this.guard.primaryRoot());
    for (const fn of this.onDiff) fn(hunks, RefSyntax.diffKey(target));
    return hunks;
  }

  /** Sequential on purpose: the byte ceiling refuses before the next read, not after all of them. */
  private async walk(value: Entry, run: RefRun): Promise<Entry> {
    if (typeof value === "string") {
      const ref = RefSyntax.parse(value);
      return ref ? this.expand(ref, run) : value;
    }
    if (isLegacy(value)) return this.expandLegacy(value, run);
    if (Array.isArray(value)) {
      const out: Entry[] = [];
      for (const v of value) out.push(await this.walk(v, run));
      return out;
    }
    if (typeof value === "object" && value !== null) {
      const out: Record<string, Entry> = {};
      for (const [k, v] of Object.entries(value)) EntryWalker.setField(out, k, await this.walk(v, run));
      return out;
    }
    return value;
  }

  private async expand(ref: Ref, run: RefRun): Promise<Entry> {
    run.meta.refs++;
    const reserve: Reserve = (n, path) => run.reserve(n, path);
    if (ref.kind === "diff") {
      const hunks = await run.hunks(ref.target, () => this.hunks(ref.target));
      run.reserve(hunks.reduce((a, h) => a + Buffer.byteLength(h.file) + Buffer.byteLength(h.header) + Buffer.byteLength(h.text), 0), "$diff");
      return hunks.map((h) => ({ file: h.file, hunk: h.header, diff: h.text }));
    }
    if (ref.kind === "log") {
      run.meta.untrusted = true;
      const n = ref.tail ?? this.logs.tailLines;
      const tail = await this.text.tail(ref.path, n, reserve);
      return this.logs.trim(tail.text, n, tail.skipped);
    }
    await this.markOutside(ref.path, run.meta);
    const text = ref.start === undefined ? await this.text.whole(ref.path, reserve) : await this.lines(ref.path, ref.start, ref.end ?? ref.start, reserve);
    for (const fn of this.onFileRead) fn(ref.path);
    return text;
  }

  private async expandLegacy(ref: LegacyFileRef, run: RefRun): Promise<Entry> {
    const extra = Object.keys(ref).filter((k) => !LEGACY_KEYS.has(k));
    if (extra.length > 0) throw JevError.invalid(`$file reference has unknown keys: ${extra.join(", ")}`);
    if (typeof ref.$file !== "string" || ref.$file.length === 0) throw JevError.invalid("$file must be a non-empty path.");
    if (ref.start_line === undefined && ref.end_line === undefined) return this.expand({ kind: "file", path: ref.$file }, run);
    run.meta.refs++;
    await this.markOutside(ref.$file, run.meta);
    return this.lines(ref.$file, ref.start_line ?? 1, ref.end_line ?? Number.MAX_SAFE_INTEGER, (n, path) => run.reserve(n, path));
  }

  /** Files outside the primary workspace root (other MCP roots) count as untrusted. */
  private async markOutside(path: string, meta: RefMeta): Promise<void> {
    const real = await this.guard.resolveInside(path);
    const rel = relative(await this.guard.primaryRoot(), real);
    if (rel.startsWith("..") || isAbsolute(rel)) meta.untrusted = true;
  }

  /** Lines `start`..`end` of a file of any size; a start past EOF is refused, never sent as empty text. */
  private lines(path: string, start: number, end: number, reserve: Reserve): Promise<string> {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      throw JevError.invalid(`$file ${path}: invalid line range ${start}-${end}.`);
    }
    return this.text.range(path, start, end, reserve);
  }

  /** Refuses a tree deeper than `max` BEFORE any recursive walk (no RangeError). */
  static checkDepth(value: unknown, max: number, where: string): void {
    if (EntryWalker.deeperThan(value, max)) {
      throw JevError.invalid(`${where}: nesting depth exceeds ${max}. Flatten deeper content.`, undefined, "Flatten the nested content; nothing was sent to the API.", where);
    }
  }

  /** True when the value contains at least one ref. */
  static contains(value: unknown): boolean {
    if (typeof value === "string") return RefSyntax.parse(value) !== null;
    if (isLegacy(value)) return true;
    if (Array.isArray(value)) return value.some((v) => RefResolver.contains(v));
    if (typeof value === "object" && value !== null) return Object.values(value).some((v) => RefResolver.contains(v));
    return false;
  }
}
