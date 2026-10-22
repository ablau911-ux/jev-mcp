import { z } from "zod";
import { JevError } from "../core/JevError.js";
import type { JevService } from "../core/JevService.js";
import { QuestionSet } from "../core/QuestionSet.js";
import type { Questions } from "../core/types.js";
import { AnswerShaper } from "../output/AnswerShaper.js";
import type { DecisionPolicy } from "../policy/DecisionPolicy.js";
import { ReorderCheck } from "../policy/ReorderCheck.js";
import type { RecipeRegistry } from "../recipes/RecipeRegistry.js";
import type { ArgumentGuard } from "./ArgumentGuard.js";
import { JevTool, type ToolContext } from "./JevTool.js";
import { askInputShape, entry, errorOutputSchema, refuseModelArg, refuseReservedNames } from "./schemas.js";

function shape(recipes: [string, ...string[]]) {
  return {
    ...askInputShape,
    recipe: z.enum(recipes).optional().describe("Run a named recipe instead of raw questions; pass its args. See instructions for one example each."),
    args: z.record(z.string(), entry).optional().describe("Arguments of the recipe."),
  };
}

type Shape = ReturnType<typeof shape>;

/** Arguments whose values are content: the request pipeline masks secrets in them. */
const CONTENT_ARGS: ReadonlySet<string> = new Set(["state", "questions", "args", "images"]);
type Args = z.infer<z.ZodObject<Shape>>;

/**
 * The fields every jev_ask result may carry. A recipe adds its own fields (decide: decision,
 * verdict, p; verify_claim: label, band, ...; rerank: ranked; ...), so the published schema is
 * a loose object over these (break hunt 1: a closed object made a strict client reject every
 * decide / verify_claim result).
 */
export const ASK_OUTPUT = {
  model: z.union([z.string(), z.null()]).optional(),
  answers: z.record(z.string(), z.any()).optional(),
  recipe: z.string().optional(),
  id: z.string().optional(),
  usage: z.looseObject({ input_tokens: z.number(), output_tokens: z.number(), est_cost_usd: z.number(), cached: z.boolean() }).partial().nullable().optional(),
  secrets_redacted: z.number().optional(),
  model_overridden: z.boolean().optional(),
  warnings: z.array(z.string()).optional(),
  error: errorOutputSchema.optional(),
};

/** jev_ask: ONE state, N questions (or one recipe). Loaded upfront (`anthropic/alwaysLoad`). */
export class AskTool extends JevTool<Shape> {
  readonly name = "jev_ask";
  readonly title = "Ask Jev about one state";
  readonly description = [
    "ONE state, N questions: ask every typed question (noul yes/no p, choice label, score level) about one state in one call; answers come back with verdict, p and decision (auto | confirm | review).",
    'Use for: judging one failure log, one diff, one file, one command. For many items use jev_batch. Or run a recipe: {recipe:"classify"|"decide"|"verify_claim"|"rerank"|"self_consistency"|"find_lines"|"locate", args}.',
    'Not for: counting, dates, arithmetic, test pass/fail (exit code), summaries, judging whether a bug report is real or a patch fixes it. Refs instead of pasting: "$file:a.ts#L1-80", "$diff", "$log:x.log".',
    "If it returns unavailable / rate_limited / budget_exceeded, judge inline; do not retry in a loop.",
    'Example: {state:{diff:"$diff:staged"}, questions:{leak:{type:"noul",instructions:"Does `diff` add a hardcoded credential?"}}}',
  ].join(" ");
  readonly schema: Shape;
  readonly outputSchema = z.looseObject(ASK_OUTPUT);

  constructor(
    private readonly service: JevService,
    private readonly policy: DecisionPolicy,
    private readonly shaper: AnswerShaper,
    private readonly recipes: RecipeRegistry,
    private readonly argGuard: ArgumentGuard,
    /** Most questions about one state (config limits.questionsPerState). */
    private readonly maxQuestions: number,
  ) {
    super();
    this.schema = shape(recipes.names as [string, ...string[]]);
    this.meta = { "anthropic/alwaysLoad": true };
  }

  async run(args: Args, ctx: ToolContext): Promise<object> {
    refuseModelArg(args);
    this.argGuard.check(args, CONTENT_ARGS, Object.keys(this.schema));
    QuestionSet.checkCount(args.questions, this.maxQuestions, "$.questions");
    refuseReservedNames(args.questions, "$.questions");
    if (args.recipe) return this.recipe(args, ctx);
    if (args.state === undefined || args.questions === undefined) {
      throw JevError.invalid("state and questions are required (or pass recipe + args).", undefined, 'Example: {state:"$file:a.ts", questions:{q:{type:"noul",instructions:"..."}}}', args.state === undefined ? "$.state" : "$.questions");
    }
    const { name, preset } = this.policy.preset(args.preset);
    const asked = args.questions as Questions;
    const alias = this.service.config.prompts.indexLabelAlias;
    const copies = preset.reorder_check ? ReorderCheck.copies(asked, alias) : {};
    const questions = QuestionSet.merge(asked, copies);
    const raw = await this.service.execute(
      { state: args.state, questions, generated: Object.keys(copies).length, images: args.images, long_context: args.long_context, cache: args.cache, cacheTtlMs: preset.cache_ttl_ms },
      { tool: this.name, signal: ctx.signal },
    );
    const call = AnswerShaper.settleCopies(raw, Object.keys(copies), alias);
    const answers = this.shaper.shapeAll(call, { presetName: name, preset, detail: args.detail === true, asked: Object.keys(asked) });
    const out: Record<string, unknown> = {
      model: call.model,
      answers,
      id: AnswerShaper.callId(call),
      usage: { input_tokens: call.usage.input_tokens, est_cost_usd: call.usage.est_cost_usd, cached: call.cached },
    };
    if (call.secrets_redacted > 0) out.secrets_redacted = call.secrets_redacted;
    if (call.model_overridden) out.model_overridden = true;
    if (call.warnings.length > 0) out.warnings = call.warnings;
    return out;
  }

  private async recipe(args: Args, ctx: ToolContext): Promise<object> {
    if (args.state !== undefined || args.questions !== undefined) throw JevError.invalid("Pass either recipe + args or state + questions, not both.", undefined, "Move state into args.", "$.recipe");
    refuseModelArg(args.args);
    const recipe = this.recipes.get(args.recipe as string);
    const out = await recipe.run(recipe.parse(args.args), { signal: ctx.signal });
    const models = this.service.models;
    return { recipe: recipe.name, ...out, ...(models.overridden("text") || models.overridden("locate") ? { model_overridden: true } : {}) };
  }
}
