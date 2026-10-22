import type { Recipe } from "../recipes/Recipe.js";
import { GuideText } from "./GuideText.js";

/** Claude Code cuts server instructions after this many characters. */
export const INSTRUCTIONS_LIMIT = 4096;

/**
 * Router text. Under tool search only tool names and the server
 * `instructions` load at session start, so the instructions decide whether Jev is used at
 * all: routing words first, rule 0, the "NOT for" list, one example per recipe and the
 * fallback rule. Kept under 4,096 characters (checked by a test). The full guide is the
 * `jev://guide` resource.
 */
export class Guidance {
  static instructions(recipes: Recipe[]): string {
    const examples = recipes.map((r) => `- ${r.name}: jev_ask {recipe:"${r.name}", args:${JSON.stringify(r.example)}}`).join("\n");
    return [
      "Jev (TypeSafe System One): fast, cheap typed judgments for coding work: yes/no probability (noul), pick a label (choice), grade (score). Use to triage failing tests, review diff hunks, rerank files, gate an action, check a claim against code. About $0.00002 per judgment; it never writes text or code.",
      "Tools: jev_ask = ONE state, N questions (put every question about that state in one call). jev_batch = N items x one question set (hunks, files, failures); returns ranked or flagged items. jev_status = health, usage, models, validate, feedback, calibrate.",
      'Rule 0: compute in code whatever code can (exit codes, grep, counts, dates); send Jev only the residual judgment. Use refs, never paste: "$file:path#L10-80", "$diff" / "$diff:staged", "$log:path". Name untrusted fields untrusted_*.',
      "NOT for: compaction or summary decisions; counting, dates, arithmetic; \"did the tests pass\" (read the exit code); multi-hop root cause; binary or assembly; flaky-test detection (rerun in code); anything code can compute. NOT for deciding whether a bug report is real or whether a patch fixes a bug (measured AUROC 0.64 and 0.57, near chance); use it there only as a relevance filter.",
      "Measured (11,058 live calls, jev-1.14.0 pinned): up to 30 questions per state in one call (99.2% same verdicts, 12x cheaper; more is refused). Choice: act only at confidence >= 0.95 (framed flips 1.7%, 21% at 0.85-0.95). Noul: p <= 0.1 or >= 0.9 is the high-trust band. Budget ~32k tokens per question: ~48 KB of logs (1.6 chars/token) or ~100 KB of code; trim first, long_context only when trimming fails.",
      "Results: verdict, p, decision (auto | confirm | review) from a preset: gate (default), triage, review_filter, strict. Thresholds are uncalibrated starting values: treat confirm/review as ask-a-human or judge-yourself.",
      "Coding shapes: test triage = jev_batch one item per failure, Choice my_change|preexisting|env_infra|timing|test_bug. Diff review = jev_batch items_from \"$diff:staged\", narrow Nouls where true = bad, preset review_filter. File rerank = recipe rerank on ~16 shortlisted files.",
      `Recipes (jev_ask {recipe, args}):\n${examples}`,
      "If a call returns kind unavailable, rate_limited or budget_exceeded: judge inline yourself; do not retry in a loop. Secrets are always redacted before sending. Full guide: resource jev://guide.",
    ].join("\n\n");
  }

  static full(recipes: Recipe[]): string {
    return GuideText.render(recipes);
  }
}
