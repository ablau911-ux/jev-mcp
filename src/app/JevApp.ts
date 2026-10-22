import { AssetPacker } from "../assets/AssetPacker.js";
import { CacheDirPolicy } from "../cache/CacheDirPolicy.js";
import { NoiseBand } from "../cache/NoiseBand.js";
import { ResponseCache } from "../cache/ResponseCache.js";
import { AutoLabeler } from "../calibration/AutoLabeler.js";
import { DecisionLog } from "../calibration/DecisionLog.js";
import { ConfigStore } from "../config/ConfigStore.js";
import type { JevConfig } from "../config/types.js";
import { InjectionGuard } from "../core/InjectionGuard.js";
import { JevService } from "../core/JevService.js";
import { RequestPreparer } from "../core/RequestPreparer.js";
import { Retrier } from "../core/Retrier.js";
import { SessionLimiter } from "../core/SessionLimiter.js";
import { PathGuard, type RootsProvider } from "../files/PathGuard.js";
import { SafeLogger } from "../logging/SafeLogger.js";
import { ModelRegistry } from "../models/ModelRegistry.js";
import { DiffSource, type GitRunner } from "../refs/DiffSource.js";
import { LogTrimmer } from "../refs/LogTrimmer.js";
import { RefResolver } from "../refs/RefResolver.js";
import { KeyProvider } from "../security/KeyProvider.js";
import { LiveSecrets } from "../security/LiveSecrets.js";
import { OutboundSanitizer } from "../security/OutboundSanitizer.js";
import { Redactor } from "../security/Redactor.js";
import type { FetchFn } from "../transport/CompressingFetch.js";
import { GuardedTransport } from "../transport/GuardedTransport.js";
import type { JevTransport } from "../transport/JevTransport.js";
import { MockTransport } from "../transport/MockTransport.js";
import { SdkTransport } from "../transport/SdkTransport.js";
import { DayUsageStore } from "../usage/DayUsageStore.js";
import { UsageLedger } from "../usage/UsageLedger.js";
import { ContextBudget } from "../validation/ContextBudget.js";
import { RequestValidator } from "../validation/RequestValidator.js";
import { SecretGuard } from "../validation/SecretGuard.js";
import { ProcessGuard } from "./ProcessGuard.js";
import { Toolset } from "./Toolset.js";

export interface AppOptions {
  env?: Record<string, string | undefined>;
  configStore?: ConfigStore;
  keyFilePath?: string;
  fetch?: FetchFn;
  transport?: JevTransport;
  roots?: RootsProvider;
  git?: GitRunner;
  logSink?: (line: string) => void;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Composition root: builds one instance of each service for the server process. */
export class JevApp {
  readonly config: JevConfig;
  readonly redactor = new Redactor();
  readonly logger: SafeLogger;
  readonly keys: KeyProvider;
  readonly processGuard: ProcessGuard;
  readonly guard: PathGuard;
  readonly refs: RefResolver;
  readonly cache: ResponseCache;
  readonly ledger: UsageLedger;
  readonly limiter: SessionLimiter;
  readonly models: ModelRegistry;
  readonly decisions: DecisionLog;
  readonly labeler: AutoLabeler;
  readonly secrets: SecretGuard;
  /** The secret guard's choke point: wire payloads and persisted records pass it. */
  readonly outbound: OutboundSanitizer;
  readonly transport: JevTransport;
  readonly service: JevService;
  readonly toolset: Toolset;

