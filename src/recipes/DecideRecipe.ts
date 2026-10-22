import { z } from "zod";
import type { JevService } from "../core/JevService.js";
import { QuestionSet } from "../core/QuestionSet.js";
import type { Question, Questions } from "../core/types.js";
import { AnswerShaper } from "../output/AnswerShaper.js";
import type { DecisionPolicy } from "../policy/DecisionPolicy.js";
import { ReorderCheck } from "../policy/ReorderCheck.js";
import { Recipe, type RecipeContext } from "./Recipe.js";
import { commonCallShape, imagesSchema, presetSchema, questionSchema, stateSchema } from "../tools/schemas.js";

const shape = {
  state: stateSchema,
  question: questionSchema,
  preset: presetSchema.optional(),
  detail: z.boolean().optional().describe("Add probabilities and the routing reason."),
  images: imagesSchema.optional(),
  ...commonCallShape,
};

type Args = z.infer<z.ZodObject<typeof shape>>;

/** decide: one question plus a named preset returning auto / confirm / review. */
export class DecideRecipe extends Recipe<typeof shape> {
  readonly name = "decide";
  readonly summary = "One question routed by a named preset to auto / confirm / review (thresholds in config, calibrated:false until fitted).";
  readonly example = { state: { command: "rm -rf build" }, question: { type: "noul", instructions: "Does `command` only delete generated files?" }, preset: "gate" };
  readonly schema = shape;

  constructor(
    private readonly service: JevService,
    private readonly policy: DecisionPolicy,
    private readonly shaper: AnswerShaper,
  ) {
    super();
  }

  async run(args: Args, ctx: RecipeContext): Promise<object> {
    const { name, preset } = this.policy.preset(args.preset);
    const asked: Questions = { q: args.question as Question };
    // Same reversed-order check as jev_ask under presets with reorder_check (strict).
    const alias = this.service.config.prompts.indexLabelAlias;
    const copies = preset.reorder_check ? ReorderCheck.copies(asked, alias) : {};
    const raw = await this.service.execute(
      { state: args.state, questions: QuestionSet.merge(asked, copies), generated: Object.keys(copies).length, images: args.images, cache: args.cache, cacheTtlMs: preset.cache_ttl_ms },
      { tool: this.tool, signal: ctx.signal },
    );
    const call = AnswerShaper.settleCopies(raw, Object.keys(copies), alias);
    const answer = this.shaper.shape("q", call.answers.q, call, { presetName: name, preset, detail: true });
    return { decision: answer.decision, verdict: answer.verdict, p: answer.p, reason: answer.reason, preset: name, model: call.model, id: AnswerShaper.callId(call), warnings: call.warnings };
  }
}
