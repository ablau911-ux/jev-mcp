import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface UsageRecord {
  tool: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  request_id: string | null;
  /** Client-side id (no vendor request id is documented). */
  client_id?: string;
  /** Pre-flight estimate, to report estimate/actual drift. */
  est_tokens?: number;
  cached: boolean;
}

interface Totals {
  requests: number;
  cached_hits: number;
  input_tokens: number;
  output_tokens: number;
}

export interface UsageSnapshot extends Totals {
  est_cost_usd: number;
  cost_note: string;
  by_tool: Record<string, Totals & { est_cost_usd: number }>;
  by_model: Record<string, Totals & { est_cost_usd: number }>;
  /** Sum of pre-flight estimates / sum of real input_tokens over uncached calls (1 = exact). */
  estimate_ratio: number | null;
}

export interface FailureStreak {
  count: number;
  /** Epoch ms of the last failure, or null. */
  at: number | null;
  kind: string | null;
}

const empty = (): Totals => ({ requests: 0, cached_hits: 0, input_tokens: 0, output_tokens: 0 });

/**
 * Session totals of requests and tokens, per tool and per model. Cost is an estimate from
 * the configured price. The optional JSONL ledger holds metadata only, never content, and
 * every line passes the secret guard (the response model and request id come from outside).
 */
export class UsageLedger {
  private total = empty();
  private byTool = new Map<string, Totals>();
  private byModel = new Map<string, Totals>();
  private estSum = 0;
  private actualSum = 0;
  /** When Jev last answered a request (not a cache hit), epoch ms; health uses it (break hunt 1). */
  private answeredAt: number | null = null;
  /** Upstream failures in a row since Jev last answered; health uses it (break hunt 1). */
  private failures: FailureStreak = { count: 0, at: null, kind: null };

  constructor(
    private readonly usdPerMTok: number,
    private readonly costNote: string,
    private readonly ledgerPath: string | null,
    /** Secret guard for persisted records (OutboundSanitizer.scrubValue); identity in unit tests. */
    private readonly sanitize: <T>(value: T) => T = (v) => v,
  ) {}

  estimateCost(inputTokens: number): number {
    return (inputTokens * this.usdPerMTok) / 1e6;
  }

  record(r: UsageRecord): void {
    for (const t of [this.total, this.bucket(this.byTool, r.tool), this.bucket(this.byModel, r.model)]) {
      if (r.cached) {
        t.cached_hits++;
        continue;
      }
      t.requests++;
      t.input_tokens += r.input_tokens ?? 0;
      t.output_tokens += r.output_tokens ?? 0;
    }
    if (!r.cached && r.est_tokens !== undefined && (r.input_tokens ?? 0) > 0) {
      this.estSum += r.est_tokens;
      this.actualSum += r.input_tokens;
    }
    if (!r.cached) this.append(r);
    if (!r.cached) {
      this.answeredAt = Date.now();
      this.failures = { count: 0, at: null, kind: null };
    }
  }

  /** A sent request that failed for a reason of the service or the key (auth, unavailable), not of the input. */
  recordFailure(kind: string): void {
    this.failures = { count: this.failures.count + 1, at: Date.now(), kind };
  }

  get failureStreak(): FailureStreak {
    return { ...this.failures };
  }

  /** Epoch ms of the last request Jev answered in this process, or null. */
  get lastAnsweredAt(): number | null {
    return this.answeredAt;
  }

  snapshot(): UsageSnapshot {
    const withCost = (t: Totals) => ({ ...t, est_cost_usd: this.estimateCost(t.input_tokens) });
    return {
      ...withCost(this.total),
      cost_note: this.costNote,
      by_tool: Object.fromEntries([...this.byTool].map(([k, v]) => [k, withCost(v)])),
      by_model: Object.fromEntries([...this.byModel].map(([k, v]) => [k, withCost(v)])),
      estimate_ratio: this.actualSum > 0 ? Math.round((this.estSum / this.actualSum) * 1000) / 1000 : null,
    };
  }

  reset(): void {
    this.total = empty();
    this.byTool = new Map();
    this.byModel = new Map();
    this.estSum = 0;
    this.actualSum = 0;
  }

  private bucket(map: Map<string, Totals>, key: string): Totals {
    let t = map.get(key);
    if (!t) {
      t = empty();
      map.set(key, t);
    }
    return t;
  }

  private append(r: UsageRecord): void {
    if (!this.ledgerPath) return;
    try {
      mkdirSync(dirname(this.ledgerPath), { recursive: true });
      appendFileSync(this.ledgerPath, `${JSON.stringify(this.sanitize({ ts: new Date().toISOString(), ...r }))}\n`);
    } catch {
      // Ledger is best effort; never fail a call over it.
    }
  }
}
