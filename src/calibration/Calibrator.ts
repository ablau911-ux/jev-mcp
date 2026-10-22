import { DEFAULT_CONFIG } from "../config/defaults.js";

export interface Sample {
  p: number;
  /** True when the positive verdict at this p was right. */
  label: boolean;
}

export interface CalibrationResult {
  status: "ok" | "insufficient";
  have: number;
  need: number;
  ece?: number;
  threshold?: number | null;
  train_precision_lb?: number | null;
  holdout?: { n: number; precision: number | null; recall: number | null };
}

export interface CalibratorOptions {
  minRecords: number;
  holdout: number;
  targetPrecision: number;
  z: number;
  bins: number;
}

/**
 * Threshold fitting on outcome labels: expected calibration error
 * over equal-width bins, then the lowest threshold whose Wilson lower bound on precision
 * reaches the target on a deterministic 70% split, checked on the 30% holdout. Pure math.
 */
export class Calibrator {
  /** The options in use: an out-of-range config value falls back to its default (see `warnings`). */
  readonly o: CalibratorOptions;
  readonly warnings: string[] = [];

  constructor(options: CalibratorOptions) {
    this.o = { ...options };
    // Out of range, need() never ends (holdout 30 meant 30%) or is Infinity (target 1), and bins 0 hides every sample from ece.
    const valid: Record<keyof CalibratorOptions, (v: number) => boolean> = {
      minRecords: (v) => v >= 0,
      holdout: (v) => v >= 0 && v < 1,
      targetPrecision: (v) => v > 0 && v < 1,
      z: (v) => v > 0,
      bins: (v) => Number.isInteger(v) && v >= 1,
    };
    for (const key of Object.keys(valid) as Array<keyof CalibratorOptions>) {
      const v = options[key];
      if (typeof v === "number" && Number.isFinite(v) && valid[key](v)) continue;
      this.o[key] = DEFAULT_CONFIG.calibration[key];
      this.warnings.push(`calibration.${key} ${JSON.stringify(v)} is out of range; using the default ${this.o[key]}.`);
    }
  }

  static wilsonLower(successes: number, n: number, z: number): number {
    if (n === 0) return 0;
    const phat = successes / n;
    const denom = 1 + (z * z) / n;
    const centre = phat + (z * z) / (2 * n);
    const margin = z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n));
    return (centre - margin) / denom;
  }

  ece(samples: Sample[]): number {
    const bins = Array.from({ length: this.o.bins }, () => ({ n: 0, p: 0, pos: 0 }));
    for (const s of samples) {
      const b = bins[Math.min(this.o.bins - 1, Math.floor(s.p * this.o.bins))];
      if (!b) continue;
      b.n++;
      b.p += s.p;
      if (s.label) b.pos++;
    }
    return bins.reduce((acc, b) => acc + (b.n === 0 ? 0 : (b.n / samples.length) * Math.abs(b.p / b.n - b.pos / b.n)), 0);
  }

  /**
   * Records needed before a fit can succeed at all: even an all-correct train split of n has a
   * Wilson lower bound of n / (n + z²), so it reaches the target only from n >= z²·t / (1 - t)
   * (0.9 at z 1.96: 35 train records, 50 in total with a 30% holdout). Never below `minRecords`.
   */
  need(): number {
    const { targetPrecision: t, z } = this.o;
    // Start below the closed form and step with the bound fit() applies: ceil() of a float such as
    // 4.000000000000001 would ask for one train record more than the target needs.
    let train = Math.max(1, Math.floor((z * z * t) / (1 - t)));
    while (Calibrator.wilsonLower(train, train, z) < t) train++;
    let total = Math.max(this.o.minRecords, Math.ceil(train / (1 - this.o.holdout)) - 1);
    while (Math.floor(total * (1 - this.o.holdout)) < train) total++;
    return total;
  }

  fit(samples: Sample[]): CalibrationResult {
    const need = this.need();
    if (samples.length < need) return { status: "insufficient", have: samples.length, need };
    const cut = Math.floor(samples.length * (1 - this.o.holdout));
    const train = samples.slice(0, cut);
    const test = samples.slice(cut);
    const { threshold, lb } = this.threshold(train);
    return { status: "ok", have: samples.length, need, ece: round(this.ece(samples)), threshold, train_precision_lb: lb === null ? null : round(lb), holdout: this.evaluate(test, threshold) };
  }

  /** Lowest p whose samples at or above it reach the target: one sort, one sweep down with running counts. */
  private threshold(train: Sample[]): { threshold: number | null; lb: number | null } {
    const sorted = [...train].sort((a, b) => b.p - a.p);
    let best: { threshold: number | null; lb: number | null } = { threshold: null, lb: null };
    let right = 0;
    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i]!;
      if (s.label) right++;
      if (sorted[i + 1]?.p === s.p) continue; // Count every sample at this p first.
      const lb = Calibrator.wilsonLower(right, i + 1, this.o.z);
      if (lb >= this.o.targetPrecision) best = { threshold: s.p, lb };
    }
    return best;
  }

  private evaluate(test: Sample[], t: number | null): { n: number; precision: number | null; recall: number | null } {
    if (t === null || test.length === 0) return { n: test.length, precision: null, recall: null };
    const predicted = test.filter((s) => s.p >= t);
    const positives = test.filter((s) => s.label).length;
    const tp = predicted.filter((s) => s.label).length;
    return { n: test.length, precision: predicted.length ? round(tp / predicted.length) : null, recall: positives ? round(tp / positives) : null };
  }
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
