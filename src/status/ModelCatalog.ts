import { JevError } from "../core/JevError.js";
import type { JevService } from "../core/JevService.js";

interface ModelCard {
  name: string;
  description: string;
  release_date: string;
}

/**
 * Models view for jev_status (absorbs jev_models): GET /v1/models (cached in memory), the
 * per-feature pins and the alias-to-version map refreshed from `response.model`.
 */
export class ModelCatalog {
  private cached: { at: number; models: ModelCard[] } | null = null;

  constructor(
    private readonly service: JevService,
    private readonly now: () => number = Date.now,
  ) {}

  async report(refresh: boolean, signal?: AbortSignal): Promise<object> {
    const ttl = this.service.config.models.listTtlMs;
    let source: "live" | "cache" = "cache";
    if (refresh || !this.cached || this.now() - this.cached.at > ttl) {
      this.cached = { at: this.now(), models: ModelCatalog.parse(await this.service.listModels(signal)) };
      source = "live";
    }
    return {
      features: this.service.models.features,
      aliases: this.service.models.aliasMap(),
      aliases_as_of: this.service.config.models.aliasesAsOf,
      listed: this.cached.models,
      source,
    };
  }

  static parse(data: unknown): ModelCard[] {
    const list = (data as { models?: unknown })?.models;
    if (!Array.isArray(list)) throw new JevError({ kind: "bad_response", message: "GET /v1/models returned no models array.", fix: "Retry later." });
    return list
      .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
      .map((m) => ({ name: String(m.name ?? ""), description: String(m.description ?? ""), release_date: String(m.release_date ?? "") }));
  }
}
