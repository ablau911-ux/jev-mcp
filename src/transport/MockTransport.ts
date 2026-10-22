import type { Question, WireRequest } from "../core/types.js";
import type { JevTransport, TransportOptions, TransportResponse } from "./JevTransport.js";

/**
 * Offline backend for tests, CI and machines without network (`JEV_BACKEND=mock`).
 * Answers are deterministic placeholders, never real judgments: Noul 0.9, the first
 * Choice option at 0.7, the top Score level, a fixed box. JevService adds a MOCK warning to every
 * result so a placeholder is never mistaken for a real answer.
 */
export class MockTransport implements JevTransport {
  constructor(private readonly aliases: Record<string, string>) {}

  async systemOne(body: WireRequest, options: TransportOptions): Promise<TransportResponse> {
    if (options.signal?.aborted) throw new Error("aborted");
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(body.questions)) answers[id] = MockTransport.answerFor(q);
    const model = this.aliases[body.model] ?? body.model;
    return { data: { model, answers, usage: { input_tokens: Math.ceil(JSON.stringify(body).length / 4), output_tokens: 0 } }, requestId: null };
  }

  async listModels(): Promise<TransportResponse> {
    return { data: { models: Object.keys(this.aliases).map((name) => ({ name: `${name}`, description: "mock backend", release_date: "1970-01-01" })) }, requestId: null };
  }

  static answerFor(q: Question): unknown {
    if (q.type === "noul") return { type: "noul", noul: 0.9 };
    if (q.type === "choice") {
      const labels = Object.keys((q.criteria ?? {}) as Record<string, unknown>);
      const rest = labels.length > 1 ? 0.3 / (labels.length - 1) : 0;
      const probabilities = Object.fromEntries(labels.map((l, i) => [l, labels.length === 1 ? 1 : i === 0 ? 0.7 : rest]));
      return { type: "choice", choice: labels[0], confidence: 0.6, probabilities };
    }
    if (q.type === "score") {
      const levels = Array.isArray(q.criteria) ? q.criteria : [];
      const n = levels.length;
      const probabilities = Object.fromEntries(levels.map((_, i) => [String(i), i === n - 1 ? 1 : 0]));
      const legend = Object.fromEntries(levels.map((l, i) => [String(i), l]));
      return { type: "score", score: n - 1, confidence: 1, legend, probabilities };
    }
    return { type: "box", box: { top: 0.2, bottom: 0.6, left: 0.1, right: 0.5 }, confidence: null };
  }
}
