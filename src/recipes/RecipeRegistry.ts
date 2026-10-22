import { JevError } from "../core/JevError.js";
import type { Recipe } from "./Recipe.js";

/** The recipes reachable through `jev_ask {recipe, args}`, by name. */
export class RecipeRegistry {
  private readonly byName = new Map<string, Recipe>();

  constructor(recipes: Recipe[]) {
    for (const r of recipes) this.byName.set(r.name, r);
  }

  get names(): string[] {
    return [...this.byName.keys()];
  }

  get all(): Recipe[] {
    return [...this.byName.values()];
  }

  get(name: string): Recipe {
    const r = this.byName.get(name);
    if (!r) throw JevError.invalid(`Unknown recipe "${name}".`, undefined, `Use one of: ${this.names.join(", ")}.`, "$.recipe");
    return r;
  }
}
