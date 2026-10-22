import { z } from "zod";
import type { ProcessGuard } from "../app/ProcessGuard.js";
import type { ResponseCache } from "../cache/ResponseCache.js";
import type { JevConfig } from "../config/types.js";
import { asJevError, JevError } from "../core/JevError.js";
import type { JevService } from "../core/JevService.js";
import type { SessionLimiter } from "../core/SessionLimiter.js";
import type { Questions } from "../core/types.js";
import type { PathGuard } from "../files/PathGuard.js";
import { DecisionPolicy } from "../policy/DecisionPolicy.js";
import type { KeyProvider } from "../security/KeyProvider.js";
import type { CalibrationService } from "../status/CalibrationService.js";
import type { HealthCheck } from "../status/HealthCheck.js";
import type { ModelCatalog } from "../status/ModelCatalog.js";
import type { UsageLedger } from "../usage/UsageLedger.js";
import type { ArgumentGuard } from "./ArgumentGuard.js";
import { JevTool, type ToolContext } from "./JevTool.js";
import { askInputShape, entry, errorOutputSchema, parseAskRequest } from "./schemas.js";

const ACTIONS = ["health", "usage", "models", "validate", "presets", "feedback", "calibrate"] as const;

const shape = {
  action: z.enum(ACTIONS).optional().describe("health (default) | usage | models | validate | presets | feedback | calibrate."),
  request: z.record(z.string(), entry).optional().describe("validate: a jev_ask input {state, questions, images?}; checked offline, nothing sent."),
  id: z.string().optional().describe("feedback: a decision id from a result (id, or id.<question>)."),
  label: z.boolean().optional().describe("feedback: true when the verdict was right."),
  preset: z.string().optional().describe("calibrate: only this preset."),
  seed_git: z.boolean().optional().describe("calibrate: first seed eval cases from git history (fix-test commits)."),
  refresh: z.boolean().optional().describe("health/models: check again now."),
  reset: z.boolean().optional().describe("usage: clear the session counters after reporting."),
};

type Args = z.infer<z.ZodObject<typeof shape>>;

/** Arguments whose values are content: `validate` masks secrets in the request. */
const CONTENT_ARGS: ReadonlySet<string> = new Set(["request"]);
/** A validate request is a jev_ask input (raw questions, no recipe); nothing else reaches the preparer. */
const REQUEST_FIELDS = Object.keys(askInputShape);

export interface StatusDeps {
  service: JevService;
  ledger: UsageLedger;
  limiter: SessionLimiter;
  keys: KeyProvider;
  config: JevConfig;
  cache: ResponseCache;
  health: HealthCheck;
  catalog: ModelCatalog;
  calibration: CalibrationService;
  processGuard: ProcessGuard;
  guard: PathGuard;
  argGuard: ArgumentGuard;
}

/** jev_status: health, usage, models, offline validation, presets, feedback and calibration. */
export class StatusTool extends JevTool<typeof shape> {
  readonly name = "jev_status";
  readonly title = "Jev health, usage and models";
  readonly description =
    "Jev health and housekeeping, no judgments: health (is Jev reachable, which models are pinned), usage (tokens, cost estimate, caps, estimate/actual ratio), models (aliases and versions), validate (offline dry run of a jev_ask input), presets (decision thresholds), feedback (label a past decision), calibrate (fit thresholds from labels). Free except health/models refresh (one GET).";
  readonly schema = shape;
  // Each action returns its own shape (health, usage, models, validate, ...), so the declared
  // output is a loose object: `action` is present on every success, the rest depends on the
  // action; a failed call carries only `{error}` (break hunt 1).
  readonly outputSchema = z.looseObject({ action: z.string().optional(), ok: z.boolean().optional(), error: errorOutputSchema.optional() });

  constructor(private readonly d: StatusDeps) {
    super();
  }

  async run(args: Args, ctx: ToolContext): Promise<object> {
    this.d.argGuard.check(args, CONTENT_ARGS, Object.keys(shape));
    const action = args.action ?? "health";
    return { action, ...(await this.dispatch(action, args, ctx)) };
  }

