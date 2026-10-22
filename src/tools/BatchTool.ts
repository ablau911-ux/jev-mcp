import { writeFile } from "node:fs/promises";
import { z } from "zod";
import type { AutoLabeler } from "../calibration/AutoLabeler.js";
import type { BatchItemSource, BuiltItems } from "../batch/BatchItemSource.js";
import { BatchShaper } from "../batch/BatchShaper.js";
import { BatchReorder } from "../batch/BatchReorder.js";
import type { BatchInput, BatchRunner } from "../core/BatchRunner.js";
import { JevError } from "../core/JevError.js";
import { QuestionSet } from "../core/QuestionSet.js";
import type { Questions } from "../core/types.js";
import type { PathGuard } from "../files/PathGuard.js";
import { AnswerShaper } from "../output/AnswerShaper.js";
import type { DecisionPolicy } from "../policy/DecisionPolicy.js";
import type { ArgumentGuard } from "./ArgumentGuard.js";
import { JevTool, type ToolContext } from "./JevTool.js";
import { commonCallShape, errorOutputSchema, imagesSchema, longContextSchema, presetSchema, questionsSchema, refuseModelArg, refuseReservedNames, stateSchema } from "./schemas.js";

const shape = {
  items: z.array(z.object({ id: z.string().min(1), state: stateSchema, images: imagesSchema.optional(), questions: questionsSchema.optional() })).min(1).optional().describe("Your items (one request each)."),
  items_from: z.union([z.string(), z.array(z.string())]).optional().describe('Items built on the server: "$diff" / "$diff:staged" / "$diff:<ref>" = one item per hunk {file,hunk,diff}; ["$file:a.ts", ...] = one item per file {path,text}.'),
  questions: questionsSchema.describe("One question set asked of every item."),
  preset: presetSchema.optional(),
  rank_by: z.string().optional().describe("Question name to sort by (p descending)."),
  return: z.enum(["ranked", "flagged", "all"]).optional().describe("ranked = top_k by p; flagged = only flagged / non-auto items; all. Default: flagged for review_filter, else ranked when rank_by, else all."),
  top_k: z.number().int().min(1).max(500).optional(),
  detail: z.boolean().optional().describe("Add per-question answers to every row (more tokens)."),
  only_ids: z.array(z.string()).optional().describe("Re-run only these item ids (reruns also auto-label earlier decisions)."),
  concurrency: z.number().int().min(1).max(64).optional(),
  max_total_input_tokens: z.number().int().positive().optional(),
  stop_on_first_error: z.boolean().optional(),
  output_path: z.string().optional().describe("Also write the returned rows as JSONL here (inside the workspace)."),
  long_context: longContextSchema,
  ...commonCallShape,
};

type Args = z.infer<z.ZodObject<typeof shape>>;

/** Arguments whose values are content: the request pipeline masks secrets in them. */
const CONTENT_ARGS: ReadonlySet<string> = new Set(["items", "questions", "only_ids"]);

export const BATCH_OUTPUT = {
  model: z.union([z.string(), z.array(z.string()), z.null()]).optional(),
  summary: z.record(z.string(), z.any()).optional(),
  items: z.array(z.record(z.string(), z.any())).optional(),
  failures: z.array(z.record(z.string(), z.any())).optional(),
  output_path: z.string().optional(),
  model_overridden: z.boolean().optional(),
  warnings: z.array(z.string()).optional(),
  error: errorOutputSchema.optional(),
};

/** jev_batch: N items x one question set; ranked or flagged rows. */
export class BatchTool extends JevTool<typeof shape> {
  readonly name = "jev_batch";
  readonly title = "Judge many items with one question set";
  readonly description = [
    "N items x ONE question set: one request per item (failing tests, diff hunks, files), concurrent with a shared rate gate. Returns rows {item, verdict, p, decision} sorted by p as top-k or only the flagged ones, plus a summary and every failure.",
    'items_from builds items on the server: "$diff:staged" (one per hunk) or ["$file:a.ts", ...]. Diff review: preset review_filter with narrow Nouls where true = bad.',
    "Not for several questions about one state (jev_ask). If it returns unavailable / rate_limited / budget_exceeded, judge inline; do not retry in a loop.",
    'Example: {items_from:"$diff:staged", preset:"review_filter", questions:{no_err:{type:"noul",instructions:"Does `diff` remove error handling?"}}}',
  ].join(" ");
  readonly schema = shape;
  readonly outputSchema = BATCH_OUTPUT;

