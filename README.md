# jev-mcp

An MCP server that lets Claude Code use **TypeSafe System One**, model **Jev**: fast typed
judgments (yes/no probability, a label, a graded level) about state you pass. It never
generates text. Use it for cheap checks inside coding work: triage failing tests, review diff
hunks, rerank files, gate an action, check a claim against code.

- Stdio MCP server, TypeScript, Node >= 22, ESM, `@typesafe-ai/sdk` **0.7.0** (exact pin).
- Ground truth for the API: the TypeSafe docs at <https://docs.typesafe.ai> (index:
  <https://docs.typesafe.ai/llms.txt>) and the schema at <https://api.typesafe.ai/openapi.json>.
  Where `SPEC.md` disagrees with them, the official docs win. The live probe numbers are in
  `PROBE-RESULTS.md`.

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
