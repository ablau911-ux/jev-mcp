import { join } from "node:path";
import { DEFAULT_CONFIG } from "./defaults.js";
import type { JevConfig } from "./types.js";

export type Env = Record<string, string | undefined>;

export function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

const TRUE_WORDS = ["1", "true", "yes", "on"];
const FALSE_WORDS = ["0", "false", "no", "off"];

/** On/off env switch; undefined when unset or not a recognised word (the config value stays). */
function flag(value: string | undefined): boolean | undefined {
  const v = nonEmpty(value)?.toLowerCase();
  if (v === undefined) return undefined;
  if (TRUE_WORDS.includes(v)) return true;
  return FALSE_WORDS.includes(v) ? false : undefined;
}

/**
 * Applies environment variables on top of file + defaults. Switches an agent must not flip
 * (egress confirmation, secret mode) come ONLY from here, never from tool arguments. Nothing
 * can disable the secret guard: JEV_SECRET_MODE only picks redact (default) or refuse. Empty values are ignored. Problems become warnings, never crashes.
 */
export class EnvOverrides {
  readonly warnings: string[] = [];

  constructor(
    private readonly env: Env,
    private readonly home: string,
  ) {}

  apply(config: JevConfig): JevConfig {
    this.endpoint(config);
    this.models();
    this.switches(config);
    this.paths(config);
    return config;
  }

  private endpoint(config: JevConfig): void {
    const fromFile = config.baseUrl.replace(/\/+$/, "");
    if (EnvOverrides.isOfficial(fromFile, config.officialHosts)) config.baseUrl = fromFile;
    else {
      this.warnings.push("baseUrl in jev-config.json ignored: only the official TypeSafe API is supported, over https.");
      config.baseUrl = DEFAULT_CONFIG.baseUrl;
    }
    const baseUrl = nonEmpty(this.env.TYPESAFE_BASE_URL)?.replace(/\/+$/, "");
    if (baseUrl) {
      if (EnvOverrides.isOfficial(baseUrl, config.officialHosts)) config.baseUrl = baseUrl;
      else this.warnings.push("TYPESAFE_BASE_URL ignored: only the official TypeSafe API is supported (gateways use other model ids).");
    }
    const compression = (nonEmpty(this.env.JEV_COMPRESSION) ?? nonEmpty(this.env.TYPESAFE_COMPRESSION))?.toLowerCase();
    if (compression) {
      const match = (["auto", "off", "gzip", "zstd"] as const).find((a) => a === compression);
      if (match) config.compression = match;
      else this.warnings.push(`JEV_COMPRESSION=${compression} not recognised; using ${config.compression}.`);
    }
    const timeout = Number(nonEmpty(this.env.MCP_TOOL_TIMEOUT));
    if (Number.isFinite(timeout) && timeout >= 1000) config.timeouts.mcpToolTimeoutMs = timeout;
  }

  /**
   * The bearer key goes to this URL, so https is required. Only loopback (local mocks and
   * tests) may use plain http; other configured hosts and *.typesafe.ai need https.
   */
  static isOfficial(url: string, hosts: string[]): boolean {
    try {
      const u = new URL(url);
      const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
      if (loopback && u.protocol !== "http:" && u.protocol !== "https:") return false;
      if (loopback) return hosts.includes(u.hostname) || hosts.includes(u.hostname.replace(/^\[|\]$/g, ""));
      if (u.protocol !== "https:") return false;
      return hosts.includes(u.hostname) || u.hostname === "typesafe.ai" || u.hostname.endsWith(".typesafe.ai");
    } catch {
      return false;
    }
  }

  /** Model pins never come from env: only jev-config.json `models.override` changes them. */
  private models(): void {
    const set = ["TYPESAFE_DEFAULT_MODEL", "JEV_TEXT_MODEL", "JEV_LOCATE_MODEL"].filter((k) => nonEmpty(this.env[k]) !== undefined);
    if (set.length > 0) this.warnings.push(`${set.join(", ")} ignored: model pins change only through models.override in jev-config.json.`);
  }

  private switches(config: JevConfig): void {
    const backend = nonEmpty(this.env.JEV_BACKEND)?.toLowerCase();
    if (backend === "mock" || backend === "api") config.backend = backend;
    const mode = nonEmpty(this.env.JEV_SECRET_MODE)?.toLowerCase();
    if (mode === "refuse" || mode === "redact") config.secretGuard.mode = mode;
    const images = this.flag("JEV_IMAGES");
    if (images !== undefined) config.images.enabled = images;
    const confirm = this.flag("JEV_CONFIRM_EGRESS");
    if (confirm !== undefined) config.egress.confirm = confirm;
    const level = nonEmpty(this.env.JEV_LOG_LEVEL)?.toLowerCase();
    if (level === "error" || level === "warn" || level === "info") config.logLevel = level;
    if (nonEmpty(this.env.TYPESAFE_LOG_LEVEL)?.toLowerCase() === "debug") {
      this.warnings.push("TYPESAFE_LOG_LEVEL=debug ignored: SDK debug logs do not redact bodies.");
    }
  }

  /** An on/off switch; an unrecognised value is ignored with a warning, never read as off. */
  private flag(name: string): boolean | undefined {
    const value = flag(this.env[name]);
    if (value === undefined && nonEmpty(this.env[name]) !== undefined) this.warnings.push(`${name} not recognised (use ${TRUE_WORDS.join("/")} or ${FALSE_WORDS.join("/")}); ignored.`);
    return value;
  }

  private paths(config: JevConfig): void {
    const cacheDir = nonEmpty(this.env.JEV_CACHE_DIR);
    if (cacheDir) config.cache.dir = cacheDir;
    config.cache.secretPath ??= join(this.home, "jev-cache-secret");
    if (config.usageLedger.enabled) config.usageLedger.path ??= join(this.home, "jev-usage.jsonl");
    config.dailyUsage.path ??= join(this.home, "jev-daily-usage.json");
    if (config.decisionLog.enabled) config.decisionLog.path ??= join(this.home, "jev-decisions.jsonl");
  }
}
