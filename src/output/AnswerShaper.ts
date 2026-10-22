import type { DecisionLog, DecisionRecord } from "../calibration/DecisionLog.js";
import type { Preset } from "../config/types.js";
import { AnswerDeriver } from "../core/AnswerDeriver.js";
import type { CallResult, RawAnswer } from "../core/types.js";
import type { Decision, DecisionPolicy } from "../policy/DecisionPolicy.js";
import { REORDER_SUFFIX, ReorderCheck } from "../policy/ReorderCheck.js";

const REORDER_REASON = "Winner changed when the options were reversed.";

/** Concise per-question result: verdict + p/conf + decision. */
export interface ShortAnswer {
  verdict: string | null;
  p: number | null;
  conf?: number | null;
  decision: Decision["action"];
  flag?: boolean;
  box?: unknown;
  probabilities?: Record<string, number>;
  reason?: string;
}

export interface ShapeOptions {
  presetName: string;
  preset: Preset;
  detail: boolean;
  subject?: DecisionRecord["subject"];
  /**
   * The question ids the caller asked. When given, the result has exactly these ids: an asked
   * question with no answer fails closed (review, verdict null) and an answer to a question
   * nobody asked is dropped (break hunt 1: both passed silently).
   */
  asked?: readonly string[];
}

const r3 = (v: number | null): number | null => (v === null ? null : Math.round(v * 1000) / 1000);

/**
 * Shrinks raw answers to what the agent acts on, applies the preset decision, and logs each
 * decision (metadata only) for calibration. `detail: true` adds probabilities and the reason.
 */
export class AnswerShaper {
  constructor(
    private readonly policy: DecisionPolicy,
    private readonly log: DecisionLog,
  ) {}

  shapeAll(call: CallResult, o: ShapeOptions): Record<string, ShortAnswer> {
    const out: Record<string, ShortAnswer> = {};
    for (const id of o.asked ?? Object.keys(call.answers)) out[id] = this.shape(id, Object.hasOwn(call.answers, id) ? call.answers[id] : undefined, call, o);
    return out;
  }

  shape(qid: string, a: RawAnswer | undefined, call: CallResult, o: ShapeOptions): ShortAnswer {
    const policy = this.policy.decide(a, o.preset, { untrusted: call.untrusted, drifted: call.drifted, injectionP: call.injection_p });
    const d = call.reorder_unstable?.includes(qid) ? { ...policy, action: "review" as const, reason: REORDER_REASON } : policy;
    if (!a) return { verdict: null, p: null, decision: d.action, ...(o.detail ? { reason: d.reason } : {}) };
    const out: ShortAnswer = { verdict: d.verdict, p: r3(AnswerShaper.p(a)), decision: d.action };
    if (a.type === "choice" || a.type === "score") out.conf = r3(a.confidence);
    if (a.type === "box") Object.assign(out, { box: a.box, conf: a.confidence });
    if (d.flag !== undefined) out.flag = d.flag;
    if (o.detail) Object.assign(out, AnswerShaper.detail(a), { reason: d.reason });
    this.record(`${AnswerShaper.callId(call)}.${qid}`, d, call.model, o);
    return out;
  }

  /**
   * Reorder check: removes the reversed copies THIS request generated (only those, so a caller's
   * own `*__reversed` question stays; break hunt 1) and records in `reorder_unstable` the
   * questions whose winner changed. Shared by jev_ask and jev_batch.
   */
  static settleCopies(call: CallResult, generated: readonly string[], template?: string): CallResult {
    if (generated.length === 0) return call;
    const copies = new Set(generated);
    const pairs: Record<string, RawAnswer> = {};
    for (const id of generated) {
      for (const k of [id, id.slice(0, -REORDER_SUFFIX.length)]) if (Object.hasOwn(call.answers, k)) pairs[k] = call.answers[k]!;
    }
    const answers = Object.fromEntries(Object.entries(call.answers).filter(([id]) => !copies.has(id)));
    return { ...call, answers, reorder_unstable: [...ReorderCheck.split(pairs, template, generated).unstable] };
  }

  /** The number a caller ranks by: Noul p, Choice top probability, Score normalized, Box confidence. */
  static p(a: RawAnswer): number | null {
    if (a.type === "noul") return a.noul;
    if (a.type === "choice") return Math.max(0, ...Object.values(a.probabilities));
    if (a.type === "score") return AnswerDeriver.normalize(a.score, Object.keys(a.probabilities).length);
    return a.confidence;
  }

  /** Verdict per question without thresholds (used to compare reruns). */
  static verdicts(answers: Record<string, RawAnswer>): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const [id, a] of Object.entries(answers)) {
      if (a.type === "noul") out[id] = a.noul >= 0.5 ? "yes" : "no";
      else if (a.type === "choice") out[id] = a.choice;
      else if (a.type === "score") out[id] = String(Math.round(a.score));
      else out[id] = null;
    }
    return out;
  }

  /** Short id the agent passes back to `jev_status {action:"feedback"}`. */
  static callId(call: CallResult): string {
    return call.client_id.replace(/-/g, "").slice(0, 12);
  }

  private static detail(a: RawAnswer): Partial<ShortAnswer> {
    if (a.type === "choice" || a.type === "score") return { probabilities: AnswerDeriver.topK(a.probabilities, 5) };
    return {};
  }

  private record(id: string, d: Decision, model: string, o: ShapeOptions): void {
    const rec: DecisionRecord = { type: "decision", id, ts: new Date().toISOString(), preset: o.presetName, metric: d.metric, p: d.p, action: d.action, verdict: d.verdict, model };
    if (o.subject) rec.subject = o.subject;
    this.log.append(rec);
  }
}
