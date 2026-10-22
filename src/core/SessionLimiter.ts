import { DEFAULT_CONFIG } from "../config/defaults.js";
import type { JevConfig } from "../config/types.js";
import { JevError } from "./JevError.js";
import { sleep } from "./RateGate.js";

export interface LimiterOptions {
  session: JevConfig["session"];
  tokensPerSecond: number;
  retryCap: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The day total shared by every process of the user (DayUsageStore); in-process only when absent. */
  day?: DayTotals;
}

export interface DayTotals {
  read(day: string): number;
  /** Adds tokens to the day and returns the new total. */
  add(day: string, tokens: number): number;
}

const INLINE = "Judge inline instead; do not retry in a loop.";

/**
 * Session caps (MCP says servers MUST rate limit): total input tokens per
 * session, requests per minute, a daily input-token limit, a tokens/s bucket shared by every
 * call, and a session-wide retry budget. Breaches are `budget_exceeded`.
 */
export class SessionLimiter {
  private sessionTokens = 0;
  /** Estimates of admitted calls still in flight (reserved by `admit`). */
  private pending = 0;
  private day = "";
  private dayTokens = 0;
  /** Billed increments not yet acknowledged by persistent storage. */
  private unpersisted = 0;
  private recent: number[] = [];
  private bucket: number;
  private bucketAt: number;
  private retriesLeft: number;

  constructor(private readonly o: LimiterOptions) {
    this.bucket = o.tokensPerSecond;
    this.bucketAt = this.now();
    this.retriesLeft = SessionLimiter.retryCap(o.retryCap);
  }

  /** The session retry budget as a whole number >= 0; a non-number (or NaN, Infinity, negative) is the default, never "no ceiling". */
  private static retryCap(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_CONFIG.retry.sessionCap;
  }

  /**
   * Throws `budget_exceeded` when this request would break a cap. Otherwise reserves
   * `estTokens` until `release`, so concurrent calls in flight count against the token caps
   * before their usage is recorded.
   */
  admit(estTokens: number): void {
    const s = this.o.session;
    const now = this.now();
    if (this.minuteFull(now)) throw SessionLimiter.exceeded(`${s.requestsPerMinute} requests per minute reached.`);
    if (this.sessionTokens + this.pending + estTokens > s.maxInputTokens) throw SessionLimiter.exceeded(`Session input-token cap ${s.maxInputTokens} reached.`);
    this.rollDay();
    if (this.dayTokens + this.pending + estTokens > s.dailyInputTokens) throw SessionLimiter.exceeded(`Daily input-token cap ${s.dailyInputTokens} reached.`);
    this.recent.push(now);
    this.pending += estTokens;
  }

  /** One more HTTP request of an admitted call (the long-context resend) in the per-minute window. */
  admitResend(): void {
    const now = this.now();
    if (this.minuteFull(now)) throw SessionLimiter.exceeded(`${this.o.session.requestsPerMinute} requests per minute reached.`);
    this.recent.push(now);
  }

  /** Ends the reservation `admit` made (after the usage is recorded, or the call failed). */
  release(estTokens: number): void {
    this.pending = Math.max(0, this.pending - estTokens);
  }

  /**
   * Waits until the tokens/s bucket holds `estTokens` (requests larger than the bucket wait for a
   * full one). The tokens are taken at once, so concurrent callers queue one after another
   * instead of all spending one refill. A wait longer than `maxWaitMs` (the rest of the call's
   * deadline) is refused at once, taking nothing.
   */
  async throttle(estTokens: number, signal?: AbortSignal, maxWaitMs = Infinity): Promise<void> {
    signal?.throwIfAborted();
    const rate = this.o.tokensPerSecond;
    const need = Math.min(estTokens, rate);
    this.refill();
    const wait = this.bucket >= need ? 0 : Math.ceil(((need - this.bucket) / rate) * 1000);
    if (wait > 0 && wait >= maxWaitMs) throw SessionLimiter.exceeded(`Tokens/s cap ${rate}: the next slot is ${wait} ms away, past this call's deadline.`);
    this.bucket -= need;
    try {
      if (wait > 0) await (this.o.sleep ?? sleep)(wait, signal);
      signal?.throwIfAborted();
    } catch (err) {
      // This reservation never reached a send. Refill before refunding so time spent
      // waiting is retained, without creating more than one bucket of capacity.
      this.refill();
      this.bucket = Math.min(rate, this.bucket + need);
      throw err;
    }
  }

  record(inputTokens: number): void {
    this.sessionTokens += inputTokens;
    this.rollDay(false);
    this.dayTokens += inputTokens;
    if (!this.o.day) return;
    this.unpersisted += inputTokens;
    const total = this.o.day.add(this.day, this.unpersisted);
    // Clear only after acknowledgement. Carry failures across midnight into the recovery
    // day: the shared store holds one day, so backdating would overwrite today's usage.
    this.unpersisted = 0;
    this.dayTokens = Math.max(this.dayTokens, total);
  }

  /** A retry resends the request: it takes a session retry token and a place in the per-minute window. */
  takeRetry(): boolean {
    const now = this.now();
    if (this.retriesLeft <= 0 || this.minuteFull(now)) return false;
    this.retriesLeft--;
    this.recent.push(now);
    return true;
  }

  /** Returns what `takeRetry` took for a retry that was never sent (cancelled while waiting). */
  refundRetry(): void {
    this.retriesLeft++;
    this.recent.pop();
  }

  /** Prunes the per-minute window and says whether it is full. */
  private minuteFull(now: number): boolean {
    // A timestamp later than now means the wall clock stepped back (NTP, VM resume): drop it.
    this.recent = this.recent.filter((t) => t <= now && now - t < 60_000);
    return this.recent.length >= this.o.session.requestsPerMinute;
  }

  snapshot() {
    return { session_input_tokens: this.sessionTokens, day_input_tokens: this.dayTokens, retries_left: this.retriesLeft, caps: this.o.session };
  }

  private refill(): void {
    const now = this.now();
    // Elapsed time never counts negative: a wall-clock step back must not drain the bucket.
    const elapsed = Math.max(0, now - this.bucketAt);
    this.bucket = Math.min(this.o.tokensPerSecond, this.bucket + (elapsed / 1000) * this.o.tokensPerSecond);
    this.bucketAt = now;
  }

  /** Starts a new UTC day at 0, then takes in what other processes of the user spent today. */
  private rollDay(refresh = true): void {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.dayTokens = this.unpersisted;
    }
    if (refresh && this.o.day) this.dayTokens = Math.max(this.dayTokens, this.o.day.read(today) + this.unpersisted);
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private static exceeded(message: string): JevError {
    return new JevError({ kind: "budget_exceeded", message, fix: `${INLINE} Caps live in jev-config.json (session.*).` });
  }
}
