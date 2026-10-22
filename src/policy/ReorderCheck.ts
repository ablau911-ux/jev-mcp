import { DEFAULT_PROMPTS } from "../config/prompts.js";
import type { Entry, Questions, RawAnswer } from "../core/types.js";
import { WireLabels } from "./WireLabels.js";

export const REORDER_SUFFIX = "__reversed";

/**
 * Reversed-order self-consistency, only under presets with
 * `reorder_check` (default: strict). A live stress run (4,800 calls)
 * found no position bias and 0/40 winner changes on clear items, so it is off elsewhere;
 * subjective items flip 17-33%, but none of the 155 jev-1.14.0 answers in a flipping group
 * reached the 0.95 auto bar, so they land in confirm anyway. Each Choice gets a copy with reversed
 * options under a distinct suffixed name in the same request; a different winner sends the
 * answer to review. Doubles that question's tokens. Integer-like labels would keep their order
 * in any object, so the copy names them by the index-label alias of the order-check recipes
 * (WireLabels, config prompts.indexLabelAlias), mapped back before comparing.
 */
export class ReorderCheck {
  /** Reason given when a copy's winner differs (the answer goes to review). */
  static readonly UNSTABLE_REASON = "Winner changed when the options were reversed.";

  /** `template` is config prompts.indexLabelAlias; pass the same one to `split`. */
  static copies(questions: Questions, template: string = DEFAULT_PROMPTS.indexLabelAlias): Questions {
    const out: Questions = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type !== "choice" || typeof q.criteria !== "object" || q.criteria === null || Array.isArray(q.criteria)) continue;
      const criteria = q.criteria as Record<string, Entry>;
      const keys = Object.keys(criteria);
      if (keys.length < 2) continue;
      out[`${id}${REORDER_SUFFIX}`] = { ...q, criteria: new WireLabels(keys, template).criteria([...keys].reverse(), criteria) };
    }
    return out;
  }

  /** Removes the copies; returns the question ids whose winner changed with the order. */
  static split(answers: Record<string, RawAnswer>, template: string = DEFAULT_PROMPTS.indexLabelAlias, generated: readonly string[] = []): { answers: Record<string, RawAnswer>; unstable: Set<string> } {
    const rest: Record<string, RawAnswer> = {};
    const unstable = new Set<string>();
    for (const id of generated) {
      const baseId = id.slice(0, -REORDER_SUFFIX.length);
      if (answers[id]?.type !== "choice" || answers[baseId]?.type !== "choice") unstable.add(baseId);
    }
    for (const [id, a] of Object.entries(answers)) {
      if (!id.endsWith(REORDER_SUFFIX)) {
        rest[id] = a;
        continue;
      }
      const base = answers[id.slice(0, -REORDER_SUFFIX.length)];
      if (a.type !== "choice" || base?.type !== "choice") continue;
      // Wire name -> caller label over the base answer's labels (no throw: the copy was built from them).
      const original = new Map(Object.keys(base.probabilities).map((label) => [WireLabels.wireName(label, template), label]));
      if (base.choice !== (original.get(a.choice) ?? a.choice)) unstable.add(id.slice(0, -REORDER_SUFFIX.length));
    }
    return { answers: rest, unstable };
  }
}
