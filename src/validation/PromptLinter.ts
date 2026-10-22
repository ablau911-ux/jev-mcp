import type { JevConfig } from "../config/types.js";
import { EntryWalker } from "../core/EntryWalker.js";
import type { Question, Questions } from "../core/types.js";

const NUMERIC_ONLY = /^\s*[-+]?\d+(\.\d+)?\s*$/;
/** Anything outside Latin (incl. Latin Extended), whitespace, digits, punctuation, symbols. */
const NON_LATIN = /[^ -ɏ\s\d\p{P}\p{S}]/u;

/**
 * Warning-only checks from the docs' prompting guidance and Jev 1.13 jaggedness.
 * Never blocks a request. Checks questions and criteria only (never state, which
 * may legitimately be in another language). The non-English warning fires once per session.
 */
export class PromptLinter {
  private warnedLanguage = false;

  /** The helper prompts (recipes, probes, hooks) as patterns: a Noul they wrote is not the caller's to fix. */
  private readonly serverNouls: RegExp[];

  constructor(
    private readonly words: JevConfig["linter"],
    prompts: Partial<JevConfig["prompts"]> = {},
  ) {
    const templates = Object.values(prompts).filter((t): t is string => typeof t === "string" && t.length > 0);
    this.serverNouls = templates.map((t) => new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{\w+\\\}/g, "[^]*")}$`));
  }

  lint(questions: Questions): string[] {
    const warnings: string[] = [];
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === "score") warnings.push(...this.score(id, q));
      if (q.type === "noul" && !this.serverWritten(q)) warnings.push(...this.noul(id, q));
      if (q.type === "choice") warnings.push(...this.choice(id, q));
      warnings.push(...this.jagged(id, q));
    }
    warnings.push(...this.language(questions));
    return warnings;
  }

  private serverWritten(q: Question): boolean {
    const text = q.instructions;
    return typeof text === "string" && this.serverNouls.some((re) => re.test(text));
  }

  private score(id: string, q: Question): string[] {
    const levels = Array.isArray(q.criteria) ? q.criteria : [];
    const out: string[] = [];
    if (levels.length > 0 && levels.every((l) => typeof l === "string" && NUMERIC_ONLY.test(l))) out.push(`${id}: score levels are numbers only; describe situations instead.`);
    const texts = levels.filter((l): l is string => typeof l === "string").map((l) => l.trim().toLowerCase());
    if (new Set(texts).size < texts.length) out.push(`${id}: two score levels have the same description.`);
    return out;
  }

  private noul(id: string, q: Question): string[] {
    const out: string[] = [];
    const text = typeof q.instructions === "string" ? q.instructions.toLowerCase() : "";
    if ((text.match(/\?/g) ?? []).length > 1) out.push(`${id}: noul holds more than one question; one proposition per Noul, combine in code.`);
    else if (this.words.compoundJoiners.some((j) => text.includes(j)) && /\?\s*$/.test(text)) out.push(`${id}: compound Noul ("and"/"or"); split into narrow Nouls (0.95 vs 0.56 accuracy, sde_cascade) and combine in code.`);
    const negs = this.words.negations.filter((n) => new RegExp(`\\b${n}\\b`).test(text)).length;
    if (negs >= 2 || /^(is|does|do|are|was|can)n't\b|^(is|does|are) (it )?not\b/.test(text)) out.push(`${id}: inverted or double-negative polarity; phrase it so yes means the property holds.`);
    const c = q.criteria as Record<string, unknown> | null | undefined;
    if (c && typeof c === "object" && typeof c.true === "string" && typeof c.false === "string" && c.true.trim().toLowerCase() === c.false.trim().toLowerCase()) {
      out.push(`${id}: noul true and false criteria are identical (contradictory criteria).`);
    }
    return out;
  }

  private choice(id: string, q: Question): string[] {
    const c = q.criteria;
    if (!c || typeof c !== "object" || Array.isArray(c)) return [];
    const entries = Object.entries(c as Record<string, unknown>);
    const out: string[] = [];
    const empty = entries.filter(([, d]) => typeof d === "string" && d.trim().length === 0).map(([k]) => k);
    if (empty.length > 0) out.push(`${id}: empty descriptions for ${empty.join(", ")}; use null or describe what the option means.`);
    const texts = entries.map(([, d]) => d).filter((d): d is string => typeof d === "string" && d.trim().length > 0);
    if (new Set(texts.map((t) => t.trim().toLowerCase())).size < texts.length) out.push(`${id}: two options share a description; make options mutually exclusive.`);
    return out;
  }

  /** Count and date words: Jev does not count or compare dates; do that in code. */
  private jagged(id: string, q: Question): string[] {
    const text = typeof q.instructions === "string" ? ` ${q.instructions.toLowerCase()} ` : "";
    const hit = (list: string[]) => list.find((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text));
    const out: string[] = [];
    const count = hit(this.words.countWords);
    if (count) out.push(`${id}: "${count}" asks Jev to count; ask one yes/no per item and sum in code.`);
    const date = hit(this.words.dateWords);
    if (date) out.push(`${id}: "${date}" suggests date logic; extract the date with a Choice ("not stated" option) and compare in code.`);
    return out;
  }

  private language(questions: Questions): string[] {
    if (this.warnedLanguage) return [];
    let nonLatin = false;
    for (const q of Object.values(questions)) {
      EntryWalker.forEachString([q.instructions ?? null, q.criteria ?? null], (s) => {
        if (NON_LATIN.test(s)) nonLatin = true;
      });
    }
    if (!nonLatin) return [];
    this.warnedLanguage = true;
    return ["Questions or criteria are not in English; Jev is most accurate in English (state may stay in any language). Shown once per session."];
  }
}
