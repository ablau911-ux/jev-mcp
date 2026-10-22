# Jev MCP Tool: Implementation Spec (v0.1)

**Source tags.** A path like `/images.md` means `https://docs.typesafe.ai/images.md`. `openapi` means `https://api.typesafe.ai/openapi.json`.

**Markers.**
- **(TOOL DECISION)** is a choice this spec makes that the docs do not.
- **(UNCERTAIN)** means the docs are silent, conflict, or were only seen through summaries.

**Digest caveat.** Every digest was produced by a small summarizing model, not verbatim text. Implementation step 0 is to read `https://api.typesafe.ai/openapi.json`, `/api/system-one.md` and `/api/errors.md` verbatim. Generate types from the OpenAPI file and add a conformance test (section 6). Where this spec and the official schema disagree, the schema wins.

---

## 1. Scope and principles

**Purpose.** The server exposes TypeSafe System One (model family Jev) to coding agents as cheap, fast, calibrated judgments about a piece of state. Examples:
- classify a failing-test log
- decide whether a diff touches auth code
- rerank candidate files for a query
- find the line that matches a description
- verify that a claim is supported by evidence
- triage issues in bulk
- locate a UI element in a screenshot

Docs basis: `/introduction.md`, `/concepts/system-one.md`, `/concepts/use-case-map.md`. Most queries take about 100 ms, and extra questions barely change latency (`/primitives.md`).

**What it is not.** From `/model-jaggedness/jev-1.13.md`, the tool descriptions must state all of these:
- Jev outputs typed judgments constrained to supplied options. It never generates free text, code or patches.
- It does not count, do math, or handle hex/RGB/binary. Ask one yes/no per item and sum in code.
- It does not parse dates. Extract parts via Choice (including a "not stated" option) and compute in code.
- Score magnitudes are poorly calibrated, so use them for threshold checks only.
- It can be swayed by adversarial or injected text inside `state`.
- It reads literally.
- Large irrelevant state hurts accuracy, so filter first.

**Typed judgments, never text generation.** All outputs are typed fields: `noul` (probability 0-1), `choice` (label plus probabilities plus confidence), `score` (expected level), `box` (fractions). The tool adds only derived numbers (section 3) and code-side decisions. It never asks Jev to write prose.

**Key handling.**
- Resolution order **(TOOL DECISION)**:
  1. `TYPESAFE_API_KEY` env var, if non-empty after trim.
  2. Else the file `%USERPROFILE%\.typesafe\api-key.txt`.
  3. Else a structured error `no_api_key` with setup instructions, which never includes any secret.
- Read the file as UTF-8, strip a BOM, trim whitespace.
- Mirror the SDK key validation (`/sdk/python`, `/sdk/python/usage/basic.md`). Reject empty keys, internal whitespace, control characters and non-ASCII. An explicitly empty env var does not fall back to the file.
- Keys are created at `https://console.typesafe.ai/keys`.
- The key is held in one `KeyProvider` object. It is placed only in the `Authorization: Bearer` header of outbound requests. It is never returned in tool output, error text, logs, cache keys or the usage ledger. `jev_usage` reports only `key_source: "env"|"file"|"missing"`.
- Docs warn that SDK debug logging does not redact bodies (`/sdk/javascript/api/interfaces/TypeSafeClientConfig.md`, `/sdk/python/usage/advanced.md`). The tool therefore never enables SDK debug logging and uses its own logger (section 4.6).

**Data handling.**
- Per `/legal.md` and `/models.md`, TypeSafe does not train on customer data, and zero data retention is available for enterprise accounts.
- State sent from a coding agent is still source code or logs going to a third party. See the secret guard (section 4.2) and the opt-in-only disk cache (section 4.7).

**Stack (TOOL DECISION).**
- TypeScript, Node >=22, stdio MCP server, `@modelcontextprotocol/sdk`, `zod`.
- Transport is the official `@typesafe-ai/sdk` (v0.7.0 at 2026-10-14). It already implements multipart, zstd, retry policy, error classes and request ids (`/sdk/javascript.md`).
- The SDK is wrapped behind a `JevTransport` interface so a raw-fetch implementation can replace it. The mocked-fetch tests use the SDK's `fetch` config hook.
- The Node requirement conflicts across pages. `/introduction/quickstart.md` says Node 20+, but `/sdk/javascript.md` says >=22, and zstd needs 22.15+. Use >=22.
- Class layout, per the OOP rule: `KeyProvider`, `ConfigStore`, `JevTransport`, `RequestValidator`, `AssetPacker`, `FileRefResolver`, `RateGate`, `UsageLedger`, `ResponseCache`, `SafeLogger`. Each MCP tool is one class with `schema` and `run()`.

---

## 2. API contract (only what the docs state)

### 2.1 Endpoints and headers

| Item | Value | Source |
|---|---|---|
| Answer questions | `POST https://api.typesafe.ai/v1/systemone` | `/api/system-one.md`, `/introduction/quickstart.md` |
| List models | `GET https://api.typesafe.ai/v1/models` returns `{models:[{name, description, release_date YYYY-MM-DD}]}`. Versioned IDs are accepted even if not listed. | `/api/list-models.md` |
| Base URL override | `TYPESAFE_BASE_URL` (default `https://api.typesafe.ai`) | `/sdk/javascript/api/interfaces/TypeSafeClientConfig.md` |
| Auth | `Authorization: Bearer <API_KEY>` | `/introduction/quickstart.md` |
| Content type | `application/json`, or `multipart/form-data` when images are present | `/api/system-one.md` |
| Compression | `Content-Encoding: gzip`, `x-gzip` or `zstd`. Only one layer. zstd window <= 8 MiB. Unsupported or multiple layers return 415. A malformed body returns 400. | `/api/errors.md` |
| Images opt-in | `TypeSafe-Danger-Zone-Images: true` on every request containing an image asset or a Box question. The only valid value is `true`. | `openapi`, `/images.md` |
| Long context | `TypeSafe-Danger-Zone-Long-Context: true` raises both context limits to 262k tokens. Same per-token price, slower and less accurate. | `/models.md`, `openapi` |
| Response headers | `x-typesafe-request-id` (surface in every error), `Retry-After`, `retry-after-ms` | `/sdk/javascript/api/classes/APIError.md`, `/sdk/python/api/retries.md` |

