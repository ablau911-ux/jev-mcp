import { JevError } from "./JevError.js";
import type { BoxCoords, Entry, ParsedResponse, Question, Questions, RawAnswer, Usage } from "./types.js";

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function bad(path: string, requestId: string | null, why?: string): JevError {
  return new JevError({
    kind: "bad_response",
    message: `Response has an invalid shape at ${path}${why ? `: ${why}` : ""}.`,
    fix: "The API returned 2xx with an unexpected body. Retry; report if it persists.",
    requestId,
  });
}

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function numberMap(v: unknown): v is Record<string, number> {
  return isObj(v) && Object.values(v).every(num);
}

/** A probability or an image fraction: a finite number from 0 to 1 (openapi NoulAnswer, BoxCoordinates). */
function unit(v: unknown): v is number {
  return num(v) && v >= 0 && v <= 1;
}

/**
 * Shape-checks a SystemOneResponse against the published OpenAPI schema (https://api.typesafe.ai/openapi.json). Unknown answer
 * kinds are skipped with a warning; null usage counts as 0 with a warning. Given the asked
 * questions, an answer must match its question: the same type, and for a Choice a label
 * from the question's criteria (anything else is bad_response, never a verdict).
 */
export class ResponseParser {
  parse(data: unknown, requestId: string | null, asked?: Questions): ParsedResponse {
    if (!isObj(data)) throw bad("$", requestId);
    if (typeof data.model !== "string") throw bad("$.model", requestId);
    if (!isObj(data.answers)) throw bad("$.answers", requestId);
    const warnings: string[] = [];
    const answers: Record<string, RawAnswer> = {};
    for (const [id, raw] of Object.entries(data.answers)) {
      const path = `$.answers.${id}`;
      const parsed = this.answer(raw, path, requestId, warnings);
      if (!parsed) continue;
      const question = asked && Object.hasOwn(asked, id) ? asked[id] : undefined;
      if (question) ResponseParser.matches(parsed, question, path, requestId);
      answers[id] = parsed;
    }
    return { model: data.model, answers, usage: this.usage(data.usage, warnings), warnings };
  }

  /**
   * The usage block of a 2xx body that failed `parse` (the server billed it): read leniently,
   * so the session caps and the ledger still count it. Null when no input_tokens number is there.
   */
  billed(data: unknown): { model: string | null; usage: Usage } | null {
    const u = isObj(data) && isObj(data.usage) ? data.usage : null;
    if (!u || !num(u.input_tokens)) return null;
    const model = isObj(data) && typeof data.model === "string" ? data.model : null;
    return { model, usage: { input_tokens: u.input_tokens, output_tokens: num(u.output_tokens) ? u.output_tokens : 0 } };
  }

  private static matches(a: RawAnswer, q: Question, path: string, requestId: string | null): void {
    if (a.type !== q.type) throw bad(`${path}.type`, requestId, `a ${a.type} answer to a ${q.type} question`);
    if (a.type === "choice" && isObj(q.criteria) && !Object.hasOwn(q.criteria, a.choice)) {
      throw bad(`${path}.choice`, requestId, "label is not one of the asked criteria");
    }
  }

  private usage(raw: unknown, warnings: string[]): Usage {
    const u = isObj(raw) ? raw : {};
    const read = (key: string): number => {
      const v = u[key];
      if (num(v)) return v;
      warnings.push(`usage.${key} missing or null; counted as 0.`);
      return 0;
    };
    return { input_tokens: read("input_tokens"), output_tokens: read("output_tokens") };
  }

  private answer(raw: unknown, path: string, requestId: string | null, warnings: string[]): RawAnswer | null {
    if (!isObj(raw) || typeof raw.type !== "string") throw bad(path, requestId);
    switch (raw.type) {
      case "noul":
        if (!unit(raw.noul)) throw bad(`${path}.noul`, requestId);
        return { type: "noul", noul: raw.noul };
      case "choice":
        if (typeof raw.choice !== "string") throw bad(`${path}.choice`, requestId);
        if (!num(raw.confidence)) throw bad(`${path}.confidence`, requestId);
        if (!numberMap(raw.probabilities)) throw bad(`${path}.probabilities`, requestId);
        return { type: "choice", choice: raw.choice, confidence: raw.confidence, probabilities: raw.probabilities };
      case "score":
        return this.score(raw, path, requestId);
      case "box":
        return this.box(raw, path, requestId, warnings);
      default:
        warnings.push(`${path}: unknown answer type "${raw.type}" skipped.`);
        return null;
    }
  }

  private score(raw: Obj, path: string, requestId: string | null): RawAnswer {
    if (!num(raw.score)) throw bad(`${path}.score`, requestId);
    if (!num(raw.confidence)) throw bad(`${path}.confidence`, requestId);
    if (!numberMap(raw.probabilities)) throw bad(`${path}.probabilities`, requestId);
    const legend = isObj(raw.legend) ? (raw.legend as Record<string, Entry>) : {};
    return { type: "score", score: raw.score, confidence: raw.confidence, legend, probabilities: raw.probabilities };
  }

  /**
   * Edges must be fractions from 0 to 1 with left < right and top < bottom (primitives_box.md).
   * An impossible box is kept for the agent to see, but its confidence is dropped, so the
   * decision fails closed (review) instead of routing it on the server's confidence.
   */
  private box(raw: Obj, path: string, requestId: string | null, warnings: string[]): RawAnswer {
    const b = raw.box;
    if (!isObj(b) || !num(b.top) || !num(b.bottom) || !num(b.left) || !num(b.right)) throw bad(`${path}.box`, requestId);
    const confidence = raw.confidence;
    if (confidence !== null && confidence !== undefined && !num(confidence)) throw bad(`${path}.confidence`, requestId);
    const box: BoxCoords = { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
    const possible = unit(b.top) && unit(b.bottom) && unit(b.left) && unit(b.right) && b.left < b.right && b.top < b.bottom;
    if (!possible) {
      warnings.push(`${path}.box: impossible coordinates (each edge from 0 to 1, left < right, top < bottom); confidence dropped, review it.`);
      return { type: "box", box, confidence: null };
    }
    return { type: "box", box, confidence: num(confidence) ? confidence : null };
  }
}
