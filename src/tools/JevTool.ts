import type { z } from "zod";

export interface ToolContext {
  signal?: AbortSignal;
}

/**
 * Base class for the three MCP tools: name, description (routing words first), input and
 * output schemas, optional `_meta` (Claude Code `anthropic/alwaysLoad`,
 * `anthropic/requiresUserInteraction`) and `run()`.
 */
export abstract class JevTool<S extends z.ZodRawShape = z.ZodRawShape> {
  abstract readonly name: string;
  abstract readonly title: string;
  abstract readonly description: string;
  abstract readonly schema: S;
  /** A raw shape (strict object) or a full schema, e.g. a loose object for multi-shape output. */
  abstract readonly outputSchema: z.ZodRawShape | z.ZodType;
  readonly readOnly: boolean = true;
  meta: Record<string, unknown> = {};

  abstract run(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<object>;
}
