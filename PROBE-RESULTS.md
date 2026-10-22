# Live probe results

Run once on 2026-10-21 13:48 UTC with `JEV_LIVE=1 npm run probe` (script: `src/probe/`).
110 requests, 54,824 input tokens, estimated cost $0.0023. Model `jev-1.13.0` (pinned);
every response reported `jev-1.13.0`. Sequential, uncached.

Samples: synthetic, committed in `src/probe/ProbeSamples.ts`. Nothing was read from local files
or repositories; that file holds exactly what was sent.

The probe was cut to the two measurements that set a default in code. Not probed,
because no default depends on them: the 429 rate-limit probe ("429 not probed: no decision
depends on it"; backoff follows the documented Retry-After rules and mocked tests),
`response.model` resolution (read from normal calls into the alias map), key order (answers
are always mapped by name), and duplicate or permuted questions.

## 1. Choice first-option bias

50 TypeScript snippets (25 pure, 25 with side effects). One Choice with two options
(`side_effects`, `pure`), asked in normal order and in reversed order, as separate requests.

| Metric | Value |
|---|---|
| Samples / calls | 50 / 100 |
| Winner flips when the order is reversed | 0 of 50 (0.0%) |
| Mean probability of the first-listed option (0.5 = no bias) | 0.500 |
| Mean absolute change of P(side_effects) between orders | 0.000 |
| Accuracy, normal order / reversed order | 100% / 100% |

**Default set:** recipes do **not** ask twice in swapped order. The reversed-order check
stays opt-in: `jev_ask` recipe `self_consistency` with `variants: "reorder"`, `classify` with
`order_check`, and the `strict` preset (`selfConsistency.reorderPresets: ["strict"]`).
Limit: the samples were clear-cut two-option cases. Bias on ambiguous or many-option
Choices is still unmeasured, so `strict` keeps the check.

## 2. chars/4 versus real `input_tokens`

Each request held `{doc: <sample>}` plus one short Noul. A request with an empty `doc` cost
278 tokens; that overhead is subtracted to get the state tokens.

| Kind | Chars | State tokens | Chars per token | chars/4 ÷ actual |
|---|---:|---:|---:|---:|
| code | 664 | 200 | 3.32 | 0.83 |
| code | 2,656 | 800 | 3.32 | 0.83 |
| code | 10,624 | 3,200 | 3.32 | 0.83 |
| JSON | 456 | 305 | 1.50 | 0.37 |
| JSON | 1,788 | 1,205 | 1.48 | 0.37 |
| JSON | 7,116 | 4,805 | 1.48 | 0.37 |
| Hebrew | 252 | 201 | 1.25 | 0.31 |
| Hebrew | 1,008 | 801 | 1.26 | 0.31 |
| Hebrew | 4,032 | 3,201 | 1.26 | 0.31 |

chars/4 under-counts every kind: code by 17%, JSON by 63%, Hebrew by 69%. The ratio is flat
across sizes, so a fixed factor per kind is enough.

**Defaults set** (`context.charsPerToken` in `src/config/defaults.ts`, rounded down so the
pre-flight check errs on the safe side):

| Content | Factor (chars per token) |
|---|---:|
| Latin text and code strings | 3.3 |
| JSON structure (keys, punctuation, numbers) | 1.4 |
| Non-Latin text (more than 30% non-ASCII, e.g. Hebrew) | 1.2 |

`TokenEstimator` applies the factor per string leaf and to the JSON structure, and
`jev_status` reports the estimate-to-actual ratio of the session so drift shows.
