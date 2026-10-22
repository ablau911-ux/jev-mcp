import type { AssetPacker } from "../assets/AssetPacker.js";
import type { ResponseCache } from "../cache/ResponseCache.js";
import type { Feature, JevConfig } from "../config/types.js";
import type { ModelRegistry } from "../models/ModelRegistry.js";
import { RefResolver } from "../refs/RefResolver.js";
import type { KeyProvider } from "../security/KeyProvider.js";
import type { OutboundSanitizer } from "../security/OutboundSanitizer.js";
import type { ContextBudget } from "../validation/ContextBudget.js";
import type { RequestValidator } from "../validation/RequestValidator.js";
import { SecretGuard } from "../validation/SecretGuard.js";
import type { InjectionGuard } from "./InjectionGuard.js";
import { JevError } from "./JevError.js";
import { QuestionSet } from "./QuestionSet.js";
import type { Entry, ImageInfo, ImageSpec, Questions, WireRequest } from "./types.js";

/** Bytes of multipart framing per image part (boundary + headers), an upper estimate. */
const MULTIPART_PART_OVERHEAD = 256;

export interface AskInput {
  state: Entry;
  questions: Questions;
  /** How many of `questions` the server generated (reorder copies); counted toward the wire limit. */
  generated?: number;
  images?: Record<string, ImageSpec>;
  model?: string;
  feature?: Feature;
  long_context?: boolean | "auto";
  cache?: boolean;
  /** Shorter cache lifetime (gate preset: 5 min). */
  cacheTtlMs?: number;
  timeout_ms?: number;
  max_retries?: number;
}

export interface Prepared {
  model: string;
  namespace: string;
  wire: WireRequest;
  images: ImageInfo[];
  needsImagesHeader: boolean;
  longContext: boolean;
  warnings: string[];
  cacheKey: string;
  /** Key of the same request sent with the long-context header (the long_context "auto" fallback caches here). */
  longCacheKey: string;
  bodyBytes: number;
  estTokens: number;
  untrusted: boolean;
  /** Ids of the injection probes added to this request (only these answers are read as probes). */
  probes: string[];
  /** Secrets masked before sending (count only; values never reported). */
  secretsRedacted: number;
  /** The pin came from config `models.override`. */
  modelOverridden: boolean;
}

export interface PreparerDeps {
  config: JevConfig;
  models: ModelRegistry;
  refs: RefResolver;
  secrets: SecretGuard;
  outbound: OutboundSanitizer;
  validator: RequestValidator;
  injection: InjectionGuard;
  packer: AssetPacker;
  budget: ContextBudget;
  cache: ResponseCache;
  keys: KeyProvider;
}

/**
 * Turns an agent request into a checked wire request, entirely offline: depth, refs, secret
 * guard (refuse or redact, keys included), documented request rules, injection probes, image
 * packing, the outbound sanitizer on the complete payload (generated probe text, model,
 * labels), size and context budget, and the namespaced cache key. Throws `invalid_input`
 * listing every problem. GuardedTransport runs the sanitizer again right before sending.
 */
export class RequestPreparer {
  constructor(private readonly d: PreparerDeps) {}

