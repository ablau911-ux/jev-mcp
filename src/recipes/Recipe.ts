import { z } from "zod";
import { JevError } from "../core/JevError.js";

export interface RecipeContext {
  signal?: AbortSignal;
}

/**
 * A named multi-step helper reached through `jev_ask {recipe, args}`: the
 * former helper tools (classify, decide, verify_claim, rerank, self_consistency, locate,
 * find_lines) are recipes, so the agent sees three tools, not twelve. Each recipe validates
 * its own `args` on the server and returns a concise object that includes `model`.
 */
export abstract class Recipe<S extends z.ZodRawShape = z.ZodRawShape> {
  abstract readonly name: string;
  /** One line for the router instructions and the guide. */
  abstract readonly summary: string;
  /** One example `args` object (shown in the guide and in the instructions). */
  abstract readonly example: Record<string, unknown>;
  abstract readonly schema: S;

  abstract run(args: z.infer<z.ZodObject<S>>, ctx: RecipeContext): Promise<object>;

  /** Server-side validation of `args`; errors carry a JSON path and a fix. */
  parse(args: unknown): z.infer<z.ZodObject<S>> {
    const result = z.object(this.schema).strict().safeParse(args ?? {});
    if (result.success) return result.data;
    const issue = result.error.issues[0];
    const loc = `$.args${(issue?.path ?? []).map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("")}`;
    const lines = result.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`);
    throw JevError.invalid(`recipe ${this.name}: invalid args: ${lines.join("; ")}`, lines, `See jev://guide#${this.name} for the args; example: ${JSON.stringify(this.example)}`, loc);
  }

  /** Ledger/log label. */
  get tool(): string {
    return `recipe:${this.name}`;
  }
}
