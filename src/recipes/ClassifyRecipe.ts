import { z } from "zod";
import { AnswerDeriver } from "../core/AnswerDeriver.js";
import { ChoiceChunker, fill } from "../core/ChoiceChunker.js";
import { JevError } from "../core/JevError.js";
import type { JevService } from "../core/JevService.js";
import type { Entry, Questions } from "../core/types.js";
import { WireLabels } from "../policy/WireLabels.js";
import { permutations, sumUsage, warningsOf } from "./helpers.js";
import { Recipe, type RecipeContext } from "./Recipe.js";
import { commonCallShape, entry, imagesSchema, stateSchema } from "../tools/schemas.js";

const shape = {
  state: stateSchema,
  options: z.record(z.string(), entry).describe("label -> description (string/object/null). Describe what each option MEANS; make them mutually exclusive."),
  instructions: entry.optional().describe("The question, e.g. 'Which category fits `ticket.text`?'"),
  none_option: z.enum(["off", "noul", "label"]).optional().describe('"noul": add a paired Noul "does any option apply?"; "label": add a literal none option. Default off.'),
  order_check: z.number().int().min(0).max(4).optional().describe("Ask k extra copies with permuted option order in the same request (first-option bias check)."),
  overflow: z.enum(["error", "chunk_rerank"]).optional().describe('Over 255 options: "chunk_rerank" chunks into 200s and reranks winners (2 requests). Default error.'),
  images: imagesSchema.optional(),
  verbosity: z.enum(["compact", "full"]).optional(),
  ...commonCallShape,
};

type Args = z.infer<z.ZodObject<typeof shape>>;

/** jev_classify (P1): Choice shortcut with none-of-the-above, order check and overflow. */
export class ClassifyRecipe extends Recipe<typeof shape> {
  readonly name = "classify";
  readonly summary =
    "Pick one label (Choice) with safeguards: none_option, order_check (reversed copies, opt-in: the probe found no first-option bias on clear 2-option cases), chunked overflow above 255 options.";
  readonly example = { state: "$log:test.log", options: { my_change: "Caused by the current diff", preexisting: "Failed before this change", env_infra: "Environment or infrastructure", timing: "Timing or ordering", test_bug: "The test itself is wrong" }, none_option: "noul" };
  readonly schema = shape;

  constructor(private readonly service: JevService) {
    super();
  }

  async run(args: Args, ctx: RecipeContext): Promise<object> {
    const cfg = this.service.config;
    const options: Record<string, Entry> = { ...(args.options as Record<string, Entry>) };
    if (args.none_option === "label" && !(cfg.prompts.noneLabel in options)) options[cfg.prompts.noneLabel] = cfg.prompts.noneDescription;
    const labels = Object.keys(options);
    const warnings: string[] = [];
    const chunked = labels.length > cfg.limits.choiceMax;
    if (chunked && args.overflow !== "chunk_rerank") {
      throw JevError.invalid(`${labels.length} options exceed ${cfg.limits.choiceMax}; pass overflow: "chunk_rerank".`);
    }
    if (labels.length > cfg.classify.warnAbove) warnings.push(`${labels.length} options: reliability reported only up to ~${cfg.classify.warnAbove}.`);
    const asked = chunked ? 0 : Math.min(args.order_check ?? 0, cfg.classify.maxOrderChecks);
    if (chunked && (args.order_check ?? 0) > 0) warnings.push("order_check skipped when options are chunked.");
    const orders = permutations(labels, asked);
    if (orders.length < asked) warnings.push(`order_check ${asked}: only ${orders.length} distinct permuted option order(s) exist for ${labels.length} options; sent ${orders.length}.`);
    // Order copies need wire names that keep their order (integer-like labels get an alias).
    const names = new WireLabels(orders.length > 0 ? labels : [], cfg.prompts.indexLabelAlias);
    const extra = this.extraQuestions(args, options, labels, orders, names);
    const chunker = new ChoiceChunker(this.service, chunked ? cfg.classify.chunkSize : cfg.limits.choiceMax);
    const res = await chunker.run(
      { state: args.state, options: names.criteria(labels, options), instructions: args.instructions, extraQuestions: extra, images: args.images, cache: args.cache },
      { tool: this.tool, signal: ctx.signal },
    );
    return this.output(args, res, orders.length, names, warnings);
  }

  private extraQuestions(args: Args, options: Record<string, Entry>, labels: string[], orders: string[][], names: WireLabels): Questions {
    const q: Questions = {};
    if (args.none_option === "noul") {
      q.any_applies = { type: "noul", instructions: fill(this.service.config.prompts.anyOptionApplies, { options: labels.map((l) => names.wire(l)).join(", ") }) };
    }
    orders.forEach((order, i) => {
      const criteria = names.criteria(order, options);
      q[`order_${i + 1}`] = { type: "choice", criteria, ...(args.instructions !== undefined ? { instructions: args.instructions } : {}) };
    });
    return q;
  }

  private output(args: Args, res: Awaited<ReturnType<ChoiceChunker["run"]>>, k: number, names: WireLabels, warnings: string[]): object {
    const a = names.answer(res.answer);
    const out: Record<string, unknown> = {
      choice: a.choice,
      confidence: a.confidence,
      probabilities: args.verbosity === "full" ? a.probabilities : AnswerDeriver.topK(a.probabilities, 5),
      top2_ratio: AnswerDeriver.top2Ratio(a.probabilities),
      model: res.calls[res.calls.length - 1]?.model,
      usage: sumUsage(res.calls),
      request_ids: res.calls.map((c) => c.request_id),
    };
    const any = res.extra.any_applies;
    if (any?.type === "noul") {
      out.none_applies = 1 - any.noul;
      out.any_option_applies = any.noul;
    }
    if (k > 0) {
      const choices = [a.choice];
      for (let i = 1; i <= k; i++) {
        const o = res.extra[`order_${i}`];
        if (o?.type === "choice") choices.push(names.label(o.choice));
      }
      // agree is null (not checked) when copies are unanswered and none of the answered ones disagrees.
      const missing = k + 1 - choices.length;
      const disagree = choices.some((c) => c !== a.choice);
      if (missing > 0) warnings.push(`order_check: ${missing} of ${k} order copies unanswered.`);
      out.order_check = { agree: disagree ? false : missing > 0 ? null : true, choices };
    }
    if (res.round1) out.round1_winners = res.round1;
    out.warnings = warningsOf(res.calls, warnings);
    return out;
  }
}
