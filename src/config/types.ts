import type { TokenFactors } from "../validation/TokenEstimator.js";

/**
 * Shape of the configuration. Every tunable value, threshold, word list and helper prompt
 * lives in config (defaults.ts, prompts.ts), overridable by `%USERPROFILE%\.typesafe\
 * jev-config.json` and environment variables (ConfigStore / EnvOverrides).
 */
export interface RetrySettings {
  maxRetries: number;
  initialMs: number;
  maxMs: number;
  jitter: number;
}

export interface NoulBand {
  no_below: number;
  yes_above: number;
}

/** One named threshold. Every threshold names its metric and says whether it is calibrated. */
export interface Threshold {
  metric: "noul_p" | "choice_confidence" | "choice_top_p" | "choice_margin" | "score_confidence";
  value: number;
  calibrated: boolean;
  tuned_on: string;
}

/**
 * A decision preset. The agent passes only the name. `noul` bands route
 * yes/no; `confidence` routes choice/score; `top_p_floor` and `margin_min` are extra gates
 * for Choice. `margin_min` is scaled by 2/n for n options.
 */
export interface Preset {
  description: string;
  noul_no_below: Threshold;
  noul_yes_above: Threshold;
  review_below: Threshold;
  auto_at: Threshold;
  top_p_floor?: Threshold;
  margin_min?: Threshold;
  /** Recall filters: the decision is `flag` when p >= this (diff review). */
  flag_at?: Threshold;
  /** Gate answers may be cached only this long. */
  cache_ttl_ms?: number;
  reorder_check?: boolean;
}

export type Feature = "text" | "locate";

export interface ModelsConfig {
  /** Pinned model per feature (stress test 2026-10-21): text and locate/box on Jev 1.14. Fixed: config and env cannot change it. */
  features: Record<Feature, string>;
  /** The ONLY way to change a pin (jev-config.json `models.override`); results then say `model_overridden: true`. */
  override: Partial<Record<Feature, string>>;
  aliases: Record<string, string>;
  aliasesAsOf: string;
  boxModels: string[];
  listTtlMs: number;
}

export interface ApiLimits {
  bodyBytes: number;
  maxNesting: number;
  choiceMin: number;
  choiceMax: number;
  scoreMin: number;
  scoreMax: number;
  imageBytes: number;
  imageSideMin: number;
  imageSideMax: number;
  imagePixelsMin: number;
  imagePixelsMax: number;
  imagesTotalBytes: number;
  referenceBytes: number;
  referencesTotalBytes: number;
  /** Full MCP tool name `mcp__<server>__<tool>` limit (Claude API). */
  toolNameChars: number;
  /** Largest declared source size (pixels) the client-side PNG resizer decodes; keeps every buffer under 64 MiB. */
  resizeSourcePixelsMax: number;
  /** Most questions about one state in one jev_ask / jev_batch request (stress area 9 tested 30). */
  questionsPerState: number;
}

export interface SecretPattern {
  name: string;
  pattern: string;
  flags?: string;
  /** A `key = value` pattern: a value that is not a secret under the syntax policy (ValueSyntax) is not a match. */
  keyed?: boolean;
}

export interface JevConfig {
  baseUrl: string;
  /** Hosts accepted for baseUrl (official API only); others are refused. */
  officialHosts: string[];
  backend: "api" | "mock";
  serverAlias: string;
  compression: "auto" | "off" | "gzip" | "zstd";
  compressionMinBytes: number;
  logLevel: "error" | "warn" | "info";
  models: ModelsConfig;
  timeouts: { attemptMs: number; longContextAttemptMs: number; totalMs: number; batchTotalMs: number; mcpMarginMs: number; mcpToolTimeoutMs: number | null };
  /** maxRetriesCap: upper bound of any per-call maxRetries (round 5). */
  retry: { single: RetrySettings; batch: RetrySettings; statuses: number[]; serverErrorRetries: number; maxRetryAfterMs: number; sessionCap: number; maxRetriesCap: number };
  concurrency: { default: number; cap: number; hardCap: number; recoverAfter: number; tokensPerSecond: number };
  session: { maxInputTokens: number; requestsPerMinute: number; dailyInputTokens: number };
  batch: { maxItems: number; hardMaxItems: number; topK: number };
  pricing: { usdPerMTokInput: number; note: string };
  presets: Record<string, Preset>;
  defaultPreset: string;
  noulBands: NoulBand;
  selfConsistency: { stdDevLimit: number; defaultN: number; boxIouMin: number };
  citation: { autoAcceptConfidence: number };
  findLines: { window: number; overlap: number; foundAt: number; absentAt: number; maxWindows: number };
  classify: { chunkSize: number; warnAbove: number; maxOrderChecks: number };
  rerank: { listwiseChunk: number; shortlist: number; maxCandidates: number };
  cache: { enabled: boolean; maxEntries: number; ttlMs: number; noulMarginMin: number; choiceGapMin: number; dir: string | null; secretPath: string | null };
  usageLedger: { enabled: boolean; path: string | null };
  /** The day's input-token total shared by every jev-mcp process of the user (session.dailyInputTokens). */
  dailyUsage: { path: string | null };
  decisionLog: { enabled: boolean; path: string | null };
  calibration: { minRecords: number; holdout: number; targetPrecision: number; z: number; bins: number };
  limits: ApiLimits;
  context: { perQuestionTokens: number; perRequestTokens: number; longContextTokens: number; warnFraction: number; charsPerToken: TokenFactors };
  files: { maxBytes: number; extraRoots: string[]; credentialDenylist: string[] };
  refs: { logTailLines: number; logMaxFrames: number; framePatterns: string[]; frameDropPatterns: string[]; maxHunks: number; hunkIdMemory: number; gitTimeoutMs: number };
  /** No `allow` switch exists on purpose: the guard cannot be turned off (project policy). */
  /**
   * placeholders: the ValueSyntax exemptions (round 7/12), built in; commandWords: `word KEY value` contexts (bug r22), config may add;
   * connectionKeys: the ADO / ODBC connection-string keys that mark a `Key=value;` line (a field value ends at `;`), built in;
   * typeWords: the type-alias keywords (`type Token = {`): the key names a type, its value is never data, built in.
   */
  secretGuard: { patterns: SecretPattern[]; mode: "refuse" | "redact"; placeholders: string[]; commandWords: string[]; connectionKeys: string[]; typeWords: string[] };
  injection: { untrustedPrefix: string; probe: boolean };
  images: { enabled: boolean };
  egress: { confirm: boolean };
  /** failStreak: upstream failures (auth, unavailable) in a row after a passing check that turn health ok:false. */
  health: { onStartup: boolean; timeoutMs: number; failStreak: number };
  linter: { countWords: string[]; dateWords: string[]; negations: string[]; compoundJoiners: string[] };
  hooks: { gatePreset: string; screenPreset: string; maxChars: number };
  prompts: HelperPrompts;
}

export interface HelperPrompts {
  noneLabel: string;
  noneDescription: string;
  anyOptionApplies: string;
  /** Wire name for an integer-like option label in order checks ("{label}" is replaced; must not stay integer-like). */
  indexLabelAlias: string;
  verifySupports: string;
  verifyContradicts: string;
  citationInstructions: string;
  citationCriteria: Record<string, string>;
  rerankPointwise: string;
  rerankListwise: string;
  locatePresence: string;
  locateBox: string;
  findWhere: string;
  findExists: string;
  findExistsTrue: string;
  findExistsFalse: string;
  injectionProbe: string;
  hookGate: string;
  hookScreen: string;
}
