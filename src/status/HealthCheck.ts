import type { JevConfig } from "../config/types.js";
import { asJevError } from "../core/JevError.js";
import type { JevTransport } from "../transport/JevTransport.js";
import type { KeyProvider } from "../security/KeyProvider.js";

export interface HealthResult {
  ok: boolean;
  checked_at: string | null;
  latency_ms?: number;
  /** The standard error contract: kind, message, fix and retryable. */
  error?: { kind: string; message: string; fix: string; retryable: boolean; cause: string };
}

/**
 * Startup health check: one GET /v1/models with a short timeout and no
 * retries, run in the background at startup so `jev_status` can say at once whether Jev is
 * reachable. It never blocks the server or a tool call; offline machines just report
 * `ok:false`, and the agent judges inline.
 */
export class HealthCheck {
  static readonly FIX = "Jev is unavailable: judge inline; jev_status {refresh:true} checks again.";

  private last: HealthResult = { ok: false, checked_at: null };
  private running: Promise<HealthResult> | null = null;

  constructor(
    private readonly transport: JevTransport,
    private readonly keys: KeyProvider,
    private readonly config: JevConfig,
  ) {}

  get result(): HealthResult {
    return this.last;
  }

  /** Starts a check unless one is running; resolves with its result. */
  run(): Promise<HealthResult> {
    this.running ??= this.check().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async check(): Promise<HealthResult> {
    const started = Date.now();
    try {
      if (this.config.backend !== "mock") this.keys.getKey();
      const signal = AbortSignal.timeout(this.config.health.timeoutMs);
      await this.transport.listModels({ headers: {}, signal, timeoutMs: this.config.health.timeoutMs });
      this.last = { ok: true, checked_at: new Date().toISOString(), latency_ms: Date.now() - started };
    } catch (err) {
      const e = asJevError(err);
      this.last = { ok: false, checked_at: new Date().toISOString(), error: { kind: e.publicKind, message: e.message, fix: e.fix || HealthCheck.FIX, retryable: e.retryable, cause: e.kind } };
    }
    return this.last;
  }
}
