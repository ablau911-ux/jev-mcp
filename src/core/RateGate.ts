import { abortReason, MAX_TIMER_MS } from "./Deadline.js";
import { abortError } from "../transport/ErrorMapper.js";

export interface RateGateOptions {
  concurrency: number;
  recoverAfter: number;
  maxPauseMs: number;
  now?: () => number;
}

/** Abortable sleep shared by the gate and the retrier. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(abortReason(signal)));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.min(Math.max(0, ms), MAX_TIMER_MS));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal ? abortReason(signal) : "caller"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * AIMD concurrency gate shared by jev_batch and the pointwise modes of jev_rerank and
 * jev_find_lines. On 429/529 it halves concurrency (min 1) and holds every worker until
 * Retry-After passes; after `recoverAfter` consecutive successes it adds one slot back.
 */
export class RateGate {
  private limit: number;
  private readonly target: number;
  private inFlight = 0;
  private streak = 0;
  private pauseUntil = 0;
  private readonly waiters: Array<() => void> = [];
  rateLimitEvents = 0;

  constructor(private readonly options: RateGateOptions) {
    this.limit = Math.max(1, options.concurrency);
    this.target = this.limit;
  }

  get concurrency(): number {
    return this.limit;
  }

  get active(): number {
    return this.inFlight;
  }

  /**
   * Takes a slot. A waiter woken by `release` re-checks both the limit and the shared
   * Retry-After pause, so it never sends inside a pause another worker just received.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw abortError(abortReason(signal));
      if (this.inFlight >= this.limit) {
        await this.parked(signal);
        continue;
      }
      const pause = this.pauseUntil - this.now();
      if (pause <= 0) break;
      await sleep(pause, signal);
    }
    this.inFlight++;
  }

  /** Waits for a wake or the abort; its abort listener is removed either way (one per wait, never piling up). */
  private parked(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        signal?.removeEventListener("abort", done);
        const i = this.waiters.indexOf(done);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve();
      };
      this.waiters.push(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }


  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.wake();
  }

  /** Waits while a shared Retry-After pause is active. */
  async waitForPause(signal?: AbortSignal): Promise<void> {
    const wait = this.pauseUntil - this.now();
    if (wait > 0) await sleep(wait, signal);
  }

  onSuccess(): void {
    this.streak++;
    if (this.streak >= this.options.recoverAfter && this.limit < this.target) {
      this.limit++;
      this.streak = 0;
      this.wake();
    }
  }

  onRateLimited(retryAfterMs: number | null): void {
    this.rateLimitEvents++;
    this.streak = 0;
    this.limit = Math.max(1, Math.floor(this.limit / 2));
    if (retryAfterMs !== null && retryAfterMs <= this.options.maxPauseMs) {
      this.pauseUntil = Math.max(this.pauseUntil, this.now() + retryAfterMs);
    }
  }

  /** Wakes every waiter; each re-checks the limit in `acquire`. */
  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
