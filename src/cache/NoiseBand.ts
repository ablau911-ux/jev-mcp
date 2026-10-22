import type { RawAnswer } from "../core/types.js";

/**
 * Decides whether a response is stable enough to cache: only 447 of 454
 * jev-use re-runs matched, and the misses sat near the decision boundary. A response with
 * any Noul inside the margin band or any Choice or Score whose top two options are close is never
 * cached, so a borderline answer is asked fresh next time.
 */
export class NoiseBand {
  constructor(
    private readonly noulMarginMin: number,
    private readonly choiceGapMin: number,
  ) {}

  cacheable(answers: Record<string, RawAnswer>): boolean {
    return Object.values(answers).every((a) => !this.inBand(a));
  }

  inBand(a: RawAnswer): boolean {
    if (a.type === "noul") return Math.abs(2 * a.noul - 1) < this.noulMarginMin;
    // A Score carries the same distribution over its levels as a Choice over its options.
    if (a.type === "choice" || a.type === "score") {
      const [first = 0, second = 0] = Object.values(a.probabilities).sort((x, y) => y - x);
      return Object.keys(a.probabilities).length > 1 && first - second < this.choiceGapMin;
    }
    return false;
  }
}
