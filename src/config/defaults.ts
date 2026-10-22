import { DEFAULT_CREDENTIAL_DENYLIST, DEFAULT_LINTER, DEFAULT_PROMPTS, DEFAULT_SECRET_PATTERNS } from "./prompts.js";
import type { JevConfig, Preset, Threshold } from "./types.js";

export type { ApiLimits, Feature, HelperPrompts, JevConfig, NoulBand, Preset, RetrySettings, Threshold } from "./types.js";

const MIB = 1024 * 1024;
export const DAY_USAGE_LOCK_WAIT_MS = 5_000;
export const DAY_USAGE_LOCK_POLL_MS = 10;
/** Grace period for locks without a readable owner or from another host; dead local owners recover immediately. */
export const DAY_USAGE_LOCK_STALE_MS = 30_000;
const DOCS = "docs starting value (confidence-routing.md); not tuned on local data";
const STRESS = "jev-mcp-stress 2026-10-21 (11,058 live calls)";

function t(metric: Threshold["metric"], value: number, tunedOn = DOCS): Threshold {
  return { metric, value, calibrated: false, tuned_on: tunedOn };
}

/**
 * Decision presets. Thresholds are the docs' illustrative starting values
 * (noul 0.3/0.7, choice confidence 0.6/0.85, top-p floor 0.60); none is calibrated for code.
 * `jev_status {action:"calibrate"}` fits real ones once 30+ labels exist.
 */
const PRESETS: Record<string, Preset> = {
  gate: {
    description: "Cautious gate before an action; only clear answers pass. Cached at most 5 min.",
    // Stress areas 3/5b: acts only at p <= 0.1 or >= 0.9 (100% accurate at confidence >= 0.9; below 0.70, 45.8% flipped under rewording).
    noul_no_below: t("noul_p", 0.1, `${STRESS}, areas 3/5b`),
    noul_yes_above: t("noul_p", 0.9, `${STRESS}, areas 3/5b`),
    review_below: t("choice_confidence", 0.6),
    // Stress area 3: framed choices flip 20.8% at 0.85-0.95 and 1.7% at >= 0.95.
    auto_at: t("choice_confidence", 0.95, `${STRESS}, area 3`),
    top_p_floor: t("choice_top_p", 0.6, "choice cookbook floor; not tuned on local data"),
    margin_min: t("choice_margin", 0.1, "unsourced starting guess; scaled by 2/n"),
    cache_ttl_ms: 300_000,
  },
  triage: {
    description: "Sort items into buckets (test triage); low confidence goes to review.",
    noul_no_below: t("noul_p", 0.3),
    noul_yes_above: t("noul_p", 0.7),
    review_below: t("choice_confidence", 0.6),
    auto_at: t("choice_confidence", 0.85),
  },
  review_filter: {
    description: "Recall filter for diff review: flag anything at p >= 0.3; a human or Claude reads the flagged hunks.",
    noul_no_below: t("noul_p", 0.3),
    noul_yes_above: t("noul_p", 0.7),
    review_below: t("choice_confidence", 0.5),
    auto_at: t("choice_confidence", 0.7),
    flag_at: t("noul_p", 0.3, "research §3 diff review: low threshold as recall filter; unsourced value"),
  },
  strict: {
    description: "High stakes: tight bands and a reversed-order check on Choice questions (2x cost).",
    noul_no_below: t("noul_p", 0.2, "unsourced starting guess"),
    noul_yes_above: t("noul_p", 0.9, "unsourced starting guess"),
    review_below: t("choice_confidence", 0.7, "unsourced starting guess"),
    auto_at: t("choice_confidence", 0.95, "unsourced starting guess"),
    top_p_floor: t("choice_top_p", 0.8, "unsourced starting guess"),
    margin_min: t("choice_margin", 0.2, "unsourced starting guess; scaled by 2/n"),
    reorder_check: true,
  },
};

