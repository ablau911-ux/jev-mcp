import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigFloors } from "./ConfigFloors.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { EnvOverrides, nonEmpty, type Env } from "./EnvOverrides.js";
import type { JevConfig } from "./types.js";

/** Leading byte order mark (U+FEFF). */
const BOM_RE = new RegExp(`^${String.fromCharCode(0xfeff)}`);

type ReadText = (path: string) => string;

/** Keys the config file may never set: safety switches come from the environment only. */
const ENV_ONLY = ["apiKey", "api_key"];

/** Directory that holds the key file, config file, ledgers and the cache secret. */
export function typesafeHome(env: Env = process.env): string {
  const base = nonEmpty(env.USERPROFILE) ?? homedir();
  return join(base, ".typesafe");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON kind of a value: null and arrays are kinds of their own. */
function kind(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

/**
 * Deep merge typed by the base: objects merge key by key, everything else (arrays included)
 * replaces. An override whose JSON kind differs from a non-null base value (a section set to
 * null, a number written as a string) is dropped and reported to `onMismatch`; the base stays.
 * Keys the base lacks are copied as they are (custom presets, aliases).
 */
export function deepMerge<T>(base: T, override: unknown, onMismatch?: (path: string, expected: string) => void, path = ""): T {
  if (override === undefined) return base;
  if (base !== null && base !== undefined && kind(base) !== kind(override)) {
    onMismatch?.(path, kind(base));
    return base;
  }
  if (!isPlainObject(base) || !isPlainObject(override)) return override as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key === "__proto__") continue;
    out[key] = Object.hasOwn(out, key) ? deepMerge(out[key], value, onMismatch, path ? `${path}.${key}` : key) : value;
  }
  return out as T;
}

/**
 * Loads configuration: environment, then the config file, then defaults. Empty or
 * whitespace env values are ignored. The config file never holds the API key. Nothing can
 * switch off or shrink the secret guard, and only `models.override` changes a model pin
 * (project policy; ConfigFloors).
 */
export class ConfigStore {
  readonly path: string;
  readonly warnings: string[] = [];
  private readonly config: JevConfig;

  constructor(env: Env = process.env, readText: ReadText = (p) => readFileSync(p, "utf8"), path?: string) {
    const home = typesafeHome(env);
    this.path = path ?? join(home, "jev-config.json");
    const merged = deepMerge(structuredClone(DEFAULT_CONFIG), this.loadFile(readText), (at, expected) => this.warnings.push(`Config ${at} must be of type ${expected}; ignored, the default is kept.`));
    const overrides = new EnvOverrides(env, home);
    const floors = new ConfigFloors();
    this.config = floors.apply(overrides.apply(merged));
    this.warnings.push(...overrides.warnings, ...floors.warnings);
  }

  get(): JevConfig {
    return this.config;
  }

  private loadFile(readText: ReadText): unknown {
    let text: string;
    try {
      text = readText(this.path);
    } catch {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(text.replace(BOM_RE, ""));
      if (!isPlainObject(parsed)) throw new Error("top level is not an object");
      for (const key of ENV_ONLY) {
        if (key in parsed) {
          this.warnings.push("Config file contains an API key field; it is ignored. Use the key file or env.");
          delete parsed[key];
        }
      }
      return parsed;
    } catch (err) {
      this.warnings.push(`Config file ${this.path} ignored: ${(err as Error).message}`);
      return undefined;
    }
  }
}