  async prepare(input: AskInput, bypassValidation = false): Promise<Prepared> {
    // The budget and the secret guard walk the questions map before the validator runs: a missing one is refused first.
    const asked: unknown = input.questions;
    if (typeof asked !== "object" || asked === null || Array.isArray(asked) || Object.keys(asked).length === 0) throw RequestPreparer.invalid(["$.questions: at least one question is required."]);
    // questions -> name -> instructions/criteria tree: two levels above the per-tree limit.
    RefResolver.checkDepth(input.questions, this.d.config.limits.maxNesting + 2, "$.questions");
    const hasBox = Object.values(input.questions ?? {}).some((q) => q?.type === "box");
    const feature = input.feature ?? (hasBox ? "locate" : "text");
    const model = this.d.models.forFeature(feature, input.model);
    this.d.keys.prime();
    const resolved = await this.d.refs.resolveWithMeta(input.state);
    // An oversized body is refused before the secret guard spends its decode budget on it.
    const early = this.d.budget.check({ model, state: resolved.value, questions: input.questions }, input.long_context);
    if (early.errors.length > 0 && !bypassValidation) throw RequestPreparer.tooLarge(early.errors);
    const redacted = this.d.secrets.redact(resolved.value, input.questions);
    SecretGuard.refuseEncodedLive(redacted.counts);
    const warnings: string[] = [];
    const report = this.d.validator.validate(model, redacted.state, redacted.questions);
    if (report.errors.length > 0 && !bypassValidation) throw RequestPreparer.invalid(report.errors);
    this.checkImages(input, hasBox);
    const plan = this.d.injection.plan(redacted.state, resolved.meta.untrusted, Object.keys(input.images ?? {}));
    const questions = QuestionSet.merge(redacted.questions, plan.probes);
    QuestionSet.checkWire(questions, (input.generated ?? 0) + Object.keys(plan.probes).length, this.d.config.limits.questionsPerState);
    const packed = await this.d.packer.pack({ state: plan.state, questions, images: input.images });
    const draft: WireRequest = { model, state: packed.state, questions: packed.questions };
    if (packed.assets) draft.assets = packed.assets;
    const clean = this.d.outbound.sanitize(draft);
    const wire = clean.wire;
    const secretsRedacted = redacted.total + clean.total;
    const partBytes = packed.images.reduce((a, i) => a + i.bytes.length + MULTIPART_PART_OVERHEAD, 0);
    if (secretsRedacted > 0) warnings.push(`Secret guard redacted ${secretsRedacted} secret(s): ${[...new Set([...Object.keys(redacted.counts), ...Object.keys(clean.counts)])].join(", ")}.`);
    const body = this.d.budget.check(wire, input.long_context, partBytes);
    if (body.errors.length > 0 && !bypassValidation) throw RequestPreparer.tooLarge(body.errors);
    const namespace = this.d.models.namespace(model);
    const keyParts = { namespace, state: redacted.state, questions, imageHashes: Object.fromEntries(packed.images.map((i) => [i.name, i.sha256])) };
    const cacheKey = this.d.cache.key({ ...keyParts, longContext: body.longContext });
    const longCacheKey = body.longContext ? cacheKey : this.d.cache.key({ ...keyParts, longContext: true });
    return {
      model, namespace, wire, images: packed.images, needsImagesHeader: packed.needsImagesHeader, longContext: body.longContext,
      warnings: [...warnings, ...report.warnings, ...packed.warnings, ...body.warnings], cacheKey, longCacheKey, bodyBytes: body.bodyBytes, estTokens: body.estTokens, untrusted: plan.fields.length > 0, probes: Object.keys(plan.probes), secretsRedacted,
      modelOverridden: this.d.models.overridden(feature),
    };
  }

  private checkImages(input: AskInput, hasBox: boolean): void {
    if (this.d.config.images.enabled) return;
    if (hasBox || Object.keys(input.images ?? {}).length > 0) {
      throw JevError.invalid("Images and box questions are off.", undefined, "Images are experimental; the user enables them with JEV_IMAGES=1. Judge the image yourself instead.");
    }
  }

  static tooLarge(errors: string[]): JevError {
    return new JevError({ kind: "too_large", message: errors.join(" | "), detail: errors, fix: "Trim state (line ranges, $diff hunks, $log tail) or split it into jev_batch items; nothing was sent.", loc: "$.state" });
  }

  static invalid(errors: string[]): JevError {
    const loc = /^(\$[^:\s]*)/.exec(errors[0] ?? "")?.[1];
    return JevError.invalid(`Request failed local validation: ${errors.join(" | ")}`, errors, "Fix the listed fields; nothing was sent to the API.", loc);
  }
}