Alternative gateways (OpenRouter, Vercel AI Gateway, Pydantic AI Gateway) are supported only by setting `TYPESAFE_BASE_URL` and the model name (`/sdk/python/usage/basic.md`). Gateway behaviour is not part of this contract.

### 2.2 Request body

`SystemOneRequest` (`openapi`):

| Field | Type | Rules |
|---|---|---|
| `model` | string, required | A name or an alias. The tool always sends it (default `jev-latest`). |
| `state` | string, object or array, required | JSON text. Nested; may contain asset references. |
| `questions` | object, required, minProperties 1 | Keys are user-chosen ids and are echoed in `answers`. Ids are never shown to the model (`/primitives/choice.md`). No fixed question-count limit; the practical limit is model context (`/primitives.md`, `/models.md`). |
| `assets` | object, optional, minProperties 1 | Placeholder to Asset (section 2.5). |

Extra unknown properties are forwarded by the JS SDK (`/sdk/javascript/api/interfaces/SystemOneRequest.md`). The tool does not use that.

`instructions` and criteria values are `EntryType`: a string, object, array or null (`/primitives/advanced.md`). Object field names such as `focus`, `not_for`, `examples`, `what` and `question` are user-defined, not reserved. Backticked dot/index paths such as `` `support.tickets[0].message` `` point a question at a nested part of state (`/concepts/how-to-build-with-system-one.md`).

### 2.3 Question types

| Type | Request | Answer | Source |
|---|---|---|---|
| `noul` | `instructions` (EntryType, may be null). Optional `criteria: {true?, false?}`. At least one of instructions or an outcome description is required (SDK validation). | `{type:"noul", noul}` is the probability of yes/true, 0-1. No `confidence` field. | `/primitives/noul.md`, `openapi`, `/sdk/javascript/api/classes/TypeSafeClient.md` |
| `choice` | `instructions` optional. `criteria` required: object `label -> description` (string/object/array/null), 1..255 entries. A null description means the name alone is used. | `{choice, confidence 0-1, probabilities{label:p}}`. `choice` is the argmax. Probabilities sum to about 1. | `/primitives/choice.md`, `openapi` |
| `score` | `instructions` optional. `criteria` required: ordered array of level descriptions, low to high. Position is the level value, starting at 0. The API says 1..10 items; the SDK and primitives page say 2..10. | `{score, confidence, legend{level:description}, probabilities{level:p}}`. `score` is the probability-weighted expectation, 0..(levels-1), often non-integer. Level numbers are invisible to the model. | `/primitives/score.md`, `openapi`, `/sdk/python/api/types/responses.md` |
| `box` | `instructions` says what to locate; no criteria. Needs the Images header and a vision model. | `{box:{top,bottom,left,right}, confidence}`. All values are fractions 0-1 from the top-left, with left<right and top<bottom. `confidence` may be null. It always returns a box even if the target is absent. | `/primitives/box.md`, `/api/system-one.md` |

All questions in one request are evaluated independently and in parallel against the same state. Any mix of types is allowed (`/primitives.md`).

**Box status.** Box is "Dreamer-ready", not production-recommended (`/primitives/box.md`).
- The model must be `jev-preview` or `jev-1.14.0`.
- The JS SDK says `jev-preview` is required, and the box page says either works. Both resolve to the same release (`/models.md`).

**Confidence semantics** (`/confidence.md`):
- Choice confidence = `(p_max - 1/n) / (1 - 1/n)`.
- Score confidence penalizes mass far from the top level.
- Noul has none; use `|2p-1|`.
- Confidence describes concentration of the output, not correctness.

### 2.4 Response

`SystemOneResponse`: `model` (the versioned model that answered, which may differ from the alias), `answers` (keyed by question id, each with the matching `type`), and `usage{input_tokens, output_tokens}` (`openapi`).
- `input_tokens` is billable. `output_tokens` is currently free.
- The SDKs type both as nullable. The tool must tolerate null.
- Unknown answer kinds and unknown fields are skipped with a warning (`/sdk/python/usage/advanced.md`).

### 2.5 Models, pricing, context

| Fact | Value | Source |
|---|---|---|
| Aliases | `jev-latest` -> `jev-1.13.0` (stable, SDK default). `jev-preview` -> `jev-1.14.0` (most recent). Aliases change on release. | `/models.md` |
| Pinned versions | `jev-1.13.0`, `jev-1.14.0` (released 2026-10-14). Cookbooks also use `jev-1.12` (UNCERTAIN: may be retired). | `/models.md`, cookbooks |
| Price | $0.042 per 1M input tokens, output free. `/models.md` writes it as "$42 per billion tokens". Cookbook pages call the rate "historical, not verified billing". Treat as an estimate. | `/models.md`, `/cookbooks/sde_cascade.md` |
| Context | 64k tokens per request (state + all questions), 32k per question (state + one question). Long-context header: 262k for both. | `/models.md` |
| Modality | Text only per `/models.md` (UNCERTAIN: conflicts with images, below). | `/models.md` |
| Language | English best. Other languages, including CJK, are accepted with lower accuracy. | `/models.md` |

### 2.6 Images and assets

Images are experimental, and PNG/JPEG only (`/images.md`, `/sdk/javascript.md`).

Conflict (UNCERTAIN): `/models.md` says "text input only", but `/images.md` says "Jev 1.13 and 1.14 both accept images", and `openapi` says image assets need a vision-language model. Follow `/images.md` and the OpenAPI file. The live smoke test covers an image request on the 1.14 alias.

- Images may appear in state, instructions or criteria of any question type.
- The top-level `assets` map is keyed by a reference string. The reference is placed anywhere in state/instructions/criteria, either as a whole value or inside a longer string.
- Object keys are not replaced.
- **Every asset must be referenced, or the API returns 400** (`/images.md`).
- Each reference use adds the image again to the token count. An image in state is sent once for all questions. An image in instructions is sent once per question using it.
- Reference <= 1,024 bytes. All references combined <= 65,536 bytes. Use a new UUID per image.
- Asset fields: `type:"image"`, `part` (multipart part name), `data_base64` (no `data:` prefix, no whitespace), `format` (`png|jpg|jpeg`, required with `data_base64`). `part` wins over `data_base64`. The actual format is detected from bytes.
- Multipart (recommended; base64 inflates by about 1/3):
  - The first part is named `request`, with content type `application/json`.
  - Each image is its own part with a unique non-empty name, used by exactly one asset's `part`.
  - Image part content types: `image/png`, `image/jpeg`, `image/jpg`, `application/octet-stream`, or none.

