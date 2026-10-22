import { ModelRegistry } from "../models/ModelRegistry.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { PresetFloors } from "./PresetFloors.js";
import type { Feature, JevConfig, SecretPattern } from "./types.js";

const FEATURES: Feature[] = ["text", "locate"];

/**
 * Safety floors applied after the config file and env are merged (project policy):
 * - the secret guard: config may only ADD patterns and credential-denylist entries; the
 *   built-in sets always stay, a same-name pattern cannot replace a built-in one, and the
 *   mode is `redact` unless explicitly `refuse`;
 * - the model pins: `models.features` is fixed; only `models.override` changes a pin.
 * - the presets: usable thresholds and existing preset names (PresetFloors).
 */
export class ConfigFloors {
  readonly warnings: string[] = [];

  apply(config: JevConfig): JevConfig {
    this.secretGuard(config);
    this.denylist(config);
    this.models(config);
    const presets = new PresetFloors();
    presets.apply(config);
    this.warnings.push(...presets.warnings);
    return config;
  }

  private secretGuard(config: JevConfig): void {
    const builtIn = DEFAULT_CONFIG.secretGuard.patterns;
    const names = new Set(builtIn.map((p) => p.name));
    const extra: SecretPattern[] = [];
    for (const p of Array.isArray(config.secretGuard.patterns) ? config.secretGuard.patterns : []) {
      if (!ConfigFloors.validPattern(p)) {
        this.warnings.push("A secretGuard pattern in config is not a valid {name, pattern} regex; ignored.");
      } else if (names.has(p.name)) {
        if (!builtIn.some((b) => b.name === p.name && b.pattern === p.pattern && b.flags === p.flags)) {
          this.warnings.push(`secretGuard pattern "${p.name}" is built in and cannot be replaced; config may only add patterns.`);
        }
      } else {
        names.add(p.name);
        extra.push({ name: p.name, pattern: p.pattern, ...(p.flags !== undefined ? { flags: p.flags } : {}) });
      }
    }
    config.secretGuard.patterns = [...builtIn.map((p) => ({ ...p })), ...extra];
    if (config.secretGuard.mode !== "refuse") config.secretGuard.mode = "redact";
    // Placeholder and namespace exemptions only narrow the guard, so config cannot change them (round 7).
    config.secretGuard.placeholders = [...DEFAULT_CONFIG.secretGuard.placeholders];
    // Connection-string keys shorten masks (a field ends at `;`), so config cannot change them either.
    config.secretGuard.connectionKeys = [...DEFAULT_CONFIG.secretGuard.connectionKeys];
    config.secretGuard.typeWords = [...DEFAULT_CONFIG.secretGuard.typeWords];
    // Command words only widen the guard: config may add words, never remove the built-in ones (bug r22).
    const words = Array.isArray(config.secretGuard.commandWords) ? config.secretGuard.commandWords.filter((w): w is string => typeof w === "string" && w.trim().length > 0) : [];
    config.secretGuard.commandWords = [...new Set([...DEFAULT_CONFIG.secretGuard.commandWords, ...words])];
  }

  private denylist(config: JevConfig): void {
    const fromConfig = Array.isArray(config.files.credentialDenylist) ? config.files.credentialDenylist.filter((d) => ConfigFloors.validRegex(d)) : [];
    config.files.credentialDenylist = [...new Set([...DEFAULT_CONFIG.files.credentialDenylist, ...fromConfig])];
  }

  private models(config: JevConfig): void {
    const pins = DEFAULT_CONFIG.models.features;
    if (FEATURES.some((f) => config.models.features?.[f] !== pins[f])) {
      this.warnings.push("models.features is fixed; use models.override to change a pinned model.");
    }
    config.models.features = { ...pins };
    const raw: Partial<Record<Feature, unknown>> = typeof config.models.override === "object" && config.models.override !== null ? config.models.override : {};
    const override: Partial<Record<Feature, string>> = {};
    for (const f of FEATURES) {
      const v = raw[f];
      if (typeof v !== "string" || v.trim().length === 0) continue;
      const model = v.trim();
      // An alias is never sent: a known alias resolves to its version; an unknown one is dropped.
      const target = Object.hasOwn(config.models.aliases ?? {}, model) ? config.models.aliases[model] : undefined;
      if (ModelRegistry.isVersion(model) || (typeof target === "string" && ModelRegistry.isVersion(target))) override[f] = model;
      else this.warnings.push(`models.override.${f} is neither a version (jev-x.y.z) nor an alias of one; ignored.`);
    }
    config.models.override = override;
  }

  private static validPattern(p: unknown): p is SecretPattern {
    if (typeof p !== "object" || p === null) return false;
    const { name, pattern, flags } = p as Record<string, unknown>;
    if (typeof name !== "string" || !/^[a-z_]+$/.test(name) || typeof pattern !== "string") return false;
    if (flags !== undefined && typeof flags !== "string") return false;
    return ConfigFloors.validRegex(pattern, flags as string | undefined);
  }

  private static validRegex(pattern: unknown, flags?: string): pattern is string {
    if (typeof pattern !== "string") return false;
    try {
      new RegExp(pattern, flags);
      return true;
    } catch {
      return false;
    }
  }
}
