import type { BoxCoords, Entry, ImageInfo, RawAnswer } from "./types.js";

export type Verbosity = "compact" | "full";

export interface PixelBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  image: string;
}

export type DerivedAnswer =
  | { type: "noul"; noul: number; margin: number }
  | {
      type: "choice";
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
      top2_ratio: number | null;
    }
  | {
      type: "score";
      score: number;
      normalized: number;
      confidence: number;
      probabilities: Record<string, number>;
      legend?: Record<string, Entry>;
    }
  | { type: "box"; box: BoxCoords; confidence: number | null; pixel_box?: PixelBox };

const COMPACT_TOP = 5;

/** Pure math for the derived fields of SPEC 3.1. */
export class AnswerDeriver {
  /** Noul margin `|2p-1|` (`/confidence.md`). */
  static margin(p: number): number {
    return Math.abs(2 * p - 1);
  }

  /** p(top) / p(second); null when there is no runner-up or it is 0. */
  static top2Ratio(probabilities: Record<string, number>): number | null {
    const sorted = Object.values(probabilities).sort((a, b) => b - a);
    const [first, second] = sorted;
    if (first === undefined || second === undefined || second === 0) return null;
    return first / second;
  }

  /** Score normalized to 0..1 by `levels-1`. */
  static normalize(score: number, levels: number): number {
    return levels > 1 ? score / (levels - 1) : 0;
  }

  /** Converts fractions to pixels. */
  static toPixels(box: BoxCoords, image: ImageInfo): PixelBox {
    const left = Math.round(box.left * image.width);
    const right = Math.round(box.right * image.width);
    const top = Math.round(box.top * image.height);
    const bottom = Math.round(box.bottom * image.height);
    return { left, top, right, bottom, width: right - left, height: bottom - top, image: image.name };
  }

  /** Pads each edge outward by `pad` (fraction of the image) and optionally clamps to 0..1. */
  static pad(box: BoxCoords, pad: number, clamp: boolean): BoxCoords {
    const out = { top: box.top - pad, bottom: box.bottom + pad, left: box.left - pad, right: box.right + pad };
    if (!clamp) return out;
    const c = (v: number) => Math.min(1, Math.max(0, v));
    return { top: c(out.top), bottom: c(out.bottom), left: c(out.left), right: c(out.right) };
  }

  static topK(probabilities: Record<string, number>, k: number): Record<string, number> {
    const entries = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
    return Object.fromEntries(entries.slice(0, k));
  }

  derive(answer: RawAnswer, verbosity: Verbosity, images: ImageInfo[]): DerivedAnswer {
    switch (answer.type) {
      case "noul":
        return { type: "noul", noul: answer.noul, margin: AnswerDeriver.margin(answer.noul) };
      case "choice":
        return {
          type: "choice",
          choice: answer.choice,
          confidence: answer.confidence,
          probabilities: verbosity === "full" ? answer.probabilities : AnswerDeriver.topK(answer.probabilities, COMPACT_TOP),
          top2_ratio: AnswerDeriver.top2Ratio(answer.probabilities),
        };
      case "score": {
        const levels = Object.keys(answer.probabilities).length;
        const out: DerivedAnswer = {
          type: "score",
          score: answer.score,
          normalized: AnswerDeriver.normalize(answer.score, levels),
          confidence: answer.confidence,
          probabilities: answer.probabilities,
        };
        if (verbosity === "full") out.legend = answer.legend;
        return out;
      }
      case "box": {
        const out: DerivedAnswer = { type: "box", box: answer.box, confidence: answer.confidence };
        if (images.length === 1 && images[0]) out.pixel_box = AnswerDeriver.toPixels(answer.box, images[0]);
        return out;
      }
    }
  }

  deriveAll(answers: Record<string, RawAnswer>, verbosity: Verbosity, images: ImageInfo[]): Record<string, DerivedAnswer> {
    const out: Record<string, DerivedAnswer> = {};
    for (const [id, a] of Object.entries(answers)) out[id] = this.derive(a, verbosity, images);
    return out;
  }
}