Limits (`/images.md`):
- 16 MiB per image.
- Each side 280-1568 px.
- Total pixels 78,400-2,458,624.
- Request body <= 32 MiB, and all images combined <= 32 MiB after processing.
- The expanded request is <= 32 MiB after reference replacement.
- Animated PNG is rejected.
- EXIF orientation is ignored, so rotate pixels upright first.
- Baseline JPEG is preferred.
- There are no separate image rate limits.

A rejected image fails the whole request, with no partial answers and only one problem reported.

### 2.7 Size and format limits (`/api/errors.md`)

- Body <= 32 MiB, applying to both the compressed and the decompressed form. Headers are excluded.
- UTF-8 JSON, no BOM.
- Maximum nesting 64 levels in state/instructions/criteria.
- Numbers must be finite (no NaN, Infinity or 1e400). Send ids and large numbers as strings.
- Choice <= 255 options. Cookbooks report reliability up to about 240.
- Score <= 10 levels. 11 levels returned a server error (`/cookbooks/parallel_questions.md` family).

### 2.8 Errors

| Status | Meaning | Retry? | Source |
|---|---|---|---|
| 400 | Rule broken (invalid UTF-8, nesting, non-finite number, bad compressed body, images not enabled, rejected/unreferenced asset). Code `max_tokens_exceeded` means the context length was exceeded. | No | `/api/errors.md`, `/images.md` |
| 401 | Missing or invalid key | No | `/api/errors.md` |
| 403 | Permission denied (SDK class only) | No | `/sdk/python/api/exceptions.md` |
| 404 | Not found (SDK class only) | No | same |
| 413 | Body larger than 32 MiB | No | `/api/errors.md` |
| 415 | Unsupported or multiple encodings | No | `/api/errors.md` |
| 422 | Validation. Body `{detail:[{loc,msg,type,input?,ctx?}]}`. | No | `/api/errors.md` |
| 429 | Rate limit. Per organization, in tokens/s and requests/s; numbers are not published. | Yes | `/models.md`, `/api/errors.md` |
| 529 | Overloaded | Yes | `/api/errors.md` |
| 5xx, 408 | Server or request timeout | Yes, per SDK default | `/sdk/.../RetryPolicy.md` |

The error body schema is otherwise undefined (UNCERTAIN). The tool must handle non-JSON error bodies.

### 2.9 Retry policy (SDK defaults, adopted)

From `/sdk/javascript/api/interfaces/RetryPolicy.md` and `/sdk/python/api/retries.md`:
- `maxRetries` 2.
- Retry statuses 408, 429, 500-599, connection errors, and timeouts.
- Backoff 500 ms doubling up to 5000 ms, with jitter 0.25 (a fraction subtracted).
- Honor `Retry-After` and `retry-after-ms`. If the value is above 60,000 ms, fall back to normal backoff.
- Timeout is 10 s per attempt in the JS SDK and has no total budget. The Python SDK uses a 30 s total budget. Cookbooks use 30-120 s clients (UNCERTAIN: no official recommendation).

The tool's own defaults are in section 4.1.

---

## 3. MCP tools

Naming: `jev_*`. All tools return an MCP `content` text block containing the JSON, plus `structuredContent` with the same object. Failures set `isError: true` with the error object from section 4.3.

**Shared types**
- `Entry` = string | number | boolean | null | Entry[] | {[k]: Entry}. Nesting <= 64, numbers finite.
- `Question` = one of the four types in section 2.3, with local limits: choice 1-255 options, score 2-10 levels, noul needs instructions or a criteria entry, box needs instructions. Question ids are non-empty strings.
- `images`: `{"<name>": {path?: string, data_base64?: string, format?: "png"|"jpg"|"jpeg"}}` **(TOOL DECISION)**. Names must match `^<[A-Za-z0-9_.-]{1,64}>$` and are matched literally in string values anywhere in state/instructions/criteria. They are never matched in object keys, mirroring `/images.md`. The `AssetPacker` rewrites each name to a fresh UUID reference and builds `assets`. It refuses unreferenced images before sending (the API would return 400). It auto-adds the Images header and switches to multipart. The SDK's literal-matching advice is the basis for the delimiter rule (`/sdk/javascript/api/interfaces/SystemOneRequest.md`).
- `$file` references **(TOOL DECISION)**: anywhere in `state`, a value `{"$file": "<path>", "start_line"?: n, "end_line"?: n}` is expanded server-side to the file's text. This lets an agent point at files without echoing their contents through its own output tokens. Paths are restricted to the MCP roots and the working directory, with traversal and symlink escapes rejected. The limit is 1 MiB per file, and the content is sent as UTF-8 text.

### 3.1 `jev_ask` (P0): one request, several named questions, one state

**Purpose.** The core wrapper. Packs all questions for one state into a single call, as docs recommend (`/primitives.md`, `/patterns/fan-out.md`). One request with 13 questions was measured as 12.2x cheaper and 10x faster than 13 calls, with the same answers (`/cookbooks/parallel_questions.md`).

**Input**
```json
{
  "state": "Entry (required, non-null)",
  "questions": {"<id>": "Question"},
  "images": {"<name>": {"path": "...", "format": "png"}},
  "model": "jev-latest",
  "long_context": false,
  "cache": true,
  "timeout_ms": 30000,
  "max_retries": 2,
  "verbosity": "compact"
}
```
`long_context` accepts `true`, `false` or `"auto"`. `"auto"` retries once with the long-context header after a 400 `max_tokens_exceeded`. Default is false because the docs say long context is slower and less accurate.

**Output**
```json
{
  "model": "jev-1.13.0",
  "answers": {
    "<id>": {"type": "noul", "noul": 0.93, "margin": 0.86}
  },
  "usage": {"input_tokens": 0, "output_tokens": 0, "est_cost_usd": 0.0},
  "request_id": "...",
  "latency_ms": 0,
  "cached": false,
  "warnings": []
}
```

Derived fields:

| Type | Fields returned |
|---|---|
| noul | `noul`, `margin = abs(2p-1)` |
| choice | `choice`, `confidence`, `probabilities` (top 5 in compact mode, all in full), `top2_ratio` |
| score | `score`, `normalized = score/(levels-1)`, `confidence`, `probabilities` |
| box | `box`, `confidence` (may be null), `pixel_box` when image dimensions are known |