  constructor(
    private readonly runner: BatchRunner,
    private readonly source: BatchItemSource,
    private readonly shaper: BatchShaper,
    private readonly policy: DecisionPolicy,
    private readonly labeler: AutoLabeler,
    private readonly guard: PathGuard,
    private readonly topK: number,
    /** Secret guard for ids and the rows written to output_path. */
    private readonly scrub: <T>(value: T) => T,
    private readonly argGuard: ArgumentGuard,
    /** Most questions about one state (config limits.questionsPerState). */
    private readonly maxQuestions: number,
  ) {
    super();
  }

  async run(args: Args, ctx: ToolContext): Promise<object> {
    refuseModelArg(args);
    this.argGuard.check(args, CONTENT_ARGS, Object.keys(shape));
    QuestionSet.checkCount(args.questions, this.maxQuestions, "$.questions");
    refuseReservedNames(args.questions, "$.questions");
    (args.items ?? []).forEach((item, i) => {
      QuestionSet.checkCount(item.questions, this.maxQuestions, `$.items[${i}].questions`);
      refuseReservedNames(item.questions, `$.items[${i}].questions`);
    });
    const { name, preset } = this.policy.preset(args.preset);
    const target = args.output_path === undefined ? undefined : await this.target(args.output_path);
    const built = await this.source.build(args.items, args.items_from);
    BatchTool.checkRankBy(args, built);
    const plan = new BatchReorder(built, args.questions as Questions | undefined, preset.reorder_check === true, this.runner.config.prompts.indexLabelAlias);
    const run = plan.settle(await this.runner.run(this.input(args, plan.built, plan.questions, preset.cache_ttl_ms), this.name, ctx.signal));
    // A cached answer is the same answer, not an independent re-judgment: it labels nothing (break hunt 1).
    if (args.only_ids) this.labeler.onReruns(run.results.flatMap((r) => (r.call && !r.call.cached ? [[r.id, AnswerShaper.verdicts(r.call.answers), BatchShaper.itemHash(r)] as const] : [])));
    const out: Record<string, unknown> = this.shaper.shape(run, { presetName: name, preset, rankBy: args.rank_by, mode: args.return, topK: args.top_k ?? this.topK, detail: args.detail === true });
    if (run.results.some((r) => r.call?.model_overridden)) out.model_overridden = true;
    if (target !== undefined) {
      const failed = await this.write(target, out.items as object[]);
      if (failed === undefined) out.output_path = target;
      else (out.warnings as string[]).push(failed);
    }
    if ((out.warnings as string[]).length === 0) delete out.warnings;
    return out;
  }

  /** The runner input: declared arguments only, nothing spread (round 5). */
  private input(args: Args, built: BuiltItems, questions: Questions | undefined, cacheTtlMs: number | undefined): BatchInput {
    // only_ids resolve through the SAME mapping the items got (bug r25); an id given already masked is scrubbed as before.
    const only = args.only_ids?.map((id) => built.ids.get(id) ?? this.scrub(id)) ?? null;
    return {
      items: built.items, questions, cacheTtlMs, only_ids: only,
      concurrency: args.concurrency, max_total_input_tokens: args.max_total_input_tokens, stop_on_first_error: args.stop_on_first_error, cache: args.cache, long_context: args.long_context,
    };
  }

  /** rank_by must name an asked question (break hunt 1: a typo silently ranked by another question). */
  private static checkRankBy(args: Args, built: BuiltItems): void {
    if (args.rank_by === undefined) return;
    const only = args.only_ids ? new Set(args.only_ids.map((id) => built.ids.get(id) ?? id)) : undefined;
    const selected = built.items.filter((item) => !only || only.has(item.id));
    for (const item of selected) {
      const questions = item.questions ?? args.questions;
      if (!questions || !Object.hasOwn(questions, args.rank_by)) {
        throw JevError.invalid(`rank_by "${args.rank_by}" is not asked of item "${item.id}".`, undefined, "Use a question present in every selected item's effective questions; nothing was sent.", "$.rank_by");
      }
    }
  }

  /**
   * output_path is resolved and checked BEFORE any paid request (break hunt 1: a path outside
   * the workspace or in a missing directory was refused only after the run, losing every row).
   */
  private async target(path: string): Promise<string> {
    const target = await this.guard.resolveForWrite(path);
    // The final file name never holds a live secret (round 5).
    this.argGuard.checkValue("output_path", target);
    return target;
  }

  /** Writes the rows; a failed write (directory, read-only, ...) is a warning, never the loss of the paid rows. */
  private async write(target: string, rows: object[]): Promise<string | undefined> {
    try {
      // Scrubbed as one record, so the joined live-secret check covers the whole file.
      // One line per row, each ending in a newline: zero rows is an empty file, not a blank line.
      await writeFile(target, this.scrub(rows).map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
      return undefined;
    } catch (err) {
      return `output_path was not written (${(err as NodeJS.ErrnoException).code ?? "write error"}); the rows are returned here only.`;
    }
  }
}