  private async dispatch(action: (typeof ACTIONS)[number], args: Args, ctx: ToolContext): Promise<object> {
    switch (action) {
      case "health":
        return this.health(args.refresh === true);
      case "usage":
        return this.usage(args.reset === true);
      case "models":
        return this.d.catalog.report(args.refresh === true, ctx.signal);
      case "validate":
        return this.validate(args.request);
      case "presets":
        return { default: this.d.config.defaultPreset, presets: this.d.config.presets };
      case "feedback":
        return this.d.calibration.feedback(args.id, args.label);
      case "calibrate":
        return this.d.calibration.calibrate(args.preset, args.seed_git === true, await this.d.guard.primaryRoot());
    }
  }

  private async health(refresh: boolean): Promise<object> {
    const result = refresh || !this.d.health.result.checked_at ? await this.d.health.run() : this.d.health.result;
    const usage = this.d.ledger.snapshot();
    // A failed check is stale once Jev answers a later call (break hunt 1: one startup blip
    // said "unavailable" for the whole session while hundreds of calls succeeded).
    const answered = this.d.ledger.lastAnsweredAt;
    const stale = !result.ok && result.checked_at !== null && answered !== null && answered > Date.parse(result.checked_at);
    const failing = this.failingSince(result.checked_at);
    const ok = (result.ok || stale) && failing === null;
    return {
      ok,
      check: result,
      ...(failing !== null ? { note: failing } : stale ? { note: "The last health check failed, but Jev answered a call after it." } : {}),
      backend: this.d.config.backend,
      key_source: this.d.keys.source(),
      models: this.d.service.models.features,
      images: this.d.config.images.enabled,
      secret_guard: this.d.config.secretGuard.mode,
      session: { requests: usage.requests, input_tokens: usage.input_tokens, est_cost_usd: usage.est_cost_usd, estimate_ratio: usage.estimate_ratio },
      unhandled_rejections: this.d.processGuard.unhandledRejections,
      fallback: ok ? undefined : "Jev is unavailable: judge inline; do not retry in a loop.",
    };
  }

  /**
   * The reverse case (break hunt 1): a passing check stays ok:true while every later call fails
   * (a rotated key, an outage). health.failStreak upstream failures in a row after the check turn it false.
   */
  private failingSince(checkedAt: string | null): string | null {
    const f = this.d.ledger.failureStreak;
    if (f.count < this.d.config.health.failStreak || f.at === null || (checkedAt !== null && f.at <= Date.parse(checkedAt))) return null;
    return `The last health check passed, but the last ${f.count} calls in a row failed (${f.kind}).`;
  }

  private usage(reset: boolean): object {
    const session = this.d.ledger.snapshot();
    if (reset) this.d.ledger.reset();
    return { session, limits: this.d.limiter.snapshot(), cache: { entries: this.d.cache.size, disk: this.d.cache.diskEnabled }, reset };
  }

  private async validate(request: Record<string, unknown> | undefined): Promise<object> {
    if (!request) {
      const e = JevError.invalid("$.request: required for validate.", undefined, 'Pass request: {state, questions} (a jev_ask input); nothing is sent.', "$.request");
      return { ok: false, valid: false, error: e.toJSON(), errors: [e.message], fix: e.fix };
    }
    try {
      this.d.argGuard.check(request, new Set(REQUEST_FIELDS), REQUEST_FIELDS);
      const input = parseAskRequest(request);
      if (input.preset !== undefined) new DecisionPolicy(this.d.config).preset(input.preset);
      const p = await this.d.service.prepare({ state: input.state as never, questions: input.questions as Questions, images: input.images as never, long_context: input.long_context });
      return { ok: true, valid: true, warnings: p.warnings, model: p.model, est_tokens: p.estTokens, body_bytes: p.bodyBytes, questions: Object.keys(p.wire.questions).length, images: p.images.length, long_context: p.longContext, secrets_redacted: p.secretsRedacted };
    } catch (err) {
      const e = asJevError(err);
      return { ok: false, valid: false, error: e.toJSON(), errors: Array.isArray(e.detail) ? e.detail : [e.message], fix: e.fix };
    }
  }
}
