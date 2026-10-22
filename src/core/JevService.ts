import { randomUUID } from "node:crypto";
import { textHash } from "../calibration/AutoLabeler.js";
import type { NoiseBand } from "../cache/NoiseBand.js";
import type { ResponseCache } from "../cache/ResponseCache.js";
import type { JevConfig, RetrySettings } from "../config/types.js";
import type { SafeLogger } from "../logging/SafeLogger.js";
import type { ModelRegistry } from "../models/ModelRegistry.js";
import type { RefResolver } from "../refs/RefResolver.js";
import type { JevTransport } from "../transport/JevTransport.js";
import type { UsageLedger } from "../usage/UsageLedger.js";
import { Deadline } from "./Deadline.js";
import { EntryWalker } from "./EntryWalker.js";
import { InjectionGuard } from "./InjectionGuard.js";
import { JevError } from "./JevError.js";
import type { RateGate } from "./RateGate.js";
import type { AskInput, Prepared, RequestPreparer } from "./RequestPreparer.js";
import { ResponseParser } from "./ResponseParser.js";
import type { Retrier } from "./Retrier.js";
import type { SessionLimiter } from "./SessionLimiter.js";
import type { CallResult, Entry, ParsedResponse, Usage } from "./types.js";

export type { AskInput, Prepared } from "./RequestPreparer.js";

export interface CallContext {
  tool: string;
  signal?: AbortSignal;
  gate?: RateGate;
  retryProfile?: "single" | "batch";
  /** Called once right before the request is sent, with its redaction count (a failed item still reports it). */
  onSend?: (secretsRedacted: number) => void;
  /** Test-only: skip local validation to reach server-side errors. */
  bypassValidation?: boolean;
}

/** The call's one total deadline, shared by every send of the call. */
interface Budget {
  totalMs: number;
  /** Epoch ms when the deadline ends. */
  deadlineAt: number;
  signal: AbortSignal;
}

export interface ServiceDeps {
  config: JevConfig;
  transport: JevTransport;
  preparer: RequestPreparer;
  refs: RefResolver;
  cache: ResponseCache;
  noise: NoiseBand;
  models: ModelRegistry;
  ledger: UsageLedger;
  limiter: SessionLimiter;
  retrier: Retrier;
  logger: SafeLogger;
}

/**
 * The shared request pipeline used by every tool and recipe: prepare (offline checks), cache,
 * session caps, retries inside a total deadline, response parsing, model drift tracking and
 * the usage ledger.
 */
export class JevService {
  private readonly parser = new ResponseParser();
  /** The session-wide gate (owned by BatchRunner); calls that bring no gate of their own wait in it too. */
  private sessionGate: RateGate | undefined;

  constructor(private readonly d: ServiceDeps) {
    d.models.onDrift((alias, previous, next) => {
      const purged = d.cache.purgeNamespace(previous);
      d.logger.warn(`model drift: ${alias} now answers as ${next} (was ${previous}); purged ${purged} cache entries.`);
    });
  }

  get config(): JevConfig {
    return this.d.config;
  }

  get models(): ModelRegistry {
    return this.d.models;
  }

  get refs(): RefResolver {
    return this.d.refs;
  }

  /**
   * Shares the session RateGate with every call (jev_ask, recipes): a 429 pause is per
   * organization, so a single call must not send into a pause a batch just received.
   */
  useSessionGate(gate: RateGate): void {
    this.sessionGate = gate;
  }

  resolveFiles(value: Entry): Promise<Entry> {
    return this.d.refs.resolve(value);
  }

  prepare(input: AskInput, bypassValidation = false): Promise<Prepared> {
    return this.d.preparer.prepare(input, bypassValidation);
  }

  async execute(input: AskInput, ctx: CallContext): Promise<CallResult> {
    const p = await this.prepare(input, ctx.bypassValidation);
    const clientId = randomUUID();
    // Mock placeholders never enter (or come from) the cache a real backend reads, disk entries included.
    const useCache = input.cache !== false && this.d.config.cache.enabled && this.d.config.backend !== "mock";
    const hit = useCache ? this.d.cache.get(p.cacheKey, input.cacheTtlMs) : null;
    if (hit) {
      // Cached wire answers may be presented under a different policy. Each presentation
      // owns its decisions and feedback, independently of the original paid call.
      this.d.ledger.record({ ...this.usageOf(hit.response), tool: ctx.tool, model: hit.response.model, latency_ms: 0, request_id: hit.requestId, client_id: clientId, est_tokens: p.estTokens, cached: true });
      return this.toResult(hit.response, hit.requestId, 0, true, p, clientId, false);
    }
    this.d.limiter.admit(p.estTokens);
    try {
      return await this.sendAdmitted(p, input, ctx, clientId, useCache);
    } finally {
      this.d.limiter.release(p.estTokens);
    }
  }