`est_cost_usd` is an estimate (section 4.5). The tool does not mix thresholds into `jev_ask`; decisions belong to `jev_decide`.

### 3.2 `jev_batch` (P0): many states, concurrency and retries

**Purpose.** The same questions over many states, one request per state (`/cookbooks/rerank_typesafe.md`, `/cookbooks/twitch_chat_filter.md`, `/cookbooks/autoresearch_feature_discovery.md`). Do not use it for several questions over one state; use `jev_ask`.

**Input**
```json
{
  "items": [{"id": "a", "state": "...", "images": {}, "questions": "optional per-item override"}],
  "questions": {"<id>": "Question"},
  "model": "jev-latest",
  "pin_model": true,
  "concurrency": 6,
  "max_retries": 3,
  "stop_on_first_error": false,
  "max_total_input_tokens": null,
  "only_ids": null,
  "output_path": null,
  "return": "failures"
}
```
- `items` has at most 5000 entries and defaults to 500 **(TOOL DECISION)**.
- `return` is `"all"`, `"summary"` or `"failures"`.
- `output_path` writes full per-item results as JSONL. The reply then carries only the summary and the path, which saves agent tokens.
- `pin_model` takes the versioned `model` from the first successful response and uses it for the remaining items. The docs say aliases change on release (`/models.md`). Mixed models are reported in the summary.
- `only_ids` re-runs failures after a partial run. Cache hits make reruns cheap.

**Concurrency** (`RateGate`; numbers are doc-informed but unofficial):
- Default 6. Docs use 6-12 workers. The rerank page says the public endpoint rate-limits above about 8 workers, and entity alignment uses 6 (`/cookbooks/rerank_typesafe.md`, `/cookbooks/entity_alignment.md`). The default hard cap is 8; a config value can raise it with a warning.
- On any 429 or 529:
  1. Halve concurrency (minimum 1).
  2. Honor `Retry-After`/`retry-after-ms` through a shared pause gate that holds all workers.
  3. Add 1 back after every 20 consecutive successes.
- Retries within one item use the section 4.1 policy. Backoff for batches defaults to 1.0 s initial and 20 s max with 5 retries, matching `/cookbooks/hierarchical_classification.md`.
- `max_total_input_tokens` stops launching new requests when cumulative real usage reaches the cap. Remaining items are marked `skipped_budget`.

**Output**
```json
{
  "summary": {"total": 0, "ok": 0, "failed": 0, "cached": 0, "skipped_budget": 0,
              "models_seen": [], "usage": {}, "wall_ms": 0,
              "final_concurrency": 0, "rate_limit_events": 0, "output_path": null},
  "results": [{"id": "a", "ok": true, "answers": {}, "usage": {}, "request_id": "..."},
              {"id": "b", "ok": false, "error": {"kind": "rate_limited", "status": 429}}]
}
```
Counting must be done in code: have each item answer one yes/no, then sum the results in code (`/model-jaggedness/jev-1.13.md`).

### 3.3 `jev_models` (P0)

`GET /v1/models` (`/api/list-models.md`). Input: `{refresh?: boolean}`. Output: `{models:[{name, description, release_date}], observed_aliases: {"jev-latest": "jev-1.13.0", "jev-preview": "jev-1.14.0"}, source: "live"|"cache"}`.
- `observed_aliases` is built from the static table in `/models.md`, labelled with its date, and updated from the `model` field of live responses during the session.
- The listing is cached in memory for 10 minutes. An optional `name` argument returns one entry.

### 3.4 `jev_validate` (P0): offline dry run

Takes the `jev_ask` input. It makes no network call and returns `{valid, errors[], warnings[], request_summary:{body_bytes, est_tokens, headers_needed, multipart, n_questions, n_images}}`. It runs every check in section 4.2. It is also the unit-test target for validation.

### 3.5 `jev_usage` (P0)

Returns `{session:{requests, cached_hits, input_tokens, output_tokens, est_cost_usd, by_tool, by_model}, key_source, base_url, default_model}`. `reset: true` clears the counters.

### 3.6 `jev_classify` (P1): choice shortcut with safeguards

**Input**
```json
{
  "state": "Entry",
  "options": {"label": "description or null"},
  "instructions": "optional",
  "none_option": "off",
  "order_check": 0,
  "overflow": "error",
  "model": "jev-latest"
}
```
`none_option` is `off`, `noul` or `label`. `overflow` is `error` or `chunk_rerank`.

Behaviours, each from the docs:
- **None of the above.** `noul` adds a Noul in the same request: "Does any option apply?". The docs advise pairing a Choice with a Noul for this (`/primitives/choice.md`). `label` adds a literal `none` option (`/cookbooks/date_extraction_cookbook.md`, `/cookbooks/semantic_find.md`).
- **Order bias.** The jaggedness page notes first-option bias and says to reorder and check consistency (`/model-jaggedness/jev-1.13.md`). With `order_check = k` (1-4), the tool adds k extra Choice questions in the same request with the criteria keys permuted. It reports `agree` and the per-order choices. UNCERTAIN: this assumes the server preserves JSON object key order; the docs say only "keep sibling option order stable".
- **More than 255 options.** `chunk_rerank` splits the options into chunks of at most 200 and asks one Choice per chunk in a single request. It then runs a second request with the chunk winners as options (`/cookbooks/skill_suggestion.md`, `/cookbooks/classification_using_confidence.md`). Above about 240 options a warning is added either way.
- Descriptions guidance: describe what an option means, make options mutually exclusive, and spell out edge cases (`/cookbooks/function_calling.md`).

**Output.** `{choice, confidence, probabilities, none_applies?, order_check?, warnings}`.

### 3.7 `jev_decide` (P1): confidence-gated decision

**Purpose.** One question plus a code-side policy, returning an action band (`/patterns/confidence-routing.md`, `/confidence.md`).

**Input**
```json
{
  "state": "Entry",
  "question": "Question",
  "policy": {"stakes": "normal", "noul": {"no_below": 0.3, "yes_above": 0.7},
             "confidence": {"review_below": 0.6, "auto_at": 0.85},
             "per_choice": {"approve_transfer": {"review_below": 0.6, "auto_at": 0.85}}},
  "model": "jev-latest"
}
```
`policy` is optional. `stakes` is `low`, `normal` or `high`, and picks a named policy from the config file. Explicit `policy` fields override the named policy.

