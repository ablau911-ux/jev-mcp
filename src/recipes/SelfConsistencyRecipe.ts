import { z } from "zod";
import { AnswerDeriver } from "../core/AnswerDeriver.js";
import { JevError } from "../core/JevError.js";
import type { JevService } from "../core/JevService.js";
import type { CallResult, Entry, Question, Questions, RawAnswer } from "../core/types.js";
import { WireLabels } from "../policy/WireLabels.js";
import { boxIoU, mean, permutations, stdDev, sumUsage, warningsOf } from "./helpers.js";
import { Recipe, type RecipeContext } from "./Recipe.js";
import { commonCallShape, entry, imagesSchema, questionSchema, stateSchema } from "../tools/schemas.js";

const shape = {
  state: stateSchema,
  question: questionSchema,
  variants: z.enum(["reorder", "paraphrase", "repeat"]).describe("reorder (choice only): permuted option orders in one request; paraphrase: your rewordings in one request; repeat: n separate uncached requests."),
  paraphrases: z.array(entry).optional().describe("Caller-written rewordings of the instructions (the tool never invents them)."),
  n: z.number().int().min(2).max(10).optional().describe("Variants for reorder/repeat (default 3)."),
  images: imagesSchema.optional(),
  ...commonCallShape,
};

type Args = z.infer<z.ZodObject<typeof shape>>;

interface Variant {
  variant: string;
  label: string | null;
  value: number;
}

/** jev_self_consistency (P1): stability check by reorder, paraphrase or repeat. */
export class SelfConsistencyRecipe extends Recipe<typeof shape> {
  readonly name = "self_consistency";
  readonly summary =
    "Stability check of one question: reorder (choice), paraphrase (your rewordings) or repeat. Use for high-stakes calls only.";
  readonly example = { state: "$file:src/a.ts#L1-40", question: { type: "choice", instructions: "Which describes this code?", criteria: { pure: null, side_effects: null } }, variants: "reorder" };
  readonly schema = shape;

  constructor(private readonly service: JevService) {
    super();
  }

  async run(args: Args, ctx: RecipeContext): Promise<object> {
    const q = args.question as Question;
    const n = args.n ?? this.service.config.selfConsistency.defaultN;
    const warnings: string[] = [];
    const { questions, names } = this.buildQuestions(args, q, n, warnings);
    const calls = args.variants === "repeat" ? await this.repeat(args, q, n, ctx) : [await this.ask(args, questions, ctx, args.cache)];
    const answers = args.variants === "repeat" ? calls.map((c) => c.answers.v0) : Object.keys(questions).map((id) => calls[0]?.answers[id]);
    const answered = answers.flatMap((a, i) => (a === undefined ? [] : [{ variant: `v${i}`, answer: a.type === "choice" ? names.answer(a) : a }]));
    const variants = this.measure(answered, q.type);
    const values = variants.map((v) => v.value);
    // A variant the response left out is not agreement: fewer answers than asked is unstable.
    const complete = answered.length === answers.length;
    if (!complete) warnings.push(`${answers.length - answered.length} of ${answers.length} variants unanswered; flag set to unstable.`);
    const agree = complete && this.agree(variants, answered.map((a) => a.answer), q.type);
    const sd = stdDev(values);
    return {
      agree,
      mean: mean(values),
      std_dev: sd,
      per_variant: variants,
      flag: agree && sd <= this.service.config.selfConsistency.stdDevLimit ? "stable" : "unstable",
      std_dev_limit: this.service.config.selfConsistency.stdDevLimit,
      model: calls[0]?.model ?? null,
      usage: sumUsage(calls),
      warnings: warningsOf(calls, warnings),
    };
  }

  private buildQuestions(args: Args, q: Question, n: number, warnings: string[]): { questions: Questions; names: WireLabels } {
    const plain = new WireLabels([], this.service.config.prompts.indexLabelAlias);
    if (args.variants === "reorder") {
      if (q.type !== "choice" || typeof q.criteria !== "object" || q.criteria === null || Array.isArray(q.criteria)) {
        throw JevError.invalid("reorder needs a choice question with object criteria.");
      }
      const criteria = q.criteria as Record<string, Entry>;
      const orders = [Object.keys(criteria), ...permutations(Object.keys(criteria), n - 1)];
      if (orders.length < n) warnings.push(`reorder n=${n}: only ${orders.length} distinct option orders exist; sent ${orders.length} variants.`);
      // Wire names that keep their order (integer-like labels get an alias in every variant).
      const names = new WireLabels(Object.keys(criteria), this.service.config.prompts.indexLabelAlias);
      return { questions: Object.fromEntries(orders.map((o, i) => [`v${i}`, { ...q, criteria: names.criteria(o, criteria) }])), names };
    }
    if (args.variants === "paraphrase") {
      if (q.type === "box") throw JevError.invalid("paraphrase supports noul, choice and score.");
      if (!args.paraphrases || args.paraphrases.length === 0) throw JevError.invalid("paraphrase needs paraphrases[].");
      const all = [q.instructions ?? null, ...(args.paraphrases as Entry[])];
      return { questions: Object.fromEntries(all.map((ins, i) => [`v${i}`, { ...q, instructions: ins }])), names: plain };
    }
    return { questions: { v0: q }, names: plain };
  }

  private async repeat(args: Args, q: Question, n: number, ctx: RecipeContext): Promise<CallResult[]> {
    const calls: CallResult[] = [];
    for (let i = 0; i < n; i++) calls.push(await this.ask(args, { v0: q }, ctx, false));
    return calls;
  }

  private ask(args: Args, questions: Questions, ctx: RecipeContext, cache: boolean | undefined): Promise<CallResult> {
    return this.service.execute(
      { state: args.state, questions, images: args.images, cache },
      { tool: this.tool, signal: ctx.signal },
    );
  }

  /** Value per variant: noul p; choice prob of the first variant's label; score normalized. */
  private measure(answers: Array<{ variant: string; answer: RawAnswer }>, type: Question["type"]): Variant[] {
    const first = answers[0]?.answer;
    const label = first?.type === "choice" ? first.choice : null;
    return answers.map(({ variant, answer: a }) => {
      if (a.type === "noul") return { variant, label: a.noul >= 0.5 ? "yes" : "no", value: a.noul };
      if (a.type === "choice") return { variant, label: a.choice, value: label !== null ? (a.probabilities[label] ?? 0) : a.confidence };
      if (a.type === "score") {
        const levels = Object.keys(a.probabilities).length;
        return { variant, label: String(Math.round(a.score)), value: AnswerDeriver.normalize(a.score, levels) };
      }
      if (type === "box") return { variant, label: null, value: a.confidence ?? 0 };
      return { variant, label: null, value: 0 };
    });
  }

  private agree(variants: Variant[], answers: RawAnswer[], type: Question["type"]): boolean {
    if (type === "box") {
      // Boxes agree only when each overlaps the first one enough (confidence alone says nothing about where).
      const boxes = answers.flatMap((a) => (a.type === "box" ? [a.box] : []));
      const first = boxes[0];
      return first !== undefined && boxes.length === answers.length && boxes.every((b) => boxIoU(first, b) >= this.service.config.selfConsistency.boxIouMin);
    }
    return variants.every((v) => v.label === variants[0]?.label);
  }
}
