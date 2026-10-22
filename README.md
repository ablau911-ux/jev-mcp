# jev-mcp

<p align="center"><img src="docs/hero.png" alt="An AI robot sprinting out of a laptop screen, surrounded by decision cards" width="720"></p>

A fast, typed-judgment MCP server that lets coding agents (Claude Code first) ask TypeSafe's **Jev**
yes/no, choice, score and box questions, and act on the answer.
See `SPEC.md` for the full design and `PROBE-RESULTS.md` for live measurements.

> **What Jev is.** Jev is the first **System One** model from [TypeSafe](https://typesafe.ai): a model
> built to be used by machines, not to chat. *"Send state and typed questions; get structured answers
> your code can use directly."* It never writes text or code; it returns typed decisions with calibrated
> probabilities and a separate confidence, so software can act when confidence is high and escalate when
> it is low. TypeSafe's own comparison on a System One task: **0.114 s vs 8.566 s** and **$0.000081 vs
> $0.013880** against an LLM. With this server, the ~110-call live probe cost about **$0.002** in total.
>
> **What jev-mcp adds.** Three tools for coding agents, input refs instead of pasted state
> (`$file:`, `$diff`, `$log:`), a secret guard that masks credentials before anything is sent, decision
> presets (`auto | confirm | review`), caching, rate and cost caps, and calibration from your own feedback.
> Stdio MCP server, TypeScript, Node >= 22, ESM, `@typesafe-ai/sdk` **0.7.0** (exact pin).

## Question types
| Type | Jev returns | Typical use in coding work |
|---|---|---|
| **Noul** | probability that the answer is *yes* | "Does this diff hunk change behaviour?", gate an action |
| **Choice** | one option from a set, a probability per option, confidence | triage a failing test: my change / pre-existing / environment / timing / test bug |
| **Score** | a level on an ordered, described scale, probabilities, confidence | rate the risk of a change, grade a review comment |
| **Box** | four edges of a region in an image (fractions of width/height) | find a button or field in a screenshot |

Ground truth for the API: the TypeSafe docs at <https://docs.typesafe.ai> (index:
<https://docs.typesafe.ai/llms.txt>) and the schema at <https://api.typesafe.ai/openapi.json>.
Where `SPEC.md` disagrees with them, the official docs win.

## Where Jev helps, from our tests
Measured with this server's stress suite (about 11,000 live calls on jev-1.13.0 / jev-1.14.0, 95% intervals,
synthetic and real labelled items). Ranked from most to least useful for coding work:

| Rank | Task | Result | Verdict | Final decision |
|---|---|---|---|---|
| 1 | **Triage of failing tests and logs** (what kind of failure is this?) | 100% accuracy, AUROC 1.000 on labelled test logs | Use it | Confirmed: same answers as a large model at about 1/80 of the cost. Jev handles it. |
| 2 | **Clear, one-step classification** (language, intent, sentiment, category) | 96.7 to 100% accuracy, AUROC 0.999; paraphrases agree 99.3% | Use it | Confirmed: a tie with a large model; disputed severity calls upheld 4 of 4. Jev handles it. |
| 3 | **Many questions about one state** (batch up to 30 per call) | same verdict as separate calls in 99.2% of pairs, **12.4x cheaper, 29.9x faster** | Use it | Server default: up to 30 questions per request. |
| 4 | **Finding a fact in a long file or log** | 100% needle accuracy from 1 KB to 256 KB (long-context header above ~48 KB of logs) | Use it | Trim first; long context only when a log is over the limit. |
| 5 | **Gating on confidence** (act when sure, ask when not) | at confidence >= 0.9: 100% accuracy on 85% of items | Use it | `auto` only at p <= 0.1 or >= 0.9 (Choice: confidence >= 0.95); the rest goes to `confirm`. |
| 6 | **Scoring on a scale; locating a region in a screenshot** | score: 97.5 to 100% exact level; box: mean IoU 0.73, 87% hits | Use it, compare levels, not exact p | Compare levels and bands, never p to two decimals. |
| 7 | **Screening diff hunks for relevance** | 94% on security-diff decoys; mismatched bug/hunk pairs rejected 100% | Use it as a filter | First, cheap filter; the final code review stays with tests and a second review. |
| 8 | **Subjective engineering choices** ("A or B?") | winner changed with wording in 19.6% of framed calls, with option order in 17 to 33% of subjective items | Only with an order check and a human | Reversed-order check; a changed winner goes to `review`, never `auto`. |
| 9 | **Three-step reasoning chains** | 73 to 87% (two steps: 100%) | Split into single steps | One step per question; compute the rest in code. |
| 10 | **"Is this bug report real?" / "Does this patch fix the bug?"** | AUROC 0.64 and 0.57: near chance; accuracy equals the always-yes base rate | Do not use; run the tests, ask a reviewer | No model decides this: tests and a review do. A high p is never proof that a fix is right. |