**Rules**
- Choice, score and box use `confidence`. Below `review_below` gives `review`. Between the thresholds gives `confirm`. At or above `auto_at` gives `auto`.
- Noul uses the probability bands. At or below `no_below` is a confident no. At or above `yes_above` is a confident yes. Anything between is `review`. The band edges follow `/cookbooks/consistency_noul_cookbook.md`. Riskier actions need higher thresholds (`/patterns/confidence-routing.md`).
- Defaults in the config file **(TOOL DECISION)**, all editable and none hardcoded in code:

| Stakes | review_below | auto_at | Basis |
|---|---|---|---|
| low | 0.5 | 0.7 | `/confidence.md` ("<0.5 to human") |
| normal | 0.6 | 0.85 | `/patterns/confidence-routing.md` (0.6 floor, 0.85 auto) |
| high | 0.6 | 0.9 | `/confidence.md` (">0.9 for high-stakes") |

- The docs state no official thresholds, and every number is illustrative. Tuning on your own data is advised (`/concepts/how-to-build-with-system-one.md`, `/confidence.md`). Boundary semantics: "equal 0.60 selects" (`/cookbooks/consistency_choice_cookbook.md`).

**Output.** `{action: "auto"|"confirm"|"review", answer, metric:{name, value}, thresholds_used, reason}`.

### 3.8 `jev_verify_claim` (P1)

**Purpose.** Check a claim against evidence, such as "this comment says the function is thread-safe" or "this log line proves the retry happened".

**Input.** `{claim: string, evidence: Entry, mode?: "supported"|"citation", exact_match_first?: boolean, model?}`.

**Behaviour**
- The tool sends two Noul questions in one request over `{claim, evidence}`: `supports` ("Does the evidence state or clearly imply the claim?") and `contradicts` ("Does the evidence contradict the claim?"). Wording is a TOOL DECISION based on the true/false-statement style in `/introduction/quickstart.md` and the RAG screening cookbook (`/cookbooks/classifying_rag_passages.md`).
- Labels derived in code: `supported`, `contradicted`, `unsupported`, `uncertain`. In `citation` mode, labels follow `/cookbooks/citation_check.md`: `verified`, `contradicted`, `unsupported`, `fabricated`.
- With `exact_match_first`, a normalized exact-match check (whitespace and curly quotes folded; the match must not split a word or number, so "limit is 3" does not match "limit is 30"; a blank claim is refused) runs before any API call, and only survivors go to the model (`/cookbooks/citation_check.md`). Pass the surrounding section as evidence, not just the quote.
- The evidence is untrusted text. The description warns that injected text in evidence can sway the model (`/model-jaggedness/jev-1.13.md`, `/cookbooks/classifying_rag_passages.md`).

**Output.** `{label, p_supports, p_contradicts, band, exact_match?, usage}`.

### 3.9 `jev_rerank` (P1)

**Purpose.** Order candidates (files, snippets, search hits) by relevance to a query.

**Input.** `{query: Entry, candidates: [{id, text|Entry}], mode: "pointwise"|"listwise", top_k?, instructions?, concurrency?, model?}`.

- **pointwise** is one Noul per candidate over `{query_excerpt, candidate_passage}`, one request per pair, run through the `jev_batch` machinery. This follows `/cookbooks/rerank_typesafe.md`, which uses a BM25 shortlist of 30 and 12 workers while noting rate limits above about 8. Sorted by `noul` descending.
- **listwise** is one Choice over the candidate ids (at most 255 options; the rerank-style two-stage run is in `/cookbooks/skill_suggestion.md`). Above 200 candidates the tool chunks and reranks the winners as in `jev_classify`. The output gives the probabilities as the ordering signal.
- The description advises narrowing a large candidate set with a cheap method (BM25 or grep) first, then using Jev for the final order.

**Output.** `{ranked:[{id, score, rank}], mode, usage}`.

### 3.10 `jev_self_consistency` (P1)

**What the docs support.** The consistency cookbooks measure repeatability and show that Jev is already very repeatable. Mean probability std dev is about 0.01 over 15 samples (`/cookbooks/consistency_choice_cookbook.md`, `/cookbooks/consistency_noul_cookbook.md`). Plain repeated identical calls therefore add little. The useful variants are the reorder check and paraphrase checks.

**Input.** `{state, question: Question, variants: "reorder"|"paraphrase"|"repeat", paraphrases?: Entry[], n?: 3, model?}`.
- `reorder` (choice only) puts n permutations of the options in one request.
- `paraphrase` (noul, choice or score) takes caller-supplied rewordings of the question and sends them all in one request. The tool does not invent paraphrases, which would be text generation by something other than Jev.
- `repeat` sends n separate requests, since duplicate questions in one request may return identical results (UNCERTAIN, see section 7).

**Output.** `{agree: boolean, mean, std_dev, per_variant:[...], flag: "stable"|"unstable"}`. The `std_dev` threshold for `unstable` comes from the config file with no documented default. The cookbook numbers (mean 0.01, max 0.05) are the reference for a first value.

### 3.11 `jev_locate` (P1): box on an image

**Input.** `{image:{path|data_base64,format}, target: string, presence_check: true, pad: 0, clamp: true, model: "jev-preview"}`.

- The tool sends a Box question plus a presence Noul in the same request, because Box always returns a box even if the target is absent (`/primitives/box.md`).
- It sets the Images header and defaults the model to `jev-preview`.
- It converts fractions to pixels when dimensions are known. It can pad outward and clamp to 0-1.
- One target per Box question. If several matches are possible, the description advises adding a Choice with none/one/several.
- Edge refinement and tile search both need image cropping (`sharp` or similar). Both are P2: 4 edge Noul checks on a crop (30 of 36 cuts caught, versus 26 for a single "all inside" check and 20 for outlined-box), and tile search for small targets in large images, locating the tile with a Choice and then running a Box on the tile.
- Warn that Box is not production-recommended.

**Output.** `{present_probability, box, pixel_box, confidence, warnings}`.

### 3.12 `jev_find_lines` (P1)

