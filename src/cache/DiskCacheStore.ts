import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ResponseParser } from "../core/ResponseParser.js";
import type { CacheEntry } from "./ResponseCache.js";

const PARSER = new ResponseParser();

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** What a disk entry must look like to be replayed as if the answer had just arrived. */
export class CacheEntryShape {
  /** The response must parse as a fresh one does and keep its usage numbers; ages must be numbers. */
  static replayable(v: unknown): v is CacheEntry {
    if (!isObj(v) || !finite(v.createdAt) || !finite(v.expiresAt) || !isObj(v.value)) return false;
    const { response, requestId } = v.value;
    if (requestId !== null && typeof requestId !== "string") return false;
    if (!isObj(response) || !isObj(response.usage) || !finite(response.usage.input_tokens) || !finite(response.usage.output_tokens) || !Array.isArray(response.warnings)) return false;
    try {
      return isObj(response.answers) && Object.keys(PARSER.parse(response, null).answers).length === Object.keys(response.answers).length;
    } catch {
      return false;
    }
  }

  /** The entry in a file's text, or null when it is not JSON or not replayable. */
  static parse(text: string): CacheEntry | null {
    try {
      const value: unknown = JSON.parse(text);
      return CacheEntryShape.replayable(value) ? value : null;
    } catch {
      return null;
    }
  }
}

/** `<namespace>_<64 hex hmac>.json`: the only files this store ever deletes. */
const ENTRY_FILE = /_[0-9a-f]{64}\.json$/;

/**
 * The opt-in disk half of ResponseCache (JEV_CACHE_DIR, checked by CacheDirPolicy): one JSON
 * file per key, at most `maxEntries` files (least recently used out first, like memory). The
 * first use sweeps the folder of expired and unreadable entries. An entry that cannot be
 * replayed exactly (wrong shape, an older format, a number the secret guard masked into a
 * string) is never written, and on read it is a miss and is deleted, so one bad file cannot
 * fail its request forever. Files another process writes meanwhile are counted at the next start.
 */
export class DiskCacheStore {
  /** Entry files of this folder, least recently used first; built by the first sweep. */
  private index: Set<string> | null = null;

  constructor(
    private readonly dir: string,
    private readonly maxEntries: number,
    private readonly expired: (e: CacheEntry) => boolean,
  ) {}

  read(key: string): CacheEntry | undefined {
    const files = this.files();
    const name = DiskCacheStore.fileName(key);
    const entry = this.load(name);
    if (entry === undefined) return undefined;
    if (entry === null || this.expired(entry)) {
      this.unlink(name);
      return undefined;
    }
    files.delete(name);
    files.add(name);
    return entry;
  }

  write(key: string, entry: CacheEntry): void {
    const files = this.files();
    const name = DiskCacheStore.fileName(key);
    if (!CacheEntryShape.replayable(entry)) return this.unlink(name);
    try {
      writeFileSync(join(this.dir, name), JSON.stringify(entry), { mode: 0o600 });
    } catch {
      return; // Disk cache is best effort.
    }
    files.delete(name);
    files.add(name);
    this.trim(files);
  }

  remove(key: string): void {
    this.unlink(DiskCacheStore.fileName(key));
  }

  /** Drops every file of keys starting with `prefix` (one model version). */
  purge(prefix: string): void {
    const stem = DiskCacheStore.fileName(prefix, "");
    for (const name of this.list()) if (name.startsWith(stem)) this.unlink(name);
  }

  private static fileName(key: string, ext = ".json"): string {
    return `${key.replace(/[^A-Za-z0-9.-]/g, "_")}${ext}`;
  }

  /** The live entry files, oldest first; the first call deletes expired and unreadable ones. */
  private files(): Set<string> {
    if (this.index) return this.index;
    const live: Array<[string, number]> = [];
    for (const name of this.list()) {
      const entry = this.load(name);
      if (entry && !this.expired(entry)) live.push([name, entry.createdAt]);
      else if (entry !== undefined) this.unlink(name);
    }
    this.index = new Set(live.sort((a, b) => a[1] - b[1]).map(([name]) => name));
    this.trim(this.index);
    return this.index;
  }

  private trim(files: Set<string>): void {
    for (const oldest of files) {
      if (files.size <= this.maxEntries) return;
      this.unlink(oldest);
    }
  }

  private list(): string[] {
    try {
      return readdirSync(this.dir).filter((f) => ENTRY_FILE.test(f));
    } catch {
      return [];
    }
  }

  /** undefined: no file; null: a file that is not a replayable entry. */
  private load(name: string): CacheEntry | null | undefined {
    let text: string;
    try {
      text = readFileSync(join(this.dir, name), "utf8");
    } catch {
      return undefined;
    }
    return CacheEntryShape.parse(text);
  }

  private unlink(name: string): void {
    this.index?.delete(name);
    try {
      rmSync(join(this.dir, name), { force: true });
    } catch {
      // Disk cache is best effort.
    }
  }
}
