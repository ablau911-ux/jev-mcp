import { JevError } from "./JevError.js";
import type { Questions } from "./types.js";

/**
 * Merges question maps without silent overwrites: questions travel as a
 * JSON map, so a repeated name would replace the earlier question. Recipes add their own
 * questions (order checks, presence and injection probes) through this merge. Names are
 * compared after trimming and case folding, the same rule the validator applies to caller
 * names, so a generated name can never collide with a caller's.
 */
export class QuestionSet {
  static merge(...sets: Questions[]): Questions {
    const out: Questions = {};
    const seen = new Set<string>();
    for (const set of sets) {
      for (const [id, q] of Object.entries(set)) {
        const norm = QuestionSet.fold(id);
        if (seen.has(norm)) {
          throw JevError.invalid(`Question name "${id}" is used twice (names are compared trimmed and case-folded).`, undefined, "Rename the question; names must be unique within a request.", `$.questions.${id}`);
        }
        seen.add(norm);
        out[id] = q;
      }
    }
    return out;
  }

  /**
   * Refuses more than `max` questions about one state (stress area 9 tested up to 30 per
   * request: same verdicts as separate calls, 12x cheaper). The error names the count only.
   */
  static checkCount(questions: unknown, max: number, where: string): void {
    if (typeof questions !== "object" || questions === null) return;
    const n = Object.keys(questions).length;
    if (n > max) {
      throw JevError.invalid(`${where}: ${n} questions about one state; at most ${max} per request.`, undefined, `Split the questions into requests of at most ${max} (each about the same state).`, where);
    }
  }

  /**
   * Bug r9: the limit counts the FINAL wire questions, generated ones included (reorder copies,
   * injection probes). Refuses with both counts named; nothing is dropped silently.
   */
  static checkWire(questions: Questions, generated: number, max: number): void {
    const n = Object.keys(questions).length;
    if (n <= max) return;
    const user = n - generated;
    throw JevError.invalid(
      `$.questions: ${user} user questions + ${generated} generated questions (reorder copies, injection probes) = ${n} exceed the limit of ${max} questions per request.`,
      undefined,
      `Ask at most ${max - generated} questions here, or split them into several requests; nothing was sent.`,
      "$.questions",
    );
  }

  static fold(id: string): string {
    return id.trim().toLowerCase();
  }
}
