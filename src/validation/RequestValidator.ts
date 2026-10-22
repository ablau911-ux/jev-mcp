import type { JevConfig } from "../config/types.js";
import { EntryWalker } from "../core/EntryWalker.js";
import type { Question, Questions } from "../core/types.js";
import { PromptLinter } from "./PromptLinter.js";
import { QuestionChecker } from "./QuestionChecker.js";
import type { SecretGuard } from "./SecretGuard.js";

export interface ValidationReport {
  errors: string[];
  warnings: string[];
}

const QUESTION_TYPES = new Set(["noul", "choice", "score", "box"]);
const BOM = String.fromCharCode(0xfeff);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Local checks that mirror the documented request rules (`/api/errors.md`, openapi, SDK),
 * run before any network call. Errors start with a JSON path:
 * - nesting at most 64 levels in state, instructions and criteria;
 * - finite numbers only, and integers beyond 2^53 refused (send big ids as strings);
 * - well-formed UTF-16 (valid UTF-8 on the wire) and no byte order mark in strings;
 * - question names unique after trimming and case folding (a JSON map silently overwrites);
 * - per-type question rules (QuestionChecker) and the secret guard.
 */
export class RequestValidator {
  private readonly linter: PromptLinter;
  private readonly questions: QuestionChecker;

  constructor(
    private readonly config: JevConfig,
    private readonly secrets: SecretGuard,
  ) {
    this.linter = new PromptLinter(config.linter, config.prompts);
    this.questions = new QuestionChecker(config);
  }

  validate(model: string, state: unknown, questions: unknown): ValidationReport {
    const errors: string[] = [...this.checkState(state)];
    if (!isObject(questions) || Object.keys(questions).length === 0) {
      return { errors: [...errors, "$.questions: at least one question is required."], warnings: [] };
    }
    errors.push(...RequestValidator.duplicateNames(Object.keys(questions)));
    for (const [id, q] of Object.entries(questions)) errors.push(...this.checkQuestion(id, q, model));
    errors.push(...this.secrets.check([[state, questions]], errors.length === 0 ? "request" : "data"));
    const warnings = errors.length === 0 ? this.linter.lint(questions as Questions) : [];
    return { errors, warnings };
  }

  /** Names that collide after trim + lower case (e.g. "Q1" and "q1 "). */
  static duplicateNames(ids: string[]): string[] {
    const seen = new Map<string, string>();
    const errors: string[] = [];
    for (const id of ids) {
      const norm = id.trim().toLowerCase();
      const prior = seen.get(norm);
      if (prior !== undefined) errors.push(`$.questions: names "${prior}" and "${id}" collide; give every question a distinct name.`);
      else seen.set(norm, id);
    }
    return errors;
  }

  private checkState(state: unknown): string[] {
    if (state === null || state === undefined) return ["$.state: required and must not be null."];
    if (typeof state !== "string" && typeof state !== "object") return ["$.state: must be a string, object or array (openapi SystemOneRequest.state)."];
    return this.checkTree("$.state", state);
  }

  private checkTree(where: string, value: unknown): string[] {
    const errors: string[] = [];
    const bad = EntryWalker.findNonFinite(value);
    if (bad) errors.push(`${bad.replace(/^\$/, where)}: non-finite number (NaN/Infinity are rejected).`);
    const big = EntryWalker.findUnsafeInteger(value);
    if (big) errors.push(`${big.replace(/^\$/, where)}: integer beyond 2^53 loses precision; send it as a string.`);
    const depth = EntryWalker.depth(value);
    if (depth > this.config.limits.maxNesting) errors.push(`${where}: nesting depth ${depth} exceeds ${this.config.limits.maxNesting}. Flatten deeper content.`);
    let malformed = false;
    let bom = false;
    EntryWalker.forEachString(value, (s) => {
      if (!s.isWellFormed()) malformed = true;
      if (s.includes(BOM)) bom = true;
    });
    if (malformed) errors.push(`${where}: contains a string with lone surrogates (invalid UTF-8 on the wire).`);
    if (bom) errors.push(`${where}: contains a byte order mark (U+FEFF); the API requires UTF-8 without BOM. Strip it.`);
    return errors;
  }

  private checkQuestion(id: string, raw: unknown, model: string): string[] {
    if (id.length === 0) return ["$.questions: question names must be non-empty."];
    if (!isObject(raw) || typeof raw.type !== "string" || !QUESTION_TYPES.has(raw.type)) return [`$.questions.${id}.type: must be one of noul, choice, score, box.`];
    const q = raw as unknown as Question;
    const errors: string[] = [];
    if (q.instructions !== undefined) errors.push(...this.checkTree(`$.questions.${id}.instructions`, q.instructions));
    if (q.criteria !== undefined) errors.push(...this.checkTree(`$.questions.${id}.criteria`, q.criteria));
    return [...errors, ...this.questions.check(id, q, model)];
  }
}
