import type { BatchRun } from "../core/BatchRunner.js";
import { QuestionSet } from "../core/QuestionSet.js";
import type { Questions } from "../core/types.js";
import { AnswerShaper } from "../output/AnswerShaper.js";
import { ReorderCheck } from "../policy/ReorderCheck.js";
import type { BuiltItems } from "./BatchItemSource.js";

/**
 * Strict presets (reorder_check) in jev_batch: every Choice also goes out with reversed options
 * and a changed winner is review, as in jev_ask (break hunt 1: jev_batch skipped the check
 * silently). Off, it changes nothing.
 */
export class BatchReorder {
  readonly built: BuiltItems;
  readonly questions: Questions | undefined;
  private readonly generated = new Map<string, string[]>();

  /** `alias` is config prompts.indexLabelAlias (integer-like labels in the reversed copies). */
  constructor(built: BuiltItems, questions: Questions | undefined, on: boolean, private readonly alias?: string) {
    const copiesOf = (q: Questions | undefined): Questions => (on && q ? ReorderCheck.copies(q, alias) : {});
    const shared = copiesOf(questions);
    const items = built.items.map((item) => {
      const own = item.questions ? copiesOf(item.questions) : shared;
      this.generated.set(item.id, Object.keys(own));
      return item.questions ? { ...item, questions: QuestionSet.merge(item.questions, own) } : item;
    });
    this.built = { ...built, items };
    this.questions = questions ? QuestionSet.merge(questions, shared) : questions;
  }

  /** The run with every generated copy settled (removed from answers and asked ids; changed winners marked for review). */
  settle(run: BatchRun): BatchRun {
    return {
      ...run,
      results: run.results.map((r) => {
        if (!r.call) return r;
        const generated = this.generated.get(r.id) ?? [];
        return {
          ...r,
          call: AnswerShaper.settleCopies(r.call, generated, this.alias),
          ...(r.asked ? { asked: r.asked.filter((id) => !generated.includes(id)) } : {}),
          ...(r.effectiveQuestions ? { effectiveQuestions: Object.fromEntries(Object.entries(r.effectiveQuestions).filter(([id]) => !generated.includes(id))) } : {}),
        };
      }),
    };
  }
}