Against a large general-purpose model judging the same items inline, Jev tied on clear classification, was also unusable on
the two hard judgments, and cost about **80x less** (about $0.00005 vs $0.0039 per item) at about 0.3 s per call.

### Jev models compared
The same test sets on every model we could call (2026-10-21). `jev-preview` answered as jev-1.14.0 at the
time, so its column is a second sample of 1.14.0.

| Measure | jev-1.13.0 | jev-1.14.0 | jev-preview |
|---|---|---|---|
| Accuracy, 210 labelled items | 96.7% | **98.6%** | 98.1% |
| AUROC / calibration error (ECE) | 0.999 / **0.039** | 0.998 / 0.049 | 0.999 / 0.054 |
| Clear items, 10 options: accuracy | **100%** | 99.5% | 99.5% |
| First-position bias, 10 options (none = 10%) | 9.2% | 10.0% | 10.4% |
| Verdict flips over 20 identical calls | 0 | 0 | 0 |
| Three-step reasoning | 73.3% | **86.7%** | 80.0% |
| Counting / arithmetic | 90.0% / 96.7% | **93.3% / 100%** | 93.3% / 100% |
| Dates, negation, long numbers, Hebrew = English | 100% | 100% | 100% |
| Prompt injection inside the state: flip rate | 7.3% | **2.1%** | 1.7% |
| Latency p50 / p95 | 262 / 326 ms | **225 / 278 ms** | 222 / 280 ms |

**Pick:** jev-1.14.0, pinned by default in this server: same accuracy and calibration as 1.13.0, better on
three-step reasoning and prompt injection, and about 15% faster. Pin a version rather than a moving alias,
so a model change never shifts your thresholds silently.

### Short demo: triage a failing test
The agent pastes nothing; it sends the log line and five labelled options:

```json
jev_ask {"recipe": "classify", "args": {
  "state": "FAIL test/unit/day-usage-lock.test.ts > reclaims a stale lock: expected 5, received undefined. The test passed before the last commit that changed DayUsageStore.add.",
  "options": {"my_change": "Caused by the current diff", "preexisting": "Failed before this change",
              "env_infra": "Environment or infrastructure", "timing": "Timing or ordering", "test_bug": "The test itself is wrong"},
  "none_option": "noul"}}
```

Live answer (jev-1.14.0):

```json
{"choice": "my_change", "confidence": 1, "probabilities": {"my_change": 1, "preexisting": 0, "env_infra": 0, "timing": 0, "test_bug": 0},
 "usage": {"requests": 1, "input_tokens": 423, "est_cost_usd": 0.000018}}
```

The agent now knows to look at its own last change first, for less than two thousandths of a cent.

## Install

