import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { asJevError } from "../core/JevError.js";
import { Guidance, INSTRUCTIONS_LIMIT } from "../guide/Guidance.js";
import type { JevTool } from "../tools/JevTool.js";
import { SchemaLinter } from "../validation/SchemaLinter.js";
import type { JevApp } from "./JevApp.js";
import { SanitizingTransport } from "./SanitizingTransport.js";
import { ToolResults } from "./ToolResults.js";

export const SERVER_NAME = "jev-mcp";
export const SERVER_VERSION = "0.2.0";
export const GUIDE_URI = "jev://guide";

/**
 * Binds the three tools to an MCP server:
 * - `instructions` = the router text (under 4,096 chars, linted at startup);
 * - every tool declares an `outputSchema`; results go out as `structuredContent` plus the
 *   same JSON as text; failures are `isError: true` with `{error:{kind,message,fix,retryable}}`;
 * - annotations: readOnlyHint (Jev changes no local state; may reduce approval prompts) and
 *   openWorldHint (every call sends data to TypeSafe); `_meta` carries
 *   `anthropic/alwaysLoad` (jev_ask) and, only with JEV_CONFIRM_EGRESS=1,
 *   `anthropic/requiresUserInteraction` (a prompt on every call, impractical in agent loops);
 * - all output and every error passes through the Redactor and the OutboundSanitizer: tool
 *   results in `invoke`, and every outgoing JSON-RPC message in SanitizingTransport.
 */
export class McpAdapter {
  readonly server: McpServer;
  readonly instructions: string;
  private readonly results: ToolResults;

  constructor(private readonly app: JevApp) {
    this.results = new ToolResults(<T>(v: T) => this.clean(v), (line) => app.logger.warn(line));
    this.instructions = Guidance.instructions(app.recipes.all);
    const problems = new SchemaLinter(app.config.serverAlias, app.config.limits.toolNameChars, INSTRUCTIONS_LIMIT).lint(app.tools, this.instructions);
    if (problems.length > 0) throw new Error(`jev-mcp tool surface is invalid: ${problems.join("; ")}`);
    this.server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: this.instructions });
    this.guardTransports();
    this.shapeSdkErrors();
    for (const tool of app.tools) this.registerTool(tool);
    this.server.registerResource(
      "guide",
      GUIDE_URI,
      { title: "Jev guide", description: "Recipes, coding shapes, hooks and limits", mimeType: "text/markdown" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: Guidance.full(app.recipes.all) }] }),
    );
  }

  /** Runs a tool and wraps its result; exposed for tests. */
  async invoke(tool: JevTool, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    try {
      return this.results.ok(await tool.run(args as never, { signal }));
    } catch (err) {
      return this.results.error(tool.name, asJevError(err));
    }
  }

  /**
   * Errors the SDK builds before or after a handler (argument validation against the strict
   * inputSchema, unknown tool, output validation) came back as text only, without kind / fix
   * (break hunt 1). They now get the same `{error}` shape as every jev error. The SDK method is
   * private, so its absence (an SDK change) fails startup instead of silently losing the shape.
   */
  private shapeSdkErrors(): void {
    const server = this.server as unknown as { createToolError?: (message: string) => CallToolResult };
    if (typeof server.createToolError !== "function") throw new Error("jev-mcp: McpServer.createToolError is missing; the MCP SDK changed.");
    server.createToolError = (message: string) => this.results.error("tool call", ToolResults.sdkError(message));
  }

  /** Every MCP response passes the Redactor and the secret guard's sanitizer. */
  private clean<T>(value: T): T {
    return this.app.outbound.scrubResult(this.app.redactor.scrubValue(value));
  }

  /**
   * Bug r6/r7: every transport the server connects to is wrapped by SanitizingTransport, so
   * every handler's result and every error (SDK-built ones included) is sanitized, once, in one
   * place, from the first call on.
   */
  private guardTransports(): void {
    const layer = new SanitizingTransport(<T>(v: T) => this.results.outgoing(v));
    const server = this.server as unknown as { connect: (t: Transport) => Promise<void> };
    const connect = server.connect.bind(server);
    server.connect = (transport: Transport) => connect(layer.wrap(transport));
  }

  /**
   * Strict input schema (round 5): an undeclared argument is refused, never passed on. The
   * error names it, and a credential-named one gets the credential error (ArgumentGuard).
   */
  private strictInput(tool: JevTool): z.ZodObject {
    const declared = Object.keys(tool.schema);
    const guard = this.app.toolset.argGuard;
    return z.strictObject(tool.schema, { error: (iss) => (iss.code === "unrecognized_keys" ? guard.unknownMessage(iss.keys, declared) : undefined) });
  }

  private registerTool(tool: JevTool): void {
    const meta = { ...tool.meta, ...(this.app.config.egress.confirm ? { "anthropic/requiresUserInteraction": true } : {}) };
    this.server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: this.strictInput(tool),
        outputSchema: tool.outputSchema,
        annotations: { readOnlyHint: tool.readOnly, openWorldHint: true },
        ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
      },
      (async (args: unknown, extra: { signal: AbortSignal }) => this.invoke(tool, args, extra.signal)) as never,
    );
  }
}
