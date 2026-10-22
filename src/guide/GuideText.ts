import type { Recipe } from "../recipes/Recipe.js";

/** The `jev://guide` resource: prompting rules, coding recipes, hooks and limits (Markdown). */
export class GuideText {
  static render(recipes: Recipe[]): string {
    return [GuideText.HEAD, GuideText.recipes(recipes), GuideText.CODING, GuideText.HOOKS, GuideText.LIMITS].join("\n\n");
  }

  private static recipes(recipes: Recipe[]): string {
    const rows = recipes.map((r) => `### ${r.name}\n${r.summary}\n\nArgs: ${Object.keys(r.schema).join(", ")}\n\nExample: \`jev_ask {recipe:"${r.name}", args:${JSON.stringify(r.example)}}\``);
    return `## Recipes\n\n${rows.join("\n\n")}`;
  }

  private static readonly HEAD = `# Jev guide (jev-mcp)

Jev (TypeSafe System One) returns typed judgments about the state you send. It never generates text.

| Type | Answers | Returns |
|---|---|---|
| noul | Is this true? | p = probability of yes |
| choice | Which option? | verdict = label, p = top probability, conf |
| score | Which level? | verdict = level, p = normalized 0-1, conf |

Every answer also has \`decision\` (auto | confirm | review) from a preset (gate, triage, review_filter, strict).
Thresholds come from config, name their metric and are \`calibrated: false\` until \`jev_status {action:"calibrate"}\`
fits them on labels (\`jev_status {action:"feedback", id, label}\`).

## Rules
1. Rule 0: do in code whatever code can compute; ask Jev only the residual judgment.
2. One property per question; narrow Nouls beat holistic ones (0.95 vs 0.56). Phrase so yes = the property holds.
3. All questions about one state go in ONE jev_ask call; many states go in ONE jev_batch call.
4. Use refs instead of pasting: \`$file:path#L10-80\`, \`$diff\`, \`$diff:staged\`, \`$diff:<ref>\`, \`$log:path#200\`.
5. Name untrusted content \`untrusted_*\`: an injection probe runs and decisions are capped at confirm.
6. Choice: describe what each option means; add a none option. The probe found no first-option bias on clear
   two-option code cases, so order checks are opt-in (\`strict\`, classify \`order_check\`).
7. Questions and criteria in English (state may be any language).
8. Secrets never leave the machine: they are redacted (\`[REDACTED:<kind>]\`); credential files are refused.`;

  private static readonly CODING = `## Coding recipes (research section 3)

| Use | Shape | Notes |
|---|---|---|
| Test triage | jev_batch, one item per failing test: name, assertion line, top 5 frames (\`$log:\` trims frames). One Choice my_change, preexisting, env_infra, timing, test_bug, plus a Noul "is the failure explained by the state?" | First check in code whether a failing frame touches a diffed file. Never ask "did it pass?": the exit code answers it (silent success p was only 0.74). |
| Diff review | jev_batch \`items_from:"$diff:staged"\`, preset review_filter, narrow Nouls where true means bad: "removes error handling", "hardcodes a secret or URL", "changes a public signature". Combined with max. | Recall filter (flag at p >= 0.3). Read the flagged hunks yourself; Jev gives no reason. |
| File rerank | recipe rerank, one Noul per (query, file), shortlist ~16 (cap 64) | Never one Choice over hundreds of files: margins 0.02-0.08. |
| Flaky detection | Not a Jev job. Rerun N times in code. | Jev may label one log as timing- or env-shaped, as a hint only. |

NOT for: compaction or summary decisions, counting, dates, arithmetic, silent test success, multi-hop root cause,
binary or assembly code, anything code can compute. NOT for deciding whether a bug report is real (AUROC 0.64 on
147 real findings) or whether a hunk fixes a bug (AUROC 0.57 vs Codex): use it there only as a relevance filter
(mismatched bug/hunk pairs were rejected 40/40).

Fallback: if a call returns \`unavailable\`, \`rate_limited\` or \`budget_exceeded\`, judge inline and move on.`;

  private static readonly HOOKS = `## Hooks (no agent tokens)

Much of Jev's measured value comes from Claude Code hooks, not tools. \`jev-mcp-hook\` shares this server's core:
- \`jev-mcp-hook pre-tool-use\`: gates Bash commands with the \`gate\` preset; a likely-dangerous command returns
  \`permissionDecision: "ask"\`. It never auto-allows.
- \`jev-mcp-hook post-tool-use\`: screens tool output for injected instructions; a hit adds a warning to the context.
Both fail open (no output) when Jev is unavailable. Registering hooks is the user's choice (settings.json).`;

  private static readonly LIMITS = `## Limits
- Context: 64k tokens per request, 32k per question; long_context: 262k, 2 to 8x slower. Estimates use measured
  factors (code 3.3, JSON 1.4, Hebrew 1.2, dense logs and numbers 1.6 chars/token): ~48 KB of logs or ~100 KB of
  code per question. Trim first ($log tail, line ranges, hunks); long_context only when trimming fails.
- Questions: at most 30 per state in one jev_ask / jev_batch request (more is refused).
- Body <= 32 MiB; nesting <= 64; finite numbers; big ids as strings; UTF-8 without BOM.
- Timeouts: 5 s per attempt, 15 s per call; retries only 429/529/network (5xx once); every retry resends the data.
- Session caps: input tokens, requests per minute, a daily limit (config \`session\`).
- Models: text and locate pinned to jev-1.14.0 (never an alias); every result names the model.

## Measured (stress test, 11,058 live calls)
- Clear single-hop judgments: 96.7 to 98.6% accurate; at confidence >= 0.9, 100% on 210 labelled items.
- Batching 30 questions = 30 separate calls in 99.2% of verdicts, 12.4x cheaper, 29.9x faster.
- Choice framing: answers at confidence >= 0.95 flipped 1.7% under other wording, 21% at 0.85 to 0.95;
  the gate preset acts only at >= 0.95. Write neutral options; facts go in state.
- Prompt injection inside state: 2.1% flips on jev-1.14.0 (7.3% on 1.13.0). Keep untrusted text in its own field.
- Probabilities jitter by up to 0.04 (noul) between identical calls: compare verdicts or bands, not raw p.
- Images and Box: off unless JEV_IMAGES=1; experimental.
- Price: $0.042 per million input tokens (estimate, not billing). Every call sends data to TypeSafe.`;
}