  private async sendAdmitted(p: Prepared, input: AskInput, ctx: CallContext, clientId: string, useCache: boolean): Promise<CallResult> {
    const totalMs = this.callTotalMs(p, input, ctx);
    const deadlineAt = Date.now() + totalMs;
    let started = 0;
    // One total deadline for the whole call: the tokens/s wait, retries and the long-context fallback.
    const { response, requestId, cacheKey } = await Deadline.race(totalMs, ctx.signal, async (signal) => {
      await this.d.limiter.throttle(p.estTokens, signal, deadlineAt - Date.now());
      started = Date.now();
      ctx.onSend?.(p.secretsRedacted);
      return this.sendWithFallback(p, input, ctx, clientId, { totalMs, deadlineAt, signal });
    });
    const latency = Date.now() - started;
    const drift = this.d.models.observe(p.model, response.model);
    if (useCache && !drift.drifted && JevService.complete(p, response) && this.d.noise.cacheable(response.answers)) this.d.cache.set(cacheKey, { response, requestId, clientId }, input.cacheTtlMs);
    return this.toResult(response, requestId, latency, false, p, clientId, drift.drifted);
  }

  /** Counts billed tokens in the session caps and the usage ledger. */
  private charge(usage: Usage, model: string, latency: number, requestId: string | null, tool: string, clientId: string, p: Prepared): void {
    try {
      this.d.limiter.record(usage.input_tokens);
    } finally {
      // Daily persistence may fail closed, but cannot erase an already billed response.
      this.d.ledger.record({ input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, tool, model, latency_ms: latency, request_id: requestId, client_id: clientId, est_tokens: p.estTokens, cached: false });
    }
  }

  /** A 2xx body that fails the shape check was still billed: charge its usage, then fail. */
  private parseBilled(res: { data: unknown; requestId: string | null }, p: Prepared, tool: string, clientId: string, started: number): ParsedResponse {
    try {
      return this.parser.parse(res.data, res.requestId, p.wire.questions);
    } catch (err) {
      const billed = this.parser.billed(res.data);
      if (billed) this.charge(billed.usage, billed.model ?? p.model, Date.now() - started, res.requestId, tool, clientId, p);
      throw err;
    }
  }

  async listModels(signal?: AbortSignal): Promise<unknown> {
    const cfg = this.d.config;
    return Deadline.race(this.totalMs(cfg.timeouts.totalMs), signal, (s) =>
      this.d.retrier.run(async () => (await this.d.transport.listModels({ headers: {}, signal: s, timeoutMs: cfg.timeouts.attemptMs })).data, { policy: cfg.retry.single, signal: s }),
    );
  }

  /** Total deadline, fitted inside MCP_TOOL_TIMEOUT (minus a margin) when the user set one. */
  totalMs(base: number): number {
    const t = this.d.config.timeouts;
    return t.mcpToolTimeoutMs === null ? base : Math.max(1_000, Math.min(base, t.mcpToolTimeoutMs - t.mcpMarginMs));
  }

  /**
   * The call's total deadline, fitted inside MCP_TOOL_TIMEOUT. It covers the whole call; a
   * long-context call (or an "auto" one that may fall back to it) gets the long-context attempt time.
   */
  private callTotalMs(p: Prepared, input: AskInput, ctx: CallContext): number {
    const t = this.d.config.timeouts;
    const attemptMs = p.longContext || input.long_context === "auto" ? t.longContextAttemptMs : (input.timeout_ms ?? t.attemptMs);
    return this.totalMs(Math.max(ctx.retryProfile === "batch" ? t.batchTotalMs : t.totalMs, attemptMs));
  }

  /**
   * long_context "auto": one resend with the header when the server still says max_tokens_exceeded,
   * inside the same deadline. Also returns the cache key of the mode actually used, so a
   * long-context answer never sits under the normal key.
   */
  private async sendWithFallback(p: Prepared, input: AskInput, ctx: CallContext, clientId: string, budget: Budget) {
    try {
      return { ...(await this.send(p, input, ctx, clientId, budget)), cacheKey: p.cacheKey };
    } catch (err) {
      if (input.long_context !== "auto" || p.longContext || !(err instanceof JevError) || err.kind !== "context_too_long") throw err;
      this.d.limiter.admitResend();
      p.warnings.push("Context too long; resent once with the long-context header (slower, less accurate).");
      return { ...(await this.send({ ...p, longContext: true }, input, ctx, clientId, budget)), cacheKey: p.longCacheKey };
    }
  }

