import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { DAY_USAGE_LOCK_POLL_MS, DAY_USAGE_LOCK_STALE_MS, DAY_USAGE_LOCK_WAIT_MS } from "../config/defaults.js";

/**
 * The day's input-token total per user, in one small JSON file shared by every jev-mcp
 * process (each Claude Code session starts one), so `session.dailyInputTokens` holds across
 * sessions and restarts. Updates hold an exclusive filesystem lock and publish a complete
 * replacement. Existing unreadable/corrupt data fails closed rather than resetting usage.
 */
export class DayUsageStore {
  private readonly owners = new Map<string, string>();
  constructor(private readonly path: string) {}

  /** Tokens spent on `day` (YYYY-MM-DD, UTC) by every session; 0 for another day or no file. */
  read(day: string): number {
    mkdirSync(dirname(this.path), { recursive: true });
    const lock = `${this.path}.lock`;
    this.acquire(lock);
    try { return this.readStored(day); }
    finally { this.release(lock); }
  }

  private readStored(day: string): number {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (typeof raw !== "object" || raw === null) throw new Error("Invalid daily usage data");
      const { day: d, input_tokens: n } = raw as { day?: unknown; input_tokens?: unknown };
      if (typeof d !== "string" || typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error("Invalid daily usage data");
      return d === day ? n : 0;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw err;
    }
  }

  /** Adds `tokens` to `day` and returns the new total. */
  add(day: string, tokens: number): number {
    if (!Number.isFinite(tokens) || tokens < 0) throw new Error("Invalid daily usage increment");
    mkdirSync(dirname(this.path), { recursive: true });
    const lock = `${this.path}.lock`;
    this.acquire(lock);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const total = this.readStored(day) + tokens;
      const file = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(file, JSON.stringify({ day, input_tokens: total }));
        fsyncSync(file);
      } finally { closeSync(file); }
      this.replace(temporary);
      return total;
    } finally { this.cleanup(temporary, lock); }
  }

  private cleanup(temporary: string, lock: string): void {
    try {
      try { unlinkSync(temporary); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    } finally { this.release(lock); }
  }

  /** Windows may temporarily deny replacement while another process has the old file open. */
  private replace(temporary: string): void {
    const until = Date.now() + DAY_USAGE_LOCK_WAIT_MS;
    const wait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    for (;;) {
      try { renameSync(temporary, this.path); return; }
      catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (!(code === "EPERM" || code === "EACCES" || code === "EBUSY") || Date.now() >= until) throw err;
        Atomics.wait(wait, 0, 0, DAY_USAGE_LOCK_POLL_MS);
      }
    }
  }

  private acquire(lock: string): void {
    const until = Date.now() + DAY_USAGE_LOCK_WAIT_MS;
    const wait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    for (;;) {
      try {
        mkdirSync(lock, { mode: 0o700 });
        const token = randomUUID();
        try { writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), token }), { flag: "wx", mode: 0o600 }); }
        catch (err) { try { rmdirSync(lock); } catch { /* Leave failed creation for age-based recovery. */ } throw err; }
        this.owners.set(lock, token);
        return;
      }
      catch (err) {
        // Windows refuses a lock directory that is being deleted with EPERM/EACCES/EBUSY: contention too.
        const code = (err as NodeJS.ErrnoException).code;
        if (!(code === "EEXIST" || code === "EPERM" || code === "EACCES" || code === "EBUSY") || Date.now() >= until) throw err;
        if (code === "EEXIST" && this.reclaimStale(lock)) continue;
        Atomics.wait(wait, 0, 0, DAY_USAGE_LOCK_POLL_MS);
      }
    }
  }

  /** Windows may refuse to remove the lock directory for a moment while another process looks at it. */
  private release(lock: string): void {
    const until = Date.now() + DAY_USAGE_LOCK_WAIT_MS;
    const wait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    for (;;) {
      try {
        const owner = this.readOwner(lock);
        if (owner && owner.token !== this.owners.get(lock)) throw new Error("Daily usage lock ownership changed");
        try { unlinkSync(join(lock, "owner.json")); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
        rmdirSync(lock); this.owners.delete(lock); return;
      }
      catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return;
        if (!(code === "EPERM" || code === "EACCES" || code === "EBUSY") || Date.now() >= until) throw err;
        Atomics.wait(wait, 0, 0, DAY_USAGE_LOCK_POLL_MS);
      }
    }
  }

  private readOwner(lock: string): { pid: number; host: string; token: string } | null {
    try {
      const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
      return Number.isSafeInteger(owner?.pid) && owner.pid > 0 && typeof owner.host === "string" && typeof owner.token === "string" && owner.token.length > 0 ? owner : null;
    } catch { return null; }
  }

  /** Quarantine first, then check identity again before deleting anything. */
  private reclaimStale(lock: string): boolean {
    try {
      const observed = statSync(lock);
      const owner = this.readOwner(lock);
      let deadLocalOwner = false;
      if (owner?.host === hostname()) {
        try { process.kill(owner.pid, 0); return false; }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") return false;
          deadLocalOwner = true;
        }
      }
      if (!deadLocalOwner && Date.now() - observed.mtimeMs < DAY_USAGE_LOCK_STALE_MS) return false;
      const quarantine = `${lock}.${randomUUID()}.reclaim`;
      renameSync(lock, quarantine);
      const moved = statSync(quarantine);
      const movedOwner = this.readOwner(quarantine);
      if (moved.dev !== observed.dev || moved.ino !== observed.ino || moved.mtimeMs !== observed.mtimeMs || movedOwner?.token !== owner?.token) {
        // A newer owner won the race. Never delete its directory; failed hand-back also fails closed.
        renameSync(quarantine, lock);
        return false;
      }
      rmSync(quarantine, { recursive: true });
      return true;
    } catch {
      return false; // released or reclaimed meanwhile: retry the create
    }
  }
}
