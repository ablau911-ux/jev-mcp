import type { JevConfig } from "../config/types.js";
import type { Entry, WireRequest } from "../core/types.js";
import { TokenEstimator } from "./TokenEstimator.js";

export interface BodyReport {
  errors: string[];
  warnings: string[];
  bodyBytes: number;
  estTokens: number;
  /** Whether to send the long-context header (true, or "auto" over the normal limits). */
  longContext: boolean;
}

/**
 * Pre-flight size rules on the final wire body (`/api/errors.md`, `/models.md`): body at most
 * 32 MiB (multipart parts included), at most 32k tokens per question (state + that question)
 * and 64k per request (state + all questions), estimated with the probe-measured factors.
 * Over the limits it refuses before sending; `long_context: "auto"` switches to the 262k
 * long-context header instead.
 */
export class ContextBudget {
  private readonly estimator: TokenEstimator;

  constructor(private readonly config: JevConfig) {
    this.estimator = new TokenEstimator(config.context.charsPerToken);
  }

  check(body: WireRequest, longContext: boolean | "auto" | undefined, partBytes = 0): BodyReport {
    const bodyBytes = Buffer.byteLength(JSON.stringify(body), "utf8") + partBytes;
    const errors: string[] = [];
    if (bodyBytes > this.config.limits.bodyBytes) errors.push(`$: request body is ${bodyBytes} bytes; the limit is ${this.config.limits.bodyBytes} (413).`);
    const stateTokens = this.estimator.estimate(body.state);
    const perQ = Object.values(body.questions).map((q) => this.estimator.estimate(q as unknown as Entry));
    const estTokens = stateTokens + perQ.reduce((a, b) => a + b, 0);
    const maxQuestion = stateTokens + Math.max(0, ...perQ);
    const c = this.config.context;
    const over = estTokens > c.perRequestTokens || maxQuestion > c.perQuestionTokens;
    const useLong = longContext === true || (longContext === "auto" && over);
    const warnings: string[] = [];
    const limitReq = useLong ? c.longContextTokens : c.perRequestTokens;
    const limitQ = useLong ? c.longContextTokens : c.perQuestionTokens;
    if (estTokens > limitReq || maxQuestion > limitQ) {
      errors.push(`$.state: estimated ~${estTokens} tokens per request / ~${maxQuestion} per question exceed ${limitReq}/${limitQ}. Trim state (line ranges, $diff hunks, $log tail) or split into jev_batch items.`);
    } else if (estTokens >= limitReq * c.warnFraction || maxQuestion >= limitQ * c.warnFraction) {
      warnings.push(`Estimated ~${estTokens} tokens is near the ${limitReq} limit; images not counted.`);
    }
    if (useLong && longContext === "auto") warnings.push("Over the 64k/32k limits: sent with the long-context header (slower, less accurate).");
    return { errors, warnings, bodyBytes, estTokens, longContext: useLong };
  }

  estimate(value: unknown): number {
    return this.estimator.estimate(value);
  }
}