1. **Requirements:** Node.js >= 22, git, and a TypeSafe API key (create one at
   <https://console.typesafe.ai/keys>).

2. **Clone and build** (any folder, any OS):

   ```sh
   git clone https://github.com/ablau911-ux/jev-mcp.git jev-mcp
   cd jev-mcp
   npm install
   npm run build
   ```

3. **API key:** set the environment variable `TYPESAFE_API_KEY`, or put the key in the file
   `~/.typesafe/api-key.txt` (Windows: `%USERPROFILE%\.typesafe\api-key.txt`). The variable wins
   when it is not empty. The key only goes into the `Authorization` header and is scrubbed from
   every output and log.

4. **Register with Claude Code** (user scope), from the clone folder. The command stores the
   absolute path of your clone:

   ```sh
   # bash / zsh
   claude mcp add --scope user jev -- node "$(pwd)/dist/server.js"
   ```

   ```powershell
   # PowerShell
   claude mcp add --scope user jev -- node "$PWD\dist\server.js"
   ```

5. **Any other MCP client:** add a stdio server to the client's MCP config. Use the absolute
   path of your clone:

   ```json
   {
     "mcpServers": {
       "jev": {
         "command": "node",
         "args": ["/absolute/path/to/jev-mcp/dist/server.js"],
         "env": { "TYPESAFE_API_KEY": "<your key>" }
       }
     }
   }
   ```

## Tools (exactly three)

| Tool | Role |
|---|---|
| `jev_ask` | ONE state, N questions in one request. Or a recipe: `{recipe, args}`. Loads upfront (`anthropic/alwaysLoad`). |
| `jev_batch` | N items x ONE question set, one request per item. `items_from: "$diff:staged"` (one item per hunk) or `["$file:a.ts", ...]`. Returns rows `{item, verdict, p, decision}` ranked (top-k) or flagged, a summary and every failure. |
| `jev_status` | `health` (startup check), `usage` (tokens, cost estimate, caps, estimate/actual ratio), `models`, `validate` (offline dry run), `presets`, `feedback`, `calibrate`. |

Recipes (former helper tools): `classify`, `decide`, `verify_claim`, `rerank`,
`self_consistency`, `find_lines`, `locate`. The server `instructions` are the router: routing
words first, rule 0, a "NOT for" list, one example per recipe and the fallback rule, under
4,096 characters. The full guide is the resource `jev://guide`.

Every result is concise JSON (`structuredContent` plus the same text, matching the declared
`outputSchema`): `verdict`, `p`, `conf`, `decision` (`auto | confirm | review`), `model`, an
`id` for feedback. Errors are `isError` with `{kind, message, fix, retryable}`; `kind` is
`invalid_input | too_large | secret | auth | unavailable | rate_limited | budget_exceeded |
cancelled | internal`, plus `cause`, `status`, `request_id` and a JSON-path `loc`.
On `unavailable`, `rate_limited` or `budget_exceeded`: judge inline, do not retry in a loop.

## Input refs (never paste state)

| Ref | Expands to |
|---|---|
| `$file:src/a.ts`, `$file:src/a.ts#L10-80` | the file text (line range, 1-based, inclusive) |
| `$diff`, `$diff:staged`, `$diff:HEAD`, `$diff:<ref>` | `git diff` split per hunk `[{file, hunk, diff}]` |
| `$log:test.log`, `$log:test.log#500` | the last N lines, stack traces cut to the top 5 non-library frames |

Files must be inside the working directory or the client's MCP roots (1 MiB max). Credential
files (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `app.ini`, `.ssh/`, `.aws/`, `.typesafe/`, tea
`config.yml`, `*credentials*`, ...) are refused after realpath, with the same message as a
missing file; errors never echo the allowed roots.

## Safety

- **Secret guard, no override.** Every outbound string (state, instructions, criteria, every
  ref and `$diff` hunk) is scanned. Matches are replaced by `[REDACTED:<kind>]` and the count
  is reported (`secrets_redacted`). Kinds: PEM keys, AWS, GitHub, Gitea, Slack, JWT, Bearer,
  generic `secret=...`, connection strings, every value next to a secret-like key, and live
  secrets read at runtime (the TypeSafe key, the tea token). No argument, env var or config
  key turns it off; `JEV_SECRET_MODE=refuse` only makes it stricter: mode: refuse refuses on
  any detection; the default is redact. It covers accidental leaks; deliberate obfuscation is out of scope.
  Threat model, coverage and how to report: [SECURITY.md](SECURITY.md).
- **Injection.** Name untrusted fields `untrusted_*` (and `$log` / out-of-workspace files count
  as untrusted): a probe Noul runs in the same request and decisions are capped at `confirm`
  (`review` when the probe fires).
- **Egress.** Every call sends data to TypeSafe. Tools carry `openWorldHint: true` and
  `readOnlyHint: true` (Jev changes no local state, which may reduce approval prompts).
  `JEV_CONFIRM_EGRESS=1` adds `anthropic/requiresUserInteraction` (a prompt on every call,
  impractical for agent loops). The vendor's `/legal` terms (retention, region) were not read.

## Models, decisions, calibration

- Text and locate/box are pinned to `jev-1.14.0` (live stress run 2026-10-21: prompt-injection flips 2.1% vs 7.3% on 1.13.0). The cache is keyed on the
  version; aliases are tracked from `response.model`, and a changed version purges its cache
  namespace and caps decisions at `confirm`.
- Presets in config: `gate` (default), `triage`, `review_filter` (recall filter, flags p >= 0.3),
  `strict` (tight bands plus a reversed-order Choice check). Each threshold names its metric
  and says `calibrated: false` and `tuned_on`. The live probe found no first-option bias on
  clear two-option code Choices, so order checks are opt-in.
- Calibration: every decision is logged (metadata only) to `~/.typesafe/jev-decisions.jsonl` (Windows: `%USERPROFILE%\.typesafe\`).
  Labels come from `jev_status {action:"feedback", id, label}` and from auto-labels (a flagged
  hunk later edited, a reranked file later read, a rerun that keeps or flips the verdict).
  `jev_status {action:"calibrate", seed_git:true}` reports ECE and a Wilson-bound threshold per
  preset once 30+ labels exist; it never changes config by itself.

## Hooks (optional, no agent tokens)

`jev-mcp-hook pre-tool-use` asks before a Bash command that is not confidently harmless
(never auto-allows). `jev-mcp-hook post-tool-use` adds a warning when tool output looks like
injected instructions. Both fail open. Register them in `settings.json` only if you want them.

## Limits and defaults

- Price $0.042 per million input tokens (estimate). Context 64k per request, 32k per question,
  refused before sending; `long_context: "auto"` uses the 262k header when needed.
- Token estimates use the probe factors: 3.3 chars/token for code and text, 1.4 for JSON
  structure, 1.2 for Hebrew and other non-Latin text (chars/4 under-counted by 17-69%).
- Timeouts 5 s per attempt, 15 s per call (fitted inside `MCP_TOOL_TIMEOUT` when set).
  Retries: 429, 529, network; other 5xx once; every retry resends the data.
- Session caps: 2M input tokens, 120 requests per minute, 5M per day, 200k tokens/s.
- Batch: 6 workers, cap 8, halves on 429/529. Rerank window 16 (cap 64).
- Images and Box: off unless `JEV_IMAGES=1`. PNG/JPEG; EXIF removed; out-of-range PNGs resized.

## Configuration

`~/.typesafe/jev-config.json` (Windows: `%USERPROFILE%\.typesafe\jev-config.json`) overrides any default in `src/config/defaults.ts`
and `src/config/prompts.ts`, with two floors: the secret guard's patterns and the credential
denylist can only be ADDED to (never removed, replaced or switched off), and a model pin
changes only through `models.override: {text?, locate?}` (results then carry
`model_overridden: true`; tool arguments and env vars cannot change a pin). Environment:
`TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL` (official TypeSafe hosts only), `JEV_COMPRESSION`
(`auto|zstd|off|gzip`), `JEV_CACHE_DIR` (disk cache, refused inside a git repo),
`JEV_BACKEND=mock` (offline placeholders for tests and CI), `JEV_IMAGES`, `JEV_SECRET_MODE`,
`JEV_CONFIRM_EGRESS`, `JEV_LOG_LEVEL`, `MCP_TOOL_TIMEOUT`. Logs go to stderr only.

## Checks and probe

```sh
npm run lint
npm run typecheck
JEV_LIVE=1 npm run probe      # opt-in live probe (~110 calls, ~$0.002); see PROBE-RESULTS.md
```

The probe needs a TypeSafe API key and sends synthetic data only.

## License

MIT
