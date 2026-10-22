import { DEFAULT_CONFIG } from "../config/defaults.js";
import type { JevConfig } from "../config/types.js";
import { abortReason, Deadline } from "./Deadline.js";
import type { JevService } from "./JevService.js";
import { asJevError, JevError, type JevErrorJson } from "./JevError.js";
import { RateGate, type RateGateOptions } from "./RateGate.js";
import type { CallResult, Entry, ImageSpec, Questions } from "./types.js";

export interface BatchItem {
  id: string;
  state: Entry;
  images?: Record<string, ImageSpec>;
  questions?: Questions;
  /** What the item is, for auto-labels: a diff hunk (file + text) or a file path. */
  subject?: { kind: "hunk" | "file" | "item"; key: string; text?: string };
}

export interface BatchInput {
  items: BatchItem[];
  questions?: Questions;
  model?: string;
  pin_model?: boolean;
  concurrency?: number;
  max_retries?: number;
  stop_on_first_error?: boolean;
  max_total_input_tokens?: number | null;
  only_ids?: string[] | null;
  cache?: boolean;
  cacheTtlMs?: number;
  long_context?: boolean | "auto";
}

export interface ItemResult {
  id: string;
  ok: boolean;
  item: BatchItem;
  call?: CallResult;
  /** The question ids this item's request asked (an ok item), for the asked-vs-answered check. */
  asked?: string[];
  /** Effective question bodies, retained for rerun identity (including shared questions). */
  effectiveQuestions?: Questions;
  error?: JevErrorJson;
  skipped?: "budget" | "stopped" | "deadline";
  /** Redactions in a request that was sent but failed (an ok item reports them on `call`). */
  secrets_redacted?: number;
}

export interface BatchRun {
  results: ItemResult[];
  models: string[];
  wall_ms: number;
  final_concurrency: number;
  rate_limit_events: number;
  warnings: string[];
  /** Every question name asked (shared and per item), so rank_by can be checked against them. */
  questions: string[];
}

interface RunState {
  pinned: string | null;
  tokens: number;
  stopped: boolean;
  models: Set<string>;
}

/**
 * A call's gate that also holds the session gate: the call's own limit, plus the session-wide
 * in-flight cap, Retry-After pause and AIMD shared by every concurrent call (the 429 limit is
 * per organization; break: per-call rate gate).
 */
class SessionBoundGate extends RateGate {
  constructor(
    options: RateGateOptions,
    private readonly session: RateGate,
  ) {
    super(options);
  }

  override async acquire(signal?: AbortSignal): Promise<void> {
    await super.acquire(signal);
    try {
      await this.session.acquire(signal);
    } catch (err) {
      super.release();
      throw err;
    }
  }

  override release(): void {
    this.session.release();
    super.release();
  }

  override async waitForPause(signal?: AbortSignal): Promise<void> {
    await this.session.waitForPause(signal);
    await super.waitForPause(signal);
  }

  override onSuccess(): void {
    super.onSuccess();
    this.session.onSuccess();
  }

  override onRateLimited(retryAfterMs: number | null): void {
    super.onRateLimited(retryAfterMs);
    this.session.onRateLimited(retryAfterMs);
  }
}

/** Runs the same questions over many states, one request per state, through a RateGate. */
export class BatchRunner {
  /** One gate for the whole session: concurrency.cap requests in flight across all calls. */
  private readonly session: RateGate;

  constructor(private readonly service: JevService) {
    const c = service.config.concurrency;
    this.session = new RateGate({ concurrency: Math.max(1, c.cap), recoverAfter: c.recoverAfter, maxPauseMs: service.config.retry.maxRetryAfterMs });
    service.useSessionGate(this.session);
  }

  get config(): JevConfig {
    return this.service.config;
  }

  /** Creates a call gate with the configured cap (warning when a caller asks for more), bound to the session gate. */
  createGate(requested: number | undefined, warnings: string[]): RateGate {
    const c = this.service.config.concurrency;
    let n = requested ?? c.default;
    if (n > c.cap) {
      warnings.push(`concurrency ${n} capped at ${c.cap} (raise concurrency.cap in config).`);
      n = c.cap;
    }
    return new SessionBoundGate({ concurrency: Math.max(1, n), recoverAfter: c.recoverAfter, maxPauseMs: this.service.config.retry.maxRetryAfterMs }, this.session);
  }