  constructor(readonly options: AppOptions = {}) {
    const env = options.env ?? process.env;
    // Live secrets are registered first: before any config parse, log line or request (round 5, 9).
    this.keys = new KeyProvider(this.redactor, env, undefined, options.keyFilePath);
    this.keys.prime();
    new LiveSecrets(this.redactor, env).load();
    const store = options.configStore ?? new ConfigStore(env);
    this.config = store.get();
    this.secrets = new SecretGuard(this.config.secretGuard, this.redactor);
    this.outbound = new OutboundSanitizer(this.secrets);
    // Bug r10/r19: log lines run the same masking pipeline as the wire and the disk records.
    this.logger = new SafeLogger(this.redactor, this.config.logLevel, options.logSink, (s) => this.outbound.scrubText(s));
    store.warnings.forEach((w) => this.logger.warn(w));
    this.processGuard = new ProcessGuard(this.logger);
    this.guard = new PathGuard(options.roots ?? (async () => [process.cwd(), ...this.config.files.extraRoots]), this.config.files.maxBytes, this.config.files.credentialDenylist);
    const r = this.config.refs;
    this.refs = new RefResolver(this.guard, new DiffSource((p) => this.guard.isCredential(p), r.maxHunks, r.gitTimeoutMs, options.git, r.hunkIdMemory), new LogTrimmer({ tailLines: r.logTailLines, maxFrames: r.logMaxFrames, framePatterns: r.framePatterns, dropPatterns: r.frameDropPatterns }), this.config.limits.maxNesting, this.config.limits.bodyBytes);
    this.cache = this.buildCache();
    this.ledger = new UsageLedger(this.config.pricing.usdPerMTokInput, this.config.pricing.note, this.config.usageLedger.enabled ? this.config.usageLedger.path : null, (v) => this.outbound.scrubValue(v));
    this.limiter = new SessionLimiter({ session: this.config.session, tokensPerSecond: this.config.concurrency.tokensPerSecond, retryCap: this.config.retry.sessionCap, sleep: options.sleep, day: this.config.dailyUsage.path ? new DayUsageStore(this.config.dailyUsage.path) : undefined });
    this.models = new ModelRegistry(this.config.models);
    this.decisions = new DecisionLog(this.config.decisionLog.enabled ? this.config.decisionLog.path : null, (v) => this.outbound.scrubValue(v));
    this.labeler = new AutoLabeler(this.decisions);
    this.refs.onDiff.push((h, scope) => this.labeler.onDiff(h, scope));
    this.refs.onFileRead.push((p) => this.labeler.onFileRead(p));
    this.transport = new GuardedTransport(options.transport ?? this.buildTransport(options.fetch), this.outbound);
    this.service = this.buildService();
    this.toolset = new Toolset(this);
  }

  get tools() {
    return this.toolset.tools;
  }

  get recipes() {
    return this.toolset.recipes;
  }

  private buildCache(): ResponseCache {
    const dir = CacheDirPolicy.check(this.config.cache.dir);
    if (dir.warning) this.logger.warn(dir.warning);
    return new ResponseCache({ maxEntries: this.config.cache.maxEntries, ttlMs: this.config.cache.ttlMs, dir: dir.dir, secretPath: this.config.cache.secretPath, sanitize: (v) => this.outbound.scrubResult(v) });
  }

  private buildTransport(fetchFn?: FetchFn): JevTransport {
    if (this.config.backend === "mock") return new MockTransport(this.config.models.aliases);
    return new SdkTransport(this.keys, { baseUrl: this.config.baseUrl, compression: this.config.compression, compressionMinBytes: this.config.compressionMinBytes, fetch: fetchFn });
  }

  private buildService(): JevService {
    const c = this.config;
    const secrets = this.secrets;
    const preparer = new RequestPreparer({
      config: c, models: this.models, refs: this.refs, secrets, outbound: this.outbound, keys: this.keys, cache: this.cache,
      validator: new RequestValidator(c, secrets), injection: new InjectionGuard(c.injection, c.prompts.injectionProbe),
      packer: new AssetPacker(c.limits, this.guard), budget: new ContextBudget(c),
    });
    const retrier = new Retrier({ statuses: c.retry.statuses, serverErrorRetries: c.retry.serverErrorRetries, maxRetryAfterMs: c.retry.maxRetryAfterMs, retryLimit: { fallback: c.retry.single.maxRetries, cap: c.retry.maxRetriesCap }, takeRetry: () => this.limiter.takeRetry(), refundRetry: () => this.limiter.refundRetry(), random: this.options.random, sleep: this.options.sleep });
    return new JevService({
      config: c, transport: this.transport, preparer, refs: this.refs, cache: this.cache, noise: new NoiseBand(c.cache.noulMarginMin, c.cache.choiceGapMin),
      models: this.models, ledger: this.ledger, limiter: this.limiter, retrier, logger: this.logger,
    });
  }
}