Find the lines of a file or text that match a description (`/cookbooks/semantic_find.md`).
- Lines are tagged `L###`. One request has a Choice "where" (one option per line) and a Noul "exists".
- Windows are at most 200 lines, with overlap, because Choice is capped at 255 options. The cookbook examples used 218 lines.
- Input: `{state | $file, description, window?: 200, found_at?: 0.7, absent_at?: 0.35}`. The 0.7/0.35 values are the cookbook's, not API defaults.

### 3.13 P2 helpers (spec only; build later)

- `jev_composite_score`: named Score dimensions in one request, normalized by `levels-1`, combined with weights from a profile in config (`/patterns/composite-scoring.md`, `/primitives/score.md`). Output carries per-dimension values and the weighted total per profile.
- `jev_taxonomy_walk`: one Choice per tree level, with children as options. Beam search when top branches are close. Path score is geometric mean of edge probabilities, with epsilon 1e-9 (`/primitives/advanced.md`, `/cookbooks/hierarchical_classification.md`).
- `jev_calibrate`: offline. Takes labeled records `{p_or_confidence, correct}`. Returns accuracy per bin and the lowest threshold meeting a target precision (`/concepts/how-to-build-with-system-one.md`, `/cookbooks/classification_using_confidence.md`).

**Not built.** The cascade pattern (cheap LLM extracts, Jev verifies, a larger LLM escalates) is out of scope. The calling agent is the LLM, and the tool must not call other providers.

### 3.14 Resource and server instructions

- Resource `jev://guide`: the prompting guidance in section 5 in full.
- The MCP `instructions` field at initialize carries a 6-line summary of section 5.

---

## 4. Cross-cutting behaviour

### 4.1 Retries, rate limits, timeouts

- Retry set: 408, 429, 5xx (this covers 529), connection errors, timeouts. Never retry 400, 401, 403, 404, 413, 415, 422. The first group follows the SDK defaults and the second `/api/errors.md`.
- Backoff: 500 ms initial, doubling, 5 s max, jitter 0.25 subtracted. Defaults to 2 retries for single calls and 3 for batch items **(TOOL DECISION)**.
- Retry-After handling: read `retry-after-ms` first, then `Retry-After` (seconds). Cap at 60 s; if exceeded, fall back to normal backoff.
- Timeouts **(TOOL DECISION)**: 30 s per attempt, 120 s per attempt with long context. A total deadline per call of 90 s for single calls. The JS SDK has no total budget, so the tool enforces its own with `AbortSignal`.
- Cancellation: MCP cancellation aborts the in-flight request and pending retries.
- A shared `RateGate` serves both `jev_batch` and the pointwise modes of `jev_rerank` and `jev_find_lines`.

### 4.2 Input validation (mirrors API and SDK rules; all errors before any network call)

| Check | Rule |
|---|---|
| state | non-null; JSON-serializable |
| questions | at least 1; non-empty ids |
| choice | criteria object with 1-255 labels |
| score | criteria array with 2-10 entries (the OpenAPI file says 1; the SDK requires 2) |
| noul | instructions or a criteria entry |
| box | instructions present; model must be `jev-preview` or `jev-1.14.0` |
| numbers | finite. Check before serialization; `JSON.stringify` silently turns NaN into null. |
| text | valid UTF-8, no BOM |
| nesting | <= 64 levels in state, instructions, criteria |
| body size | <= 32 MiB, both compressed and decompressed |
| images | PNG/JPEG magic bytes, <= 16 MiB, sides 280-1568, pixels 78,400-2,458,624, total <= 32 MiB, animated PNG rejected |
| assets | every image referenced; each reference <= 1,024 bytes; all references <= 65,536 bytes |
| context (warning only) | estimated tokens at 80% of 32k per question or 64k per request: warn and suggest filtering, chunking or `long_context`. Token count is estimated (characters/4, UNCERTAIN: no tokenizer is documented), so never block on the estimate alone. |
| prompt lint (warnings only) | numeric-only score levels (docs: they give split, low-confidence results); several propositions in one noul (docs: one proposition per Noul); empty choice descriptions; contradictory criteria |
| secret guard **(TOOL DECISION)** | refuse state matching obvious secrets (PEM private-key header, AWS-style access key ids) unless `allow_secrets: true`. This is a tool-side safety rule, not a docs rule. |

### 4.3 Error output

Structured error: `{kind, status, request_id, message, hint, retryable, detail?}`.

| Condition | `kind` | Hint |
|---|---|---|
| no key | `no_api_key` | Set `TYPESAFE_API_KEY` or create the key file. Never include any key text. |
| 401 | `auth` | Check or recreate the key at the console. |
| 400 + `max_tokens_exceeded` | `context_too_long` | Filter or chunk state, or retry with `long_context: true` (slower, less accurate). |
| 400 other | `bad_request` | Show the server message. For images: header, unreferenced asset, or image limits. |
| 413 | `too_large` | Reduce images or text, or split. |
| 415 | `bad_encoding` | Disable compression (`TYPESAFE_COMPRESSION=off`). |
| 422 | `validation` | Render `detail[].loc` and `msg` readably. |
| 429 after retries | `rate_limited` | Reduce concurrency. Include the retry-after value. |
| 529 / 5xx after retries | `overloaded` / `server_error` | Retry later. |
| timeout, connection | `timeout` / `network` | Retry later. |
| 2xx but invalid shape | `bad_response` | Include the field path. |

Errors always carry the `x-typesafe-request-id` value when one was returned.

### 4.4 Compression and transport

- Default follows the SDK: bodies of 1 KiB or more are zstd-compressed on Node 22.15+, and smaller or unsupported runtimes send them uncompressed (`/sdk/javascript/api/type-aliases/Compression.md`).
- `TYPESAFE_COMPRESSION=off` disables compression for gateways that reject it.
- Reuse one client instance for the whole server process.

### 4.5 Usage and cost tracking

- `UsageLedger` accumulates `input_tokens` and `output_tokens` from each response, treating null as 0 and counting the request. It also keeps per-tool and per-model totals.
- `est_cost_usd = input_tokens * price_per_mtok / 1e6`, with the price from config (default 0.042). The docs say the rate is historical and not verified billing, and the cookbook advises storing tokens and requests rather than derived dollars (`/cookbooks/skill_suggestion.md`, `/cookbooks/sde_cascade.md`). Always label the cost an estimate.
- Images count as input tokens. An image in state is sent once, and an image in instructions once per question that uses it (`/images.md`).
- Optional ledger file `%USERPROFILE%\.typesafe\jev-usage.jsonl` (opt-in via config). It holds timestamps, tool, model, token counts, latency and request ids only, never content.

