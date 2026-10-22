import type { JevConfig, Preset } from "../config/types.js";
import { JevError } from "../core/JevError.js";
import type { RawAnswer } from "../core/types.js";

export type Action = "auto" | "confirm" | "review";

export interface Decision {
  action: Action;
  /** yes/no for Noul, the label for Choice, the rounded level for Score. */
  verdict: string | null;
  /** The number the decision used (Noul p, Choice confidence, Score confidence). */
  p: number | null;
  metric: string;
  /** True when a recall-filter preset (flag_at) flags this answer. */
  flag?: boolean;
  reason: string;
}

export interface DecisionContext {
  untrusted?: boolean;
  drifted?: boolean;
  injectionP?: number | null;
}

/**
 * Code-side routing with named presets from config: the agent passes only
 * a preset name. Every threshold names its metric and is marked `calibrated: false` until
 * jev_status calibrate fits it. Choice also checks a top-probability floor and a margin gate
 * scaled by 2/n (correct many-option picks have margins of 0.02-0.08). Fails closed: a
 * missing or null-confidence answer is `review`; untrusted state or model drift caps `auto`
 * at `confirm`; a likely injection is `review`.
 */
export class DecisionPolicy {
  constructor(private readonly config: JevConfig) {}

  preset(name?: string): { name: string; preset: Preset } {
    const key = name ?? this.config.defaultPreset;
    // Own keys only: "toString" or "constructor" must not resolve through the prototype chain.
    const preset = Object.hasOwn(this.config.presets, key) ? this.config.presets[key] : undefined;
    if (!preset) throw JevError.invalid(`Unknown preset "${key}".`, undefined, `Use one of: ${Object.keys(this.config.presets).join(", ")}.`);
    return { name: key, preset };
  }

  decide(answer: RawAnswer | undefined, preset: Preset, ctx: DecisionContext = {}): Decision {
    const d = DecisionPolicy.cap(this.raw(answer, preset), ctx);
    return preset.flag_at ? { ...d, flag: this.flagged(d, ctx) } : d;
  }

  /**
   * Recall filter (flag_at): a Noul is flagged by its p; an injection-capped answer, and any
   * non-Noul answer (no flag_at metric) that is not auto, is flagged too, so `return: "flagged"`
   * never hides an answer the policy routed away from auto.
   */
  private flagged(d: Decision, ctx: DecisionContext): boolean {
    if ((ctx.injectionP ?? 0) >= 0.5) return true;
    if (d.metric === "noul_p") return d.flag === true;
    return d.action !== "auto";
  }

  private raw(a: RawAnswer | undefined, p: Preset): Decision {
    if (!a) return { action: "review", verdict: null, p: null, metric: "none", reason: "No answer: fail closed." };
    if (a.type === "noul") return this.noul(a.noul, p);
    if (a.type === "choice") return this.choice(a, p);
    if (a.type === "score") return this.band(a.confidence, p, String(Math.round(a.score)), "score_confidence");
    return this.band(a.confidence, p, null, "box_confidence");
  }

  private noul(v: number, p: Preset): Decision {
    const flag = p.flag_at ? v >= p.flag_at.value : undefined;
    const out = (action: Action, verdict: string | null, reason: string): Decision => ({ action, verdict, p: v, metric: "noul_p", reason, ...(flag === undefined ? {} : { flag }) });
    if (v >= p.noul_yes_above.value) return out("auto", "yes", `p ${v.toFixed(3)} >= ${p.noul_yes_above.value}.`);
    if (v <= p.noul_no_below.value) return out("auto", "no", `p ${v.toFixed(3)} <= ${p.noul_no_below.value}.`);
    return out("review", v >= 0.5 ? "yes" : "no", `p ${v.toFixed(3)} is between the bands.`);
  }

  private choice(a: Extract<RawAnswer, { type: "choice" }>, p: Preset): Decision {
    const probs = Object.values(a.probabilities).sort((x, y) => y - x);
    const [top = 0, second = 0] = probs;
    const d = this.band(a.confidence, p, a.choice, "choice_confidence");
    if (p.top_p_floor && top < p.top_p_floor.value) return { ...d, action: "review", reason: `top probability ${top.toFixed(3)} < floor ${p.top_p_floor.value}.` };
    const margin = p.margin_min ? p.margin_min.value * Math.min(1, 2 / Math.max(2, probs.length)) : 0;
    if (d.action === "auto" && top - second < margin) return { ...d, action: "confirm", reason: `margin ${(top - second).toFixed(3)} < ${margin.toFixed(3)} (scaled by 2/n).` };
    return d;
  }

  private band(conf: number | null, p: Preset, verdict: string | null, metric: string): Decision {
    if (conf === null) return { action: "review", verdict, p: null, metric, reason: "No confidence returned: review." };
    if (conf >= p.auto_at.value) return { action: "auto", verdict, p: conf, metric, reason: `confidence ${conf.toFixed(3)} >= ${p.auto_at.value}.` };
    if (conf >= p.review_below.value) return { action: "confirm", verdict, p: conf, metric, reason: `confidence ${conf.toFixed(3)} in [${p.review_below.value}, ${p.auto_at.value}).` };
    return { action: "review", verdict, p: conf, metric, reason: `confidence ${conf.toFixed(3)} < ${p.review_below.value}.` };
  }

  /** Untrusted state, model drift and a likely injection cap any decision (also used by recipes that band without a preset). */
  static cap(d: Decision, ctx: DecisionContext): Decision {
    if ((ctx.injectionP ?? 0) >= 0.5) return { ...d, action: "review", reason: `${d.reason} Injection probe ${ctx.injectionP?.toFixed(3)}: review.` };
    if (d.action === "auto" && (ctx.untrusted || ctx.drifted)) return { ...d, action: "confirm", reason: `${d.reason} Capped at confirm (${ctx.drifted ? "model drift" : "untrusted state"}).` };
    return d;
  }
}