  /**
   * Worker pool: up to `workers` items in flight; the gate further limits HTTP attempts. After the
   * first rejection no worker takes a new item, and map rejects only once every in-flight item has
   * settled, so nothing is sent after the caller got the error (break: map runaway).
   */
  async map<T, R>(items: T[], workers: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    const failure: { hit: boolean; error?: unknown } = { hit: false };
    let next = 0;
    const worker = async () => {
      while (!failure.hit && next < items.length) {
        const i = next++;
        try {
          results[i] = await fn(items[i] as T, i);
        } catch (error) {
          if (!failure.hit) Object.assign(failure, { hit: true, error });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, items.length)) }, worker));
    if (failure.hit) throw failure.error;
    return results;
  }

  async run(input: BatchInput, tool: string, signal?: AbortSignal): Promise<BatchRun> {
    const started = Date.now();
    const warnings: string[] = [];
    const items = this.selectItems(input, warnings);
    const gate = this.createGate(input.concurrency, warnings);
    const st: RunState = { pinned: null, tokens: 0, stopped: false, models: new Set<string>() };
    const results = await this.withDeadline(signal, (s) => this.map(items, gate.concurrency, (item) => this.runItem(item, input, tool, gate, st, s)));
    const late = results.filter((r) => r.skipped === "deadline").length;
    if (late > 0) warnings.push(`The batch hit its MCP_TOOL_TIMEOUT deadline; ${late} item(s) skipped. Rerun them with only_ids.`);
    const questions = [...new Set(items.flatMap((i) => Object.keys(i.questions ?? input.questions ?? {})))];
    return { results, models: [...st.models], wall_ms: Date.now() - started, final_concurrency: gate.concurrency, rate_limit_events: gate.rateLimitEvents, warnings, questions };
  }

  /**
   * The whole batch fits inside MCP_TOOL_TIMEOUT (minus the margin) when the user set one: the
   * per-item deadline alone let N items run N times past it (break: batch deadline).
   */
  private withDeadline<T>(signal: AbortSignal | undefined, fn: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    if (this.service.config.timeouts.mcpToolTimeoutMs === null) return fn(signal);
    return Deadline.run(this.service.totalMs(Number.POSITIVE_INFINITY), signal, fn);
  }

  /**
   * The item limit: min(maxItems, hardMaxItems), each a whole number >= 1 or its default, so a
   * non-number in jev-config.json never disables the ceiling (break: maxItems non-number).
   */
  private itemLimit(): number {
    const limits = this.service.config.batch;
    const whole = (v: unknown, def: number) => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : def);
    return Math.min(whole(limits.maxItems, DEFAULT_CONFIG.batch.maxItems), whole(limits.hardMaxItems, DEFAULT_CONFIG.batch.hardMaxItems));
  }

  private selectItems(input: BatchInput, warnings: string[]): BatchItem[] {
    const max = this.itemLimit();
    if (input.items.length === 0) throw JevError.invalid("items must not be empty.", undefined, "Pass items or items_from (e.g. \"$diff\").");
    if (input.items.length > max) throw JevError.invalid(`items has ${input.items.length} entries; the limit is ${max}.`, undefined, "Split the batch or narrow items_from.");
    const ids = new Set<string>();
    for (const item of input.items) {
      if (ids.has(item.id)) throw JevError.invalid(`Duplicate item id ${item.id}.`, undefined, "Give every item a unique id.");
      ids.add(item.id);
      if (!item.questions && !input.questions) throw JevError.invalid(`Item ${item.id} has no questions and no shared questions were given.`);
    }
    if (!input.only_ids) return input.items;
    const only = new Set(input.only_ids);
    // An only_ids entry that names no item is reported, never dropped silently (break: only_ids unknown).
    const unknown = [...only].filter((id) => !ids.has(id));
    if (unknown.length === only.size) throw JevError.invalid(`only_ids match no item: ${JSON.stringify(unknown)}.`, undefined, "Use item ids from the earlier result (ids are case-sensitive).");
    if (unknown.length > 0) warnings.push(`only_ids ${JSON.stringify(unknown)} match no item and were ignored.`);
    return input.items.filter((i) => only.has(i.id));
  }

  private async runItem(item: BatchItem, input: BatchInput, tool: string, gate: RateGate, st: RunState, signal?: AbortSignal): Promise<ItemResult> {
    if (st.stopped) return { id: item.id, ok: false, item, skipped: "stopped" };
    if (signal?.aborted && abortReason(signal) === "deadline") return { id: item.id, ok: false, item, skipped: "deadline" };
    const budget = input.max_total_input_tokens;
    if (budget !== undefined && budget !== null && st.tokens >= budget) return { id: item.id, ok: false, item, skipped: "budget" };
    let redacted = 0;
    const questions = item.questions ?? input.questions ?? {};
    try {
      const call = await this.service.execute(
        { state: item.state, questions, images: item.images, model: (input.pin_model !== false && st.pinned) || input.model, cache: input.cache, cacheTtlMs: input.cacheTtlMs, long_context: input.long_context, max_retries: input.max_retries },
        { tool, signal, gate, retryProfile: "batch", onSend: (n) => (redacted = n) },
      );
      st.tokens += call.cached ? 0 : call.usage.input_tokens;
      st.models.add(call.model);
      // A drifted answer is never pinned: its id is not the pin, so every later item would be refused (break: drift pin).
      if (input.pin_model !== false && st.pinned === null && !call.drifted) st.pinned = call.model;
      return { id: item.id, ok: true, item, call, asked: Object.keys(questions), effectiveQuestions: questions };
    } catch (err) {
      const e = asJevError(err);
      if (input.stop_on_first_error || e.kind === "cancelled" || e.publicKind === "budget_exceeded") st.stopped = true;
      // A request that was sent and then failed still carried its redactions (break: secrets_redacted).
      return { id: item.id, ok: false, item, error: e.toJSON(), ...(redacted > 0 ? { secrets_redacted: redacted } : {}) };
    }
  }
}