### 4.6 Logging

- All logs go to stderr, never stdout (stdout is the stdio MCP channel).
- Default level `warn`. At `info`, one line per request: tool, model, question count, status, latency, tokens, request id.
- Bodies and state are never logged. The `Authorization` header and any string matching the loaded key are redacted by a final-pass scrubber, which also covers error messages.
- SDK debug logging is never enabled. `TYPESAFE_LOG_LEVEL=debug` is ignored with a one-time warning because bodies are not redacted at that level.

### 4.7 Caching

- In-memory LRU (default 500 entries) for `jev_ask`, batch items and helper calls. The key is a SHA-256 over canonical JSON (sorted keys): requested model string, state, questions, image content hashes, and the long-context flag. This mirrors `cooksafe.JsonCache`, which keys on state and questions (`/cookbooks/twitch_chat_filter.md`).
- Alias model names expire after 1 hour. Pinned versions never expire.
- Errors are not cached. Cache hits are marked `cached: true` and counted separately.
- Disk cache is opt-in (`JEV_CACHE_DIR`), because state can be source code. `cache:false` skips it per call.
- A cached answer differs from a fresh one by the model's small natural variance (about 0.01 per the consistency cookbooks), so caching is safe for judgments.

### 4.8 Config file

`%USERPROFILE%\.typesafe\jev-config.json` **(TOOL DECISION)**. Holds: default model, timeouts, concurrency and cap, price per Mtok, stakes policies, noul bands, `std_dev` limit, cache settings, usage-ledger flag. Environment overrides: `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`, `TYPESAFE_COMPRESSION`, `JEV_CACHE_DIR`. Precedence follows the SDK: explicit argument, then env, then config file, then defaults; empty or whitespace env values are ignored (`/sdk/javascript/api/interfaces/TypeSafeClientConfig.md`). No threshold or vocabulary is hardcoded in tool code.

---

## 5. Prompting guidance the tool descriptions must carry

Short form goes in each tool's `description`. The full text goes in `jev://guide`.

1. **One property per question.** Ask one specific gut-check judgment. Split complex judgments and combine the answers in code (`/concepts/how-to-build-with-system-one.md`, `/model-jaggedness/jev-1.13.md`).
2. **Keep questions short.** Include only context relevant to the questions. Put context in named fields of an object state, not spliced into strings. Use a plain string state only for simple single-text cases (`/concepts/state.md`).
3. **Point at state with backticked paths** such as `` `ticket.messages[0].text` ``.
4. **Ask many questions at once.** Put all questions for one state in one call, including speculative ones, and ignore irrelevant answers (`/primitives.md`, `/patterns/fan-out.md`). Use a second request only when it depends on the first answers.
5. **Choose the type by output.** Noul for yes/no, Choice for a label, Score for degree, Box for location. Use Score for graded judgments rather than a Noul.
6. **Noul:** phrase so that high means yes, and one proposition per question. Set the threshold by cost: higher when a false yes is costly, with the middle sent to a human (`/primitives/noul.md`).
7. **Choice:** describe what an option means, not the word users type. Make options mutually exclusive with edge cases spelled out. Use `what / not_for / examples` for confusable options. Add a none option or a paired Noul. Keep sibling order stable (`/cookbooks/function_calling.md`, `/primitives/choice.md`).
8. **Score:** describe situations, not degrees. Numeric-only levels give split, low-confidence results. Level numbers and neighbour references are invisible to the model. Use one dimension per Score. 2-10 levels (`/primitives/score.md`).
9. **Read probabilities, not just the winner.** Confidence is concentration of the output, not correctness. Tune thresholds on your own data: plot confidence against accuracy, start conservative, and use higher thresholds for riskier actions (`/confidence.md`).
10. **Do exact work in code.** Counting, math, dates, and hex/RGB/binary values do not belong in a Jev question.
11. **Treat state as untrusted.** Text inside state, especially retrieved or user-supplied text, can sway the answer. Keep accepted and conflicting evidence in separate blocks (`/cookbooks/classifying_rag_passages.md`).
12. **Filter large state first.** Remove irrelevant material, or add a Noul relevance check (`/model-jaggedness/jev-1.13.md`).
13. **English first.** Other languages work with lower accuracy; test them before relying on them (`/models.md`).
14. **Questions are scoped to what you ask.** Pass the context a judgment needs. For example, a spoiler check cannot know viewer progress unless it is in state (`/cookbooks/twitch_chat_filter.md`).
15. **Pin the model** for reproducible work, and read `model` in the response for what actually answered (`/models.md`).
16. **Never use Jev for free-text generation.** To get a span or a value out of text, find candidates with regex or another tool and let Jev pick one (`/cookbooks/pre_parsed_value_extraction_cookbook.md`).

---

## 6. Test plan

**Framework.** `vitest`, TypeScript. A `FakeJevServer` helper implements the contract on an injected `fetch`. No real network in unit tests.

### 6.1 Unit tests (mocked fetch)

1. **KeyProvider.**
   - Env wins over the file.
   - Env is ignored when empty, and falls back to the file.
   - File: BOM stripped, whitespace trimmed.
   - Internal whitespace, control characters and non-ASCII are rejected.
   - A missing key gives `no_api_key`.
   - Property test: a sentinel key never appears in any error, log line, tool output or cache key.
2. **RequestValidator.** One test per row of the section 4.2 table, including NaN/Infinity before serialization, nesting 65, score with 1/2/10/11 levels, choice with 0/255/256 options, noul without instructions or criteria, and box with `jev-latest`.
3. **AssetPacker.**
   - Placeholders are rewritten in whole-value and substring positions, never in object keys.
   - An unreferenced image gives a local error.
   - UUID references, and reference length limits.
   - The Images header is set only when an image or a Box question is present.
   - Multipart layout: `request` first with `application/json`, unique part names, each used once.
   - Image limit checks (PNG/JPEG header parsing, dimensions, pixels, EXIF ignored).
