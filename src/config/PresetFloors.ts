import { DEFAULT_CONFIG } from "./defaults.js";
import type { JevConfig, Preset } from "./types.js";

const REQUIRED = ["noul_no_below", "noul_yes_above", "review_below", "auto_at"] as const;
const OPTIONAL = ["top_p_floor", "margin_min", "flag_at"] as const;

/**
 * Preset floors, applied at load so a bad preset never reaches DecisionPolicy (where a null
 * threshold turns `p >= null` into "always auto"). Every threshold value is a number in [0, 1]
 * and the bands are ordered (no_below <= yes_above, review_below <= auto_at). A broken
 * built-in preset is restored to its shipped values; a broken custom preset is dropped. The
 * preset names config refers to (defaultPreset, hooks.gatePreset, hooks.screenPreset) must exist.
 */
export class PresetFloors {
  readonly warnings: string[] = [];

  apply(config: JevConfig): void {
    const presets: Record<string, Preset> = {};
    for (const [name, preset] of Object.entries(config.presets)) {
      const problem = PresetFloors.problem(preset);
      if (problem === null) {
        presets[name] = preset;
        continue;
      }
      const shipped = Object.hasOwn(DEFAULT_CONFIG.presets, name) ? DEFAULT_CONFIG.presets[name] : undefined;
      if (shipped) presets[name] = structuredClone(shipped);
      this.warnings.push(`Preset "${name}" in config ${problem}; ${shipped ? "the shipped preset is used" : "the preset is ignored"}.`);
    }
    config.presets = presets;
    config.defaultPreset = this.reference("defaultPreset", config.defaultPreset, DEFAULT_CONFIG.defaultPreset, presets);
    config.hooks.gatePreset = this.reference("hooks.gatePreset", config.hooks.gatePreset, DEFAULT_CONFIG.hooks.gatePreset, presets);
    config.hooks.screenPreset = this.reference("hooks.screenPreset", config.hooks.screenPreset, DEFAULT_CONFIG.hooks.screenPreset, presets);
  }

  private reference(key: string, name: string, fallback: string, presets: Record<string, Preset>): string {
    if (Object.hasOwn(presets, name)) return name;
    this.warnings.push(`Config ${key} names an unknown preset "${name}"; "${fallback}" is used.`);
    return fallback;
  }

  /** Why a preset is unusable, or null when it is fine. */
  private static problem(preset: unknown): string | null {
    if (typeof preset !== "object" || preset === null || Array.isArray(preset)) return "is not an object";
    const p = preset as Record<string, unknown>;
    const bad = [...REQUIRED.filter((k) => PresetFloors.value(p[k]) === null), ...OPTIONAL.filter((k) => p[k] !== undefined && PresetFloors.value(p[k]) === null)];
    if (bad.length > 0) return `has no valid ${bad.join(", ")} value (a number from 0 to 1)`;
    const v = (key: (typeof REQUIRED)[number]) => PresetFloors.value(p[key]) as number;
    if (v("noul_no_below") > v("noul_yes_above")) return "has noul_no_below above noul_yes_above";
    if (v("review_below") > v("auto_at")) return "has review_below above auto_at";
    if (p.cache_ttl_ms !== undefined && !(typeof p.cache_ttl_ms === "number" && p.cache_ttl_ms >= 0)) return "has an invalid cache_ttl_ms";
    if (p.reorder_check !== undefined && typeof p.reorder_check !== "boolean") return "has an invalid reorder_check";
    return null;
  }

  private static value(threshold: unknown): number | null {
    if (typeof threshold !== "object" || threshold === null) return null;
    const value = (threshold as { value?: unknown }).value;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
  }
}
