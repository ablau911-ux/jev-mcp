import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { DecisionRecord, LabelRecord, LogRecord } from "./DecisionLog.js";

/** Parsed log records with the lookups the callers need, built once per parse. */
export class LogIndex {
  readonly records: LogRecord[] = [];
  readonly decisions: DecisionRecord[] = [];
  private readonly byId = new Map<string, DecisionRecord>();
  private readonly sources = new Map<string, Set<LabelRecord["source"]>>();

  constructor(records: LogRecord[] = []) {
    for (const r of records) this.add(r);
  }

  add(r: LogRecord): void {
    this.records.push(r);
    if (r.type === "label") this.sources.set(r.id, (this.sources.get(r.id) ?? new Set()).add(r.source));
    if (r.type !== "decision") return;
    this.decisions.push(r);
    this.byId.set(r.id, r);
  }

  decision(id: string): DecisionRecord | undefined {
    return this.byId.get(id);
  }

  /** Adds to `out` every id labelled by one of `sources`. */
  labelledBy(sources: ReadonlyArray<LabelRecord["source"]>, out: Set<string>): Set<string> {
    for (const [id, has] of this.sources) if (sources.some((s) => has.has(s))) out.add(id);
    return out;
  }
}

/**
 * The JSONL file behind DecisionLog. Appends start on a fresh line even after a line cut
 * mid-write; a torn, foreign or non-record line is skipped on read, never the whole log. The
 * parse is reused until the file's size or mtime changes (another process wrote to it), and
 * this process's own appends extend it, so a call never re-reads the lifetime log.
 */
export class LogFile {
  private snapshot: { stamp: string; index: LogIndex } | null = null;
  /** Stamp right after this process's last append. */
  private written: string | null = null;

  constructor(private readonly path: string) {}

  index(): LogIndex {
    const stamp = LogFile.stamp(this.path);
    if (stamp !== null && this.snapshot?.stamp === stamp) return this.snapshot.index;
    const index = new LogIndex(LogFile.read(this.path));
    this.snapshot = stamp === null ? null : { stamp, index };
    return index;
  }

  /** Best effort, never fails a call over the log: false when the record did not reach the file. */
  append(record: LogRecord): boolean {
    try {
      const before = LogFile.stamp(this.path);
      if (before === null) mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      // Our own last append ended the file with a newline: read its tail only when someone else wrote since.
      const open = before !== null && before !== this.written && LogFile.endsOpen(this.path);
      appendFileSync(this.path, `${open ? "\n" : ""}${JSON.stringify(record)}\n`, { mode: 0o600 });
      this.written = LogFile.stamp(this.path);
      if (this.snapshot && before !== null && this.written !== null && this.snapshot.stamp === before) {
        this.snapshot.index.add(record);
        this.snapshot.stamp = this.written;
      } else this.snapshot = null;
      return true;
    } catch {
      return false;
    }
  }

  /** One record per line; a torn, foreign or non-record line is skipped, never the whole log. */
  static parse(text: string): LogRecord[] {
    const out: LogRecord[] = [];
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (LogFile.isRecord(value)) out.push(value);
      } catch {
        // A line cut mid-write (crash, full disk): skip it and keep the rest.
      }
    }
    return out;
  }

  private static isRecord(v: unknown): v is LogRecord {
    if (typeof v !== "object" || v === null) return false;
    const r = v as Record<string, unknown>;
    if (r.type === "decision") return typeof r.id === "string" && typeof r.preset === "string" && typeof r.metric === "string" && (r.p === null || typeof r.p === "number");
    if (r.type === "label") return typeof r.id === "string" && typeof r.label === "boolean";
    return r.type === "seed" && typeof r.commit === "string";
  }

  private static read(path: string): LogRecord[] {
    try {
      return LogFile.parse(readFileSync(path, "utf8"));
    } catch {
      return []; // No file yet, or unreadable.
    }
  }

  /** Size and mtime: changes whenever anyone writes the file. Null when there is no file. */
  private static stamp(path: string): string | null {
    try {
      const s = statSync(path);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return null;
    }
  }

  /** True when the file's last line was cut mid-write, so the next record must start a new line. */
  private static endsOpen(path: string): boolean {
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const { size } = fstatSync(fd);
      if (size === 0) return false;
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      return last[0] !== 0x0a;
    } catch {
      return false; // No file yet.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}
