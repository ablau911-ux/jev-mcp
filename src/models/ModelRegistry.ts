import type { Feature, ModelsConfig } from "../config/types.js";
import { JevError } from "../core/JevError.js";

export interface Observation {
  /** True when an alias resolved to a different version than last seen (drift). */
  drifted: boolean;
  previous: string | null;
}

const VERSION_RE = /^jev-\d+\.\d+\.\d+$/;

/**
 * Model choice per feature and alias tracking. Text and locate/box use the
 * pinned `jev-1.14.0` (stress test 2026-10-21). An alias is never sent: an alias in
 * `models.override` is resolved to its version. When a caller passes an alias, the cache namespace
 * is the last-observed version for it; `observe()` refreshes the map from `response.model`
 * and reports drift so the cache can purge the old namespace.
 */
export class ModelRegistry {
  private readonly observed = new Map<string, string>();
  private readonly listeners: Array<(alias: string, previous: string, next: string) => void> = [];

  constructor(private readonly config: ModelsConfig) {}

  /**
   * The model to send: the feature pin (`models.override` first). An internal `requested`
   * model (jev_batch keeps one version per run) is accepted only when it is the same version
   * as the pin; anything else is refused, so no call can change the pinned model.
   */
  forFeature(feature: Feature, requested?: string): string {
    const pin = this.pin(feature);
    if (requested === undefined || requested === pin) return pin;
    if (this.namespace(requested) === this.namespace(pin)) return requested;
    throw ModelRegistry.pinned();
  }

  /** The pin of a feature: `models.override` when set, else `models.features`; an alias resolves to its version. */
  pin(feature: Feature): string {
    const model = this.config.override?.[feature] ?? this.config.features[feature];
    return ModelRegistry.isVersion(model) ? model : (this.config.aliases[model] ?? model);
  }

  /** True when the user set `models.override` for this feature. */
  overridden(feature: Feature): boolean {
    return this.config.override?.[feature] !== undefined;
  }

  /** The refusal for a per-call model choice. Never quotes the value (it may be a secret). */
  static pinned(): JevError {
    return JevError.invalid(
      "The model is pinned per feature; a call cannot change it.",
      undefined,
      "Drop the model argument. The user changes a pin only with models.override in jev-config.json.",
      "$.model",
    );
  }

  static isVersion(model: string): boolean {
    return VERSION_RE.test(model);
  }

  /** Version id used as the cache namespace (pinned id, or the alias's last known target). */
  namespace(model: string): string {
    if (ModelRegistry.isVersion(model)) return model;
    return this.observed.get(model) ?? this.config.aliases[model] ?? model;
  }

  onDrift(fn: (alias: string, previous: string, next: string) => void): void {
    this.listeners.push(fn);
  }

  /** Records what answered. A pinned model that answers with another id also counts as drift. */
  observe(requested: string, answered: string): Observation {
    const previous = this.namespace(requested);
    if (!ModelRegistry.isVersion(requested)) this.observed.set(requested, answered);
    const drifted = previous !== answered;
    if (drifted) for (const fn of this.listeners) fn(requested, previous, answered);
    return { drifted, previous: drifted ? previous : null };
  }

  /** Alias map: static table overlaid with what responses reported this session. */
  aliasMap(): Record<string, string> {
    return { ...this.config.aliases, ...Object.fromEntries(this.observed) };
  }

  /** Effective pins (override applied). */
  get features(): Record<Feature, string> {
    return { text: this.pin("text"), locate: this.pin("locate") };
  }
}
