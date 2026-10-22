import { z } from "zod";
import type { JevService } from "../core/JevService.js";
import type { CallResult, Entry } from "../core/types.js";
import { type Action, DecisionPolicy } from "../policy/DecisionPolicy.js";
import { answerOf, sumUsage, type UsageSum } from "./helpers.js";
import { Recipe, type RecipeContext } from "./Recipe.js";
import { commonCallShape, entry } from "../tools/schemas.js";

const shape = {
  claim: z.string().regex(/\S/, "claim is blank").describe("The claim to check, e.g. 'this function is thread-safe'."),
  evidence: entry.describe("Evidence text or object (untrusted). Pass the surrounding section, not just a quote. $file references work."),
  mode: z.enum(["supported", "citation"]).optional().describe('"supported" (two Nouls) or "citation" (cookbook verdicts verified/contradicted/unsupported/fabricated).'),
  quote: z.string().optional().describe("citation mode: the quoted text; if it is not in the evidence (whitespace/curly-quote normalized) the verdict is fabricated with no API call."),
  exact_match_first: z.boolean().optional().describe("supported mode: if the claim appears verbatim (normalized) in the evidence, return supported without an API call."),
  ...commonCallShape,
};

type Args = z.infer<z.ZodObject<typeof shape>>;

/** Collapses whitespace and folds curly quotes (`/cookbooks/citation_check.md`). */
export function normalizeText(text: string): string {
  return text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
}

const WORD = /[\p{L}\p{N}_]/u;

/**
 * True when the normalized phrase occurs in the normalized text without splitting a word or
 * number at either end ("limit is 3" does not match "limit is 30"). A blank phrase never matches.
 */
export function containsPhrase(text: string, phrase: string): boolean {
  const hay = normalizeText(text);
  const needle = normalizeText(phrase);
  if (needle.length === 0) return false;
  const joins = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && WORD.test(a) && WORD.test(b);
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const end = i + needle.length;
    if (!joins(hay[i - 1], needle[0]) && !joins(needle[needle.length - 1], hay[end])) return true;
  }
  return false;
}

function evidenceText(evidence: Entry): string {
  return typeof evidence === "string" ? evidence : JSON.stringify(evidence);
}

/** jev_verify_claim (P1): check a claim against evidence. */
export class VerifyClaimRecipe extends Recipe<typeof shape> {
  readonly name = "verify_claim";
  readonly summary =
    "Check a claim against evidence: supported mode (two Nouls) or citation mode (quote must be present, else fabricated with no call).";
  readonly example = { claim: "the retry limit is 3", evidence: "$file:src/config/defaults.ts#L60-80" };
  readonly schema = shape;

  constructor(private readonly service: JevService) {
    super();
  }

  async run(args: Args, ctx: RecipeContext): Promise<object> {
    // The raw evidence goes to execute(): prepare resolves its refs once (file text that reads
    // like a ref stays text) and keeps the untrusted mark of $log / out-of-root content (probe + cap).
    const evidence = args.evidence as Entry;
    if (args.mode === "citation") return this.citation(args, evidence, ctx);
    if (args.exact_match_first) {
      const local = await this.service.refs.resolveWithMeta(evidence);
      if (containsPhrase(evidenceText(local.value), args.claim)) {
        return { label: "supported", band: local.meta.untrusted ? "confirm" : "auto", exact_match: true, p_supports: null, p_contradicts: null, ...VerifyClaimRecipe.noCall() };
      }
    }
    const p = this.service.config.prompts;
    const call = await this.ask(args, { claim: args.claim, evidence }, {
      supports: { type: "noul", instructions: p.verifySupports },
      contradicts: { type: "noul", instructions: p.verifyContradicts },
    }, ctx);
    const s = answerOf(call, "supports", "noul").noul;
    const c = answerOf(call, "contradicts", "noul").noul;
    const label = this.label(s, c);
    return this.result(call, { label, band: VerifyClaimRecipe.band(label === "uncertain" ? "review" : "auto", call), exact_match: args.exact_match_first ? false : undefined, p_supports: s, p_contradicts: c });
  }

  /** A side wins only when the other side is a confident no; both in or above the mid band is uncertain. */
  label(s: number, c: number): "supported" | "contradicted" | "unsupported" | "uncertain" {
    const b = this.service.config.noulBands;
    if (s >= b.yes_above && c <= b.no_below) return "supported";
    if (c >= b.yes_above && s <= b.no_below) return "contradicted";
    if (s <= b.no_below && c <= b.no_below) return "unsupported";
    return "uncertain";
  }

  private async citation(args: Args, evidence: Entry, ctx: RecipeContext): Promise<object> {
    if (args.quote !== undefined && !normalizeText(evidenceText(await this.service.resolveFiles(evidence))).includes(normalizeText(args.quote))) {
      return { label: "fabricated", band: "auto", exact_match: false, confidence: null, p_supports: null, p_contradicts: null, ...VerifyClaimRecipe.noCall() };
    }
    const p = this.service.config.prompts;
    const call = await this.ask(args, { claim: args.claim, section: evidence }, {
      verdict: { type: "choice", instructions: p.citationInstructions, criteria: p.citationCriteria },
    }, ctx);
    const v = answerOf(call, "verdict", "choice");
    const map: Record<string, string> = { supports: "verified", contradicts: "contradicted", says_nothing: "unsupported" };
    const band = VerifyClaimRecipe.band(v.confidence >= this.service.config.citation.autoAcceptConfidence ? "auto" : "review", call);
    return this.result(call, {
      label: map[v.choice] ?? v.choice,
      band,
      exact_match: args.quote !== undefined ? true : undefined,
      confidence: v.confidence,
      p_supports: v.probabilities.supports ?? null,
      p_contradicts: v.probabilities.contradicts ?? null,
    });
  }

  private ask(args: Args, state: Entry, questions: Record<string, { type: "noul" | "choice"; instructions: Entry; criteria?: Entry }>, ctx: RecipeContext): Promise<CallResult> {
    return this.service.execute(
      { state, questions, cache: args.cache },
      { tool: this.tool, signal: ctx.signal },
    );
  }

  /** The DecisionPolicy cap: model drift or untrusted evidence caps auto at confirm; a likely injection is review. */
  private static band(raw: Action, call: CallResult): Action {
    const d = { action: raw, verdict: null, p: null, metric: "verify_claim", reason: "" };
    return DecisionPolicy.cap(d, { untrusted: call.untrusted, drifted: call.drifted, injectionP: call.injection_p }).action;
  }

  /** Fast paths answer locally: no model ran and nothing was spent (fits the jev_ask outputSchema). */
  private static noCall(): { model: null; usage: UsageSum } {
    return { model: null, usage: sumUsage([]) };
  }

  private result(call: CallResult, fields: Record<string, unknown>): object {
    return { ...fields, model: call.model, usage: sumUsage([call]), request_id: call.request_id, cached: call.cached, warnings: call.warnings };
  }
}
