import { DEFAULT_CONFIG } from "../config/defaults.js";
import type { RetrySettings } from "../config/types.js";
import { asJevError, type JevError } from "./JevError.js";
import { sleep as defaultSleep, type RateGate } from "./RateGate.js";

export interface RetrierOptions {
  /** Documented retryable statuses (errors.md: 429, 529). */
  statuses: number[];
  /** Other 5xx are retried at most this many times per call (undocumented; labelled). */
  serverErrorRetries: number;
  maxRetryAfterMs: number;
  /** Session-wide retry budget; returns false once spent. */
  takeRetry?: () => boolean;
  /** Gives back a token from `takeRetry` when the wait before the resend is aborted (nothing was resent). */
  refundRetry?: () => void;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Bounds of a policy's maxRetries (round 5): `fallback` for a non-number, at most `cap`; both validated. */
  retryLimit?: { fallback: number; cap: number };
}

export interface RetryRun {
  policy: RetrySettings;
  signal?: AbortSignal;
  gate?: RateGate;
  /** Epoch ms when the call's total deadline ends; delays never run past it. */
  deadlineAt?: number;
  onRetry?: (err: JevError, attempt: number, delayMs: number) => void;
  now?: () => number;
}

const RATE_KINDS = new Set(["rate_limited", "overloaded"]);

/**
 * Retry loop: retries the documented 429 and 529, network errors and
 * attempt timeouts; other 5xx at most `serverErrorRetries` times; never 4xx. Honours
 * `retry-after-ms` / `Retry-After` up to `maxRetryAfterMs`, capped at the remaining
 * deadline. Every retry resends the full request (and its data) to TypeSafe.
 */
export class Retrier {
  constructor(private readonly options: RetrierOptions) {}

  async run<T>(fn: () => Promise<T>, run: RetryRun): Promise<T> {
    let serverErrors = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(fn, run);
      } catch (thrown) {
        const err = asJevError(thrown);
        if (err.kind === "server_error") serverErrors++;
        if (!this.shouldRetry(err, attempt, run.policy, serverErrors)) throw err;
        const delay = this.delayMs(attempt, err, run.policy);
        const remaining = run.deadlineAt === undefined ? Infinity : run.deadlineAt - (run.now ?? Date.now)();
        if (delay >= remaining) throw err;
        if (this.options.takeRetry && !this.options.takeRetry()) throw err;
        run.onRetry?.(err, attempt + 1, delay);
        try {
          await (this.options.sleep ?? defaultSleep)(delay, run.signal);
        } catch (aborted) {
          this.options.refundRetry?.(); // cancelled before the resend: no retry was spent
          throw aborted;
        }
      }
    }
  }

  shouldRetry(err: JevError, attempt: number, policy: RetrySettings, serverErrors: number): boolean {
    if (!this.isRetryable(err) || attempt >= this.maxRetries(policy.maxRetries)) return false;
    return err.kind !== "server_error" || serverErrors <= this.options.serverErrorRetries;
  }

  /**
   * The retry limit as a bounded integer (round 5/6): the value, the configured fallback and
   * the configured cap are each floored; a non-number, NaN, Infinity or negative value (a cap
   * below 1) is replaced by the default. The result is never NaN; nothing disables the limit.
   */
  maxRetries(value: unknown): number {
    const limit = this.options.retryLimit;
    const cap = Retrier.whole(limit?.cap, DEFAULT_CONFIG.retry.maxRetriesCap, 1);
    const fallback = Retrier.whole(limit?.fallback, DEFAULT_CONFIG.retry.single.maxRetries, 0);
    return Math.min(Retrier.whole(value, fallback, 0), cap);
  }

  /** `value` floored when it is a finite number of at least `min`, else `def`. */
  private static whole(value: unknown, def: number, min: number): number {
    const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN;
    return n >= min ? n : def;
  }

  isRetryable(err: JevError): boolean {
    if (!err.retryable) return false;
    if (err.status === null || this.options.statuses.includes(err.status)) return true;
    return err.kind === "server_error" || err.kind === "timeout";
  }

  /** Server delay when present and within the cap; else backoff with jitter subtracted. */
  delayMs(attempt: number, err: JevError | null, policy: RetrySettings): number {
    const server = err?.retryAfterMs ?? null;
    if (server !== null && server <= this.options.maxRetryAfterMs) return server;
    const base = Math.min(policy.maxMs, policy.initialMs * 2 ** attempt);
    const random = (this.options.random ?? Math.random)();
    return Math.round(base * (1 - policy.jitter * random));
  }

  private async attempt<T>(fn: () => Promise<T>, run: RetryRun): Promise<T> {
    const gate = run.gate;
    if (!gate) return fn();
    await gate.waitForPause(run.signal);
    await gate.acquire(run.signal);
    try {
      const result = await fn();
      gate.onSuccess();
      return result;
    } catch (thrown) {
      // Before release: the pause must be set before release wakes the waiters.
      const err = asJevError(thrown);
      if (RATE_KINDS.has(err.kind)) gate.onRateLimited(err.retryAfterMs);
      throw err;
    } finally {
      gate.release();
    }
  }
}