export const DEFAULT_CONFIG: JevConfig = {
  baseUrl: "https://api.typesafe.ai",
  officialHosts: ["api.typesafe.ai", "localhost", "127.0.0.1"],
  backend: "api",
  serverAlias: "jev",
  compression: "auto",
  compressionMinBytes: 1024,
  logLevel: "warn",
  models: {
    // Stress areas 5b/7/10/11: 1.14.0 as accurate as 1.13.0, faster, injection 2.1% vs 7.3%.
    features: { text: "jev-1.14.0", locate: "jev-1.14.0" },
    override: {},
    aliases: { "jev-latest": "jev-1.13.0", "jev-preview": "jev-1.14.0" },
    aliasesAsOf: "2026-10-14 (/models.md); refreshed from response.model at runtime",
    boxModels: ["jev-preview", "jev-1.14.0"],
    listTtlMs: 600_000,
  },
  // Starting guesses (unsourced): p95 latency is 290-364 ms.
  timeouts: { attemptMs: 5_000, longContextAttemptMs: 30_000, totalMs: 15_000, batchTotalMs: 60_000, mcpMarginMs: 1_000, mcpToolTimeoutMs: null },
  retry: {
    single: { maxRetries: 2, initialMs: 500, maxMs: 5_000, jitter: 0.25 },
    batch: { maxRetries: 3, initialMs: 1_000, maxMs: 10_000, jitter: 0.25 },
    // errors.md documents only 429 and 529 as retryable.
    statuses: [429, 529],
    serverErrorRetries: 1,
    maxRetryAfterMs: 60_000,
    sessionCap: 30,
    maxRetriesCap: 10,
  },
  concurrency: { default: 6, cap: 8, hardCap: 32, recoverAfter: 20, tokensPerSecond: 200_000 },
  session: { maxInputTokens: 2_000_000, requestsPerMinute: 120, dailyInputTokens: 5_000_000 },
  batch: { maxItems: 500, hardMaxItems: 5000, topK: 10 },
  pricing: {
    usdPerMTokInput: 0.042,
    note: "Estimate from /models.md ($0.042 per Mtok input, output free). Not verified billing.",
  },
  presets: PRESETS,
  defaultPreset: "gate",
  noulBands: { no_below: 0.3, yes_above: 0.7 },
  // boxIouMin: box variants agree only when each overlaps the first by at least this IoU (uncalibrated).
  selfConsistency: { stdDevLimit: 0.05, defaultN: 3, boxIouMin: 0.5 },
  citation: { autoAcceptConfidence: 0.8 },
  // maxWindows: one find_lines call pays one request per window; above it (or above
  // session.requestsPerMinute) the call is refused before anything is sent (~9k lines at window 200).
  findLines: { window: 200, overlap: 20, foundAt: 0.7, absentAt: 0.35, maxWindows: 50 },
  classify: { chunkSize: 200, warnAbove: 240, maxOrderChecks: 4 },
  rerank: { listwiseChunk: 200, shortlist: 16, maxCandidates: 64 },
  cache: { enabled: true, maxEntries: 500, ttlMs: 3_600_000, noulMarginMin: 0.2, choiceGapMin: 0.1, dir: null, secretPath: null },
  usageLedger: { enabled: false, path: null },
  // Always kept (a cap, not a log): every MCP server process adds to the same day total.
  dailyUsage: { path: null },
  decisionLog: { enabled: true, path: null },
  calibration: { minRecords: 30, holdout: 0.3, targetPrecision: 0.9, z: 1.96, bins: 10 },
  limits: {
    bodyBytes: 32 * MIB,
    maxNesting: 64,
    choiceMin: 1,
    choiceMax: 255,
    scoreMin: 2,
    scoreMax: 10,
    imageBytes: 16 * MIB,
    imageSideMin: 280,
    imageSideMax: 1568,
    imagePixelsMin: 78_400,
    imagePixelsMax: 2_458_624,
    imagesTotalBytes: 32 * MIB,
    referenceBytes: 1024,
    referencesTotalBytes: 65_536,
    toolNameChars: 128,
    resizeSourcePixelsMax: 15_000_000,
    // Stress area 9: 30 questions in one request matched 30 separate calls (99.2%); more is untested.
    questionsPerState: 30,
  },
  context: {
    perQuestionTokens: 32_000,
    perRequestTokens: 64_000,
    longContextTokens: 262_000,
    warnFraction: 0.8,
    // Measured by the live probe (PROBE-RESULTS.md): chars/4 under-counted every kind.
    // Stress area 8: log-like text measured 1.66 chars/token (a string whose digit share reaches denseShare).
    charsPerToken: { text: 3.3, json: 1.4, nonLatin: 1.2, nonLatinShare: 0.3, dense: 1.6, denseShare: 0.08 },
  },
  files: { maxBytes: 1 * MIB, extraRoots: [], credentialDenylist: DEFAULT_CREDENTIAL_DENYLIST },
  refs: {
    logTailLines: 200,
    logMaxFrames: 5,
    // Stack-frame lines: JS/Java/C# "at ...", Python "File \"...\", line", Go "file.go:12".
    framePatterns: ["^\\s+at\\s", "^\\s+File \"[^\"]+\", line \\d+", "^\\s+\\S+\\.go:\\d+"],
    frameDropPatterns: ["node_modules", "node:internal", "<anonymous>", "site-packages", "runtime/"],
    maxHunks: 200,
    // Hunk contents remembered for session-stable hunk ids (only_ids reruns after the diff changed).
    hunkIdMemory: 10_000,
    gitTimeoutMs: 5_000,
  },
  secretGuard: {
    patterns: DEFAULT_SECRET_PATTERNS,
    mode: "redact",
    // Command words of a space-separated `word KEY value` pair (bug r22); config may add words.
    commandWords: ["ENV", "setx", "Set-Item", "Set-Variable", "set -x", "set -gx", "set -Ux"],
    // ADO / ODBC connection-string keys (break hunt): a line of 2+ `Key=value;` fields with one of these is a
    // connection string, where an unquoted value cannot hold `;`, so a field value ends there. Secret keys
    // (Password, Pwd) are left out on purpose: they alone never make a line a connection string.
    connectionKeys: ["Server", "Data Source", "Database", "Initial Catalog", "User ID", "UID", "Driver", "Provider", "Host", "Integrated Security", "Trusted_Connection"],
    // Type-alias keywords (break hunt): in `type Token = { ... }` the key names a type (TS, Rust, Python 3.12, Kotlin), not data.
    typeWords: ["type", "typealias"],
    // Placeholder values (round 7): regex sources, whole value, case-insensitive.
    placeholders: [
      "your[_-][\\w-]*",
      "[\\w-]*[_-]here",
      "change[_-]?(?:me|it)",
      "replace[_-]?me",
      "fill[_-]?me[_-]?in",
      "(?:todo|tbd|fixme|placeholder|example|sample|dummy|none|null|nil|undefined|empty|redacted|hidden)",
      "(?:secret|password|passwd|token|api[_-]?key)",
      "x{3,}|\\*{3,}|\\.{3,}|#{3,}|-{3,}|_{3,}|•{3,}",
      "<[^<>]*>",
      "\\$\\{[^}]*\\}",
      "\\{\\{[^}]*\\}\\}",
      "\\{[\\w.-]*\\}",
      "%[A-Za-z_]\\w*%",
      "\\$[A-Za-z_]\\w*",
    ],
  },
  injection: { untrustedPrefix: "untrusted_", probe: true },
  images: { enabled: false },
  egress: { confirm: false },
  health: { onStartup: true, timeoutMs: 3_000, failStreak: 3 },
  linter: DEFAULT_LINTER,
  hooks: { gatePreset: "gate", screenPreset: "review_filter", maxChars: 20_000 },
  prompts: DEFAULT_PROMPTS,
};