  private async send(p: Prepared, input: AskInput, ctx: CallContext, clientId: string, budget: Budget) {
    const cfg = this.d.config;
    const headers: Record<string, string> = {};
    if (p.needsImagesHeader) headers["TypeSafe-Danger-Zone-Images"] = "true";
    if (p.longContext) headers["TypeSafe-Danger-Zone-Long-Context"] = "true";
    const attemptMs = p.longContext ? cfg.timeouts.longContextAttemptMs : (input.timeout_ms ?? cfg.timeouts.attemptMs);
    const { signal, totalMs, deadlineAt } = budget;
    const started = Date.now();
    try {
      const res = await this.d.retrier.run(() => this.d.transport.systemOne(p.wire, { headers, signal, timeoutMs: Math.min(attemptMs, totalMs) }), {
        policy: this.policy(ctx, input),
        signal,
        gate: ctx.gate ?? this.sessionGate,
        deadlineAt,
        onRetry: (e, n, ms) => this.d.logger.info(`${ctx.tool}: retry ${n} in ${ms} ms after ${e.kind}${e.status ? ` ${e.status}` : ""} (resends the request)`),
      });
      const response = this.parseBilled(res, p, ctx.tool, clientId, started);
      // Billing follows the completed transport, even when Deadline.race already
      // returned cancellation to its caller. This is the successful 2xx charge site.
      this.charge(response.usage, response.model, Date.now() - started, res.requestId, ctx.tool, clientId, p);
      this.logRequest(ctx.tool, p, "ok", started, response.usage.input_tokens, res.requestId);
      return { response, requestId: res.requestId };
    } catch (err) {
      this.logRequest(ctx.tool, p, err instanceof JevError ? err.kind : "error", started, undefined, err instanceof JevError ? err.requestId : null);
      // The key or the service failed (not the input): health reports a streak of these (break hunt 1).
      if (err instanceof JevError && (err.publicKind === "auth" || err.publicKind === "unavailable")) this.d.ledger.recordFailure(err.kind);
      throw err;
    }
  }

  private policy(ctx: CallContext, input: AskInput): RetrySettings {
    const base = ctx.retryProfile === "batch" ? this.d.config.retry.batch : this.d.config.retry.single;
    return input.max_retries === undefined ? base : { ...base, maxRetries: input.max_retries };
  }

  private logRequest(tool: string, p: Prepared, status: string, started: number, tokens?: number, requestId?: string | null): void {
    this.d.logger.request({ tool, model: p.model, questions: Object.keys(p.wire.questions).length, status, latency_ms: Date.now() - started, input_tokens: tokens, request_id: requestId ?? null });
  }

  /** Every asked question came back answered; a partial response is never cached (asked fresh next time). */
  private static complete(p: Prepared, r: ParsedResponse): boolean {
    return Object.keys(p.wire.questions).every((id) => Object.hasOwn(r.answers, id));
  }

  private usageOf(r: ParsedResponse) {
    return { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens };
  }

  private toResult(r: ParsedResponse, requestId: string | null, latency: number, cached: boolean, p: Prepared, clientId: string, drifted: boolean): CallResult {
    const split = InjectionGuard.split(r.answers, p.probes);
    const warnings = [...p.warnings, ...r.warnings];
    if (this.d.config.backend === "mock") warnings.push("MOCK backend (JEV_BACKEND=mock): answers are placeholders, not judgments.");
    if (drifted) warnings.push(`Model drift: ${p.model} answered as ${r.model}; decisions capped at confirm.`);
    return {
      content_hash: JevService.contentHash(p),
      model: r.model,
      answers: split.answers,
      usage: { ...r.usage, est_cost_usd: cached ? 0 : this.d.ledger.estimateCost(r.usage.input_tokens) },
      request_id: requestId,
      latency_ms: latency,
      cached,
      warnings,
      images: p.images,
      client_id: clientId,
      est_tokens: p.estTokens,
      drifted,
      untrusted: p.untrusted,
      injection_p: split.probeP,
      secrets_redacted: p.secretsRedacted,
      model_overridden: p.modelOverridden,
    };
  }

  /** Image transport UUIDs change per preparation; normalize them back to stable image names. */
  private static contentHash(p: Prepared): string {
    // AssetPacker emits assets in the same order as its inspected images.
    const refs = Object.keys(p.wire.assets ?? {});
    const input = EntryWalker.mapRequestStrings(p.wire.state, p.wire.questions, (value) => {
      for (let i = 0; i < refs.length; i++) value = value.split(refs[i]!).join(p.images[i]!.name);
      return value;
    });
    return textHash(EntryWalker.canonical({
      ...input,
      images: Object.fromEntries(p.images.map((image) => [image.name, image.sha256])),
    }));
  }
}
