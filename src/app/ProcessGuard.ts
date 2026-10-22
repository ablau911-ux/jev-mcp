import type { SafeLogger } from "../logging/SafeLogger.js";

type ProcessLike = Pick<NodeJS.Process, "on">;

/**
 * Keeps the stdio server alive when a promise rejects with no handler. SDK 0.6.0 could crash
 * the process on an abort race; 0.7 fixes that, but a stray rejection in
 * any dependency must never take the MCP channel down. The reason is logged (redacted) to
 * stderr and counted, so `jev_status` can report it.
 */
export class ProcessGuard {
  private count = 0;

  constructor(private readonly logger: SafeLogger) {}

  install(proc: ProcessLike = process): void {
    proc.on("unhandledRejection", (reason: unknown) => this.onRejection(reason));
  }

  onRejection(reason: unknown): void {
    this.count++;
    const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    this.logger.error(`unhandled rejection (kept running): ${message}`);
  }

  get unhandledRejections(): number {
    return this.count;
  }
}
