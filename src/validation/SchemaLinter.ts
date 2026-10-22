import { z } from "zod";

export interface LintTarget {
  name: string;
  description: string;
  schema: z.ZodRawShape;
}

const FORBIDDEN = /reasoning|(^|_)why($|_)/i;
const TOP_LEVEL = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Static checks on our own tool surface: a parameter named
 * "reasoning" or "why" can trigger a `reasoning_extraction` refusal; the full name
 * `mcp__<server>__<tool>` must stay within 128 characters; top-level property names must be
 * 1-64 chars of [A-Za-z0-9_.-] (Claude Code drops tools that break it); upfront descriptions
 * and server instructions are cut after 4,096 characters. Returns problems; empty = clean.
 */
export class SchemaLinter {
  constructor(
    private readonly serverAlias: string,
    private readonly nameLimit: number,
    private readonly textLimit: number,
  ) {}

  lint(tools: LintTarget[], instructions: string): string[] {
    const problems: string[] = [];
    if (instructions.length > this.textLimit) problems.push(`instructions are ${instructions.length} chars; limit ${this.textLimit}.`);
    for (const t of tools) problems.push(...this.tool(t));
    return problems;
  }

  private tool(t: LintTarget): string[] {
    const out: string[] = [];
    const full = `mcp__${this.serverAlias}__${t.name}`;
    if (full.length > this.nameLimit) out.push(`${full} is ${full.length} chars; limit ${this.nameLimit}.`);
    if (t.description.length > this.textLimit) out.push(`${t.name} description is ${t.description.length} chars; limit ${this.textLimit}.`);
    for (const key of Object.keys(t.schema)) if (!TOP_LEVEL.test(key)) out.push(`${t.name}.${key}: top-level names must be 1-64 chars of [A-Za-z0-9_.-].`);
    for (const path of SchemaLinter.propertyNames(z.toJSONSchema(z.object(t.schema), { unrepresentable: "any" }))) {
      if (FORBIDDEN.test(path.split(".").pop() ?? "")) out.push(`${t.name}.${path}: parameter names must not ask for reasoning ("reasoning"/"why").`);
    }
    return out;
  }

  /** Every property path in a JSON schema. */
  static propertyNames(schema: unknown, prefix = ""): string[] {
    if (typeof schema !== "object" || schema === null) return [];
    const s = schema as Record<string, unknown>;
    const out: string[] = [];
    const props = s.properties as Record<string, unknown> | undefined;
    for (const [k, v] of Object.entries(props ?? {})) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.push(path, ...SchemaLinter.propertyNames(v, path));
    }
    for (const key of ["items", "additionalProperties", "anyOf", "oneOf", "allOf"]) {
      const child = s[key];
      const list = Array.isArray(child) ? child : [child];
      for (const c of list) out.push(...SchemaLinter.propertyNames(c, prefix));
    }
    return out;
  }
}