4. **Request building.** The Long-Context header, compression on/off, and a body just under and just over 32 MiB.
5. **Response parsing.** Unknown answer kinds are skipped with a warning. Null usage. Score `probabilities` keys as strings. Box with null confidence.
6. **Retry.**
   - 429 with `Retry-After` in seconds and with `retry-after-ms`.
   - A retry-after above 60 s falls back to backoff.
   - 529 and 5xx retried, up to the max.
   - 400, 401, 413, 415, 422 never retried.
   - Backoff jitter within bounds (fake timers).
   - AbortSignal cancels pending retries.
7. **RateGate / batch.** AIMD halving on 429, recovery after 20 successes, the shared pause gate, concurrency cap 8, `pin_model` switching after the first response, `max_total_input_tokens`, `only_ids`, `stop_on_first_error`, JSONL output.
8. **Derived values.** `|2p-1|`, score normalization, choice `top2_ratio`, pixel conversion, padding and clamping.
9. **Decide.** Threshold boundary values for each band (exactly 0.6, 0.85, 0.3, 0.7), `per_choice` overrides, stakes presets from config.
10. **Helpers.** Verify-claim label derivation and exact-match pre-check; rerank ordering and stable ties; pointwise versus listwise; classify overflow chunking (256 and 500 options); order-check agreement; find-lines windowing and overlap.
11. **Cache.** Key stability under key-order changes, hit and miss, alias TTL, errors not cached, disk cache off by default.
12. **UsageLedger.** Sums with null usage; cost labelled estimate.
13. **FileRefResolver.** Path traversal, symlink escape, size limit, line ranges.
14. **Error mapping.** Every row of the 4.3 table, including 422 `detail` rendering and a non-JSON error body.
15. **MCP protocol.** With an in-memory transport: tool list and schemas, a call round trip, `isError` mapping, cancellation.

### 6.2 Live smoke test (opt-in)

Runs only with `JEV_LIVE=1` and a key present. Total cost is far below $0.01.
1. `jev_models` returns a non-empty list including `jev-latest`.
2. `jev_ask` with one Noul, one Choice and one Score over a tiny state, on `jev-latest`. Assert the shapes, that the choice probabilities sum to 1 within 1e-3, that `usage.input_tokens` is a positive integer, and that `model` is a versioned name.
3. Server-side error path: send a request that passes the local validator but is rejected by the server. This needs a test-only `bypass_validation` hook, because the local score limit is 10 and the docs say 11 levels returned a server error. Assert a `validation`-class error with a request id.
4. Separate gate `JEV_LIVE_IMAGES=1`: a generated 300x300 PNG with a Box and a presence Noul on `jev-preview`. Assert the Images header worked and the box fractions are in range.

### 6.3 Contract drift test

Optional, networked. Fetches `https://api.typesafe.ai/openapi.json` and compares it with the committed schema fragment, failing on any changed field, enum or limit. This catches doc drift, including the conflicts listed in section 7.

---

## 7. Open questions and facts not found in the docs

1. **Image support by model.** `/models.md` says text only; `/images.md` and `openapi` say images work. Which models accept images today, and is `jev-latest` (1.13.0) included?
2. **Score minimum levels.** OpenAPI says 1..10; the SDK and primitives page say 2..10. The local rule is 2.
3. **Score `.score`.** The cookbook wording suggests "picked level", while OpenAPI and the SDK say probability-weighted expectation. The tool follows OpenAPI.
4. **Node version.** Quickstart says 20+; the JS SDK page says >=22.
5. **Rate limit numbers.** Only "tokens/s and requests/s per organization" are stated. The 6-8 concurrency figure is informal guidance from cookbooks.
6. **Retry status set.** `/api/errors.md` names only 429 and 529. The wider SDK set (408, 5xx) is an SDK default, not stated as API guidance.
7. **Error body schema.** Undefined apart from 422 `detail` and the `max_tokens_exceeded` code. Hints for 403 and 404 come from SDK class names only.
8. **Option order.** Does the server preserve JSON object key order for Choice criteria? The reorder check depends on it.
9. **Duplicate questions in one request.** Are identical questions answered independently or identically? This decides whether `repeat` can ever be done in one request.
10. **Question-id constraints.** Length, character set and reserved ids are not documented.
11. **Token estimation.** No tokenizer is documented, so pre-flight token checks are approximate.
12. **Image token cost.** The formula for tokens per image is not documented.
13. **Box on `jev-1.13.0`.** The JS SDK says `jev-preview` is required; the box page allows `jev-1.14.0` as well.
14. **Box status.** Box and images are "Dreamer-ready" and experimental. Stability and future gating changes are unknown.
15. **`jev-1.12`.** Cookbooks use it. Whether it is still served is unknown.
16. **Price.** $0.042 per Mtok input appears in several pages, but the cookbooks call it historical.
17. **TextWithAssets.** Not documented in the Python docs; in the JS SDK it is an SDK-side type. The wire format uses plain strings containing references, which is all this tool needs.
18. **Official confidence thresholds.** None exist. All defaults here come from cookbook examples.
19. **Prompt-injection hardening.** The docs only warn. No recommended in-question guard wording exists.
20. **Long-context accuracy loss.** Stated as "slower and less accurate" with no numbers.
21. **Compression with gateways.** Whether OpenRouter, Vercel and Pydantic gateways accept compressed bodies is unknown. `TYPESAFE_COMPRESSION=off` is the escape hatch.
22. **Pages not directly read** by the digest authors: `/llms.txt` and `/api.md`. Reading `/llms.txt` before building will list any pages added since.

---

## 8. Build order

1. **P0 (the minimum useful tool).**
   - Read `openapi.json` and keep the fields the contract test needs.
   - Build `KeyProvider`, `ConfigStore`, `SafeLogger`, `JevTransport` on the SDK, and `RequestValidator`.
   - Tools: `jev_ask`, `jev_validate`, `jev_models`, `jev_usage`.
   - Tests 6.1 items 1-6, 12, 14, 15, plus the 6.2 smoke steps 1-3.
2. **P0.5.** `RateGate` and `jev_batch`; cache and the `$file` resolver.
3. **P1 helpers.** `jev_decide`, `jev_classify`, `jev_verify_claim`, `jev_rerank`, `jev_self_consistency`, `jev_find_lines`, then `jev_locate` (without edge refinement).
4. **P2.** Composite score, taxonomy walk, calibrate, box edge refinement and tile search.
5. **Install.** `claude mcp add --scope user jev -- node <path>\dist\server.js`. The key stays in env or in `%USERPROFILE%\.typesafe\api-key.txt`, never in the MCP config.