import type { ParsedResponse } from "../core/types.js";
import { CacheKeyer, type CacheKeyParts } from "./CacheKeyer.js";
import { DiskCacheStore } from "./DiskCacheStore.js";

export interface CacheOptions {
  maxEntries: number;
  ttlMs: number;
  dir: string | null;
  secretPath: string | null;
  now?: () => number;
  /** Secret guard for values written to disk (OutboundSanitizer.scrubValue); identity when absent. */
  sanitize?: <T>(value: T) => T;
}

export interface CacheEntry {
  value: CachedValue;
  /** When it was stored, so a reader can apply its own, shorter ceiling (gate presets: 5 min). */
  createdAt: number;
  expiresAt: number;
}

export interface CachedValue {
  response: ParsedResponse;
  requestId: string | null;
  /** Client id of the call that stored it: a hit reuses it, so the result id names the logged decision. */
  clientId?: string;
}

/**
 * In-memory LRU plus an opt-in disk cache (JEV_CACHE_DIR, checked by CacheDirPolicy). Keys
 * are `<namespace>:<hmac>`, where the namespace is the pinned or resolved model version;
 * `purgeNamespace` drops a version's entries when its alias drifts. Every entry
 * expires (default 1 h; gate presets pass 5 min). Memory replays the answer as received; the
 * disk gets the secret-guarded copy.
 */
export class ResponseCache {
  private readonly map = new Map<string, CacheEntry>();
  private readonly keyer: CacheKeyer;
  private readonly disk: DiskCacheStore | null;
  hits = 0;

  constructor(private readonly options: CacheOptions) {
    this.keyer = new CacheKeyer(options.secretPath);
    this.disk = options.dir ? new DiskCacheStore(options.dir, options.maxEntries, (e) => this.expired(e)) : null;
  }

  key(parts: CacheKeyParts): string {
    return this.keyer.key(parts);
  }

  /** `maxAgeMs` is the caller's ceiling (a gate preset's 5 min); the entry's own TTL and cache.ttlMs always apply. */
  get(key: string, maxAgeMs = this.options.ttlMs): CachedValue | null {
    const entry = this.map.get(key) ?? this.disk?.read(key);
    if (!entry) return null;
    if (this.expired(entry)) {
      this.map.delete(key);
      this.disk?.remove(key);
      return null;
    }
    if (this.now() - entry.createdAt >= maxAgeMs) return null; // Live, but older than this caller accepts.
    this.remember(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: string, raw: CachedValue, ttlMs = this.options.ttlMs): void {
    const now = this.now();
    const entry: CacheEntry = { value: raw, createdAt: now, expiresAt: now + Math.min(ttlMs, this.options.ttlMs) };
    this.remember(key, entry);
    // The guard may mask a number under a secret-like label (a probability becomes a string);
    // DiskCacheStore then refuses the copy rather than replay a different answer.
    this.disk?.write(key, { ...entry, value: this.options.sanitize ? this.options.sanitize(raw) : raw });
  }

  /** Drops every entry of one model version (memory and disk). Returns how many. */
  purgeNamespace(namespace: string): number {
    const prefix = `${namespace}:`;
    let n = 0;
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix) && this.map.delete(k)) n++;
    this.disk?.purge(prefix);
    return n;
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  get diskEnabled(): boolean {
    return this.disk !== null;
  }

  /** Most recently used last; the least recently used entry leaves once maxEntries is passed (disk hits too). */
  private remember(key: string, entry: CacheEntry): void {
    this.map.delete(key);
    this.map.set(key, entry);
    while (this.map.size > this.options.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /**
   * Past its own TTL, older than the current cache.ttlMs (a lower TTL configured after it was
   * written), or stored "in the future" (written while the clock ran ahead).
   */
  private expired(entry: CacheEntry): boolean {
    const now = this.now();
    return entry.expiresAt <= now || entry.createdAt > now || now - entry.createdAt >= this.options.ttlMs;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
