import { abortError } from "../transport/ErrorMapper.js";

/** Longest delay a Node timer holds (2^31-1 ms); a longer one overflows to 1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;

/** Error used as the abort reason when a total deadline expires. */
export class DeadlineExceeded extends Error {
  constructor(ms: number) {
    super(`Total deadline of ${ms} ms exceeded.`);
    this.name = "DeadlineExceeded";
  }
}

/**
 * Combines the caller's cancellation signal (MCP cancellation) with a total deadline for
 * the whole call, retries included. The JS SDK has no total budget, so this enforces one.
 */
export class Deadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly onParentAbort: () => void;

  constructor(
    totalMs: number,
    private readonly parent?: AbortSignal,
  ) {
    this.signal = this.controller.signal;
    this.onParentAbort = () => this.controller.abort(parent?.reason ?? new Error("cancelled"));
    if (parent?.aborted) this.onParentAbort();
    parent?.addEventListener("abort", this.onParentAbort, { once: true });
    this.timer = setTimeout(() => this.controller.abort(new DeadlineExceeded(totalMs)), Math.min(totalMs, MAX_TIMER_MS));
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.parent?.removeEventListener("abort", this.onParentAbort);
  }

  /** Runs `fn` with the deadline's signal; `fn` decides how to end on abort (a batch returns partial results). */
  static async run<T>(totalMs: number, parent: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const deadline = new Deadline(totalMs, parent);
    try {
      return await fn(deadline.signal);
    } finally {
      deadline.dispose();
    }
  }

  /**
   * Like `run`, but settles at the deadline (or the caller's abort) even when `fn` does not:
   * work that ignores the abort signal (a stalled fetch) cannot hold one call past its deadline.
   */
  static async race<T>(totalMs: number, parent: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const deadline = new Deadline(totalMs, parent);
    const signal = deadline.signal;
    let onAbort = (): void => undefined;
    const ended = new Promise<never>((_, reject) => {
      onAbort = () => reject(abortError(abortReason(signal)));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const work = fn(signal);
      work.catch(() => undefined); // may settle after the deadline, when nothing awaits it any more
      return await Promise.race([work, ended]);
    } finally {
      signal.removeEventListener("abort", onAbort);
      deadline.dispose();
    }
  }
}

/** Reads why a signal fired: the Deadline class tags its reason. */
export function abortReason(signal: AbortSignal): "deadline" | "caller" {
  const reason: unknown = signal.reason;
  return reason instanceof Error && reason.name === "DeadlineExceeded" ? "deadline" : "caller";
}
