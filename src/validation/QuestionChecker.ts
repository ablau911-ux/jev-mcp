import type { JevConfig } from "../config/types.js";
import type { Question } from "../core/types.js";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Per-type question rules from openapi.json and the SDK (errors start with a JSON path). */
export class QuestionChecker {
  constructor(private readonly config: JevConfig) {}

  check(id: string, q: Question, model: string): string[] {
    const at = `$.questions.${id}`;
    switch (q.type) {
      case "choice":
        return this.choice(at, q);
      case "score":
        return this.score(at, q);
      case "noul":
        return this.noul(at, q);
      case "box":
        return this.box(at, q, model);
    }
  }

  private choice(at: string, q: Question): string[] {
    const l = this.config.limits;
    if (!isObject(q.criteria)) return [`${at}.criteria: choice criteria must be an object of label -> description.`];
    const n = Object.keys(q.criteria).length;
    if (n < l.choiceMin || n > l.choiceMax) return [`${at}.criteria: choice needs ${l.choiceMin}-${l.choiceMax} options, got ${n}.`];
    if (Object.keys(q.criteria).some((k) => k.length === 0)) return [`${at}.criteria: choice labels must be non-empty.`];
    return [];
  }

  private score(at: string, q: Question): string[] {
    const l = this.config.limits;
    if (!Array.isArray(q.criteria)) return [`${at}.criteria: score criteria must be an ordered array of level descriptions.`];
    const n = q.criteria.length;
    if (n < l.scoreMin || n > l.scoreMax) return [`${at}.criteria: score needs ${l.scoreMin}-${l.scoreMax} levels, got ${n}.`];
    if (q.criteria.some((c) => c === null)) return [`${at}.criteria: score levels must not be null (openapi).`];
    return [];
  }

  private noul(at: string, q: Question): string[] {
    if (q.criteria !== undefined && q.criteria !== null && !isObject(q.criteria)) return [`${at}.criteria: noul criteria must be an object {true?, false?}.`];
    const c = isObject(q.criteria) ? q.criteria : {};
    if (Object.keys(c).some((k) => k !== "true" && k !== "false")) return [`${at}.criteria: noul criteria only accept "true" and "false" keys.`];
    const hasInstr = q.instructions !== undefined && q.instructions !== null && q.instructions !== "";
    const hasCriteria = (c.true !== undefined && c.true !== null) || (c.false !== undefined && c.false !== null);
    return hasInstr || hasCriteria ? [] : [`${at}: noul needs instructions or a criteria entry.`];
  }

  private box(at: string, q: Question, model: string): string[] {
    const errors: string[] = [];
    if (q.criteria !== undefined) errors.push(`${at}.criteria: box takes no criteria.`);
    if (q.instructions === undefined || q.instructions === null || q.instructions === "") errors.push(`${at}.instructions: box needs instructions saying what to locate.`);
    if (!this.config.models.boxModels.includes(model)) errors.push(`${at}: box needs model ${this.config.models.boxModels.join(" or ")}, got ${model}.`);
    return errors;
  }
}
