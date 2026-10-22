import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { JevError, type JevErrorJson } from "../core/JevError.js";
import { SecretGuard } from "../validation/SecretGuard.js";

/**
 * Every tool result the MCP server sends, in one place: a success is `structuredContent` plus
 * the same JSON as text; a failure (a jev error or one the SDK builds) is `isError` with
 * `{error:{kind,message,fix,retryable}}`. Everything passes `clean` (Redactor + secret guard).
 */
export class ToolResults {
  constructor(
    private readonly clean: <T>(value: T) => T,
    private readonly warn: (line: string) => void,
  ) {}

  ok(result: object): CallToolResult {
    const clean = this.clean(result) as Record<string, unknown>;
    return { content: [{ type: "text", text: JSON.stringify(clean) }], structuredContent: clean };
  }

  error(name: string, err: JevError): CallToolResult {
    const error = this.cleanError(err.toJSON());
    this.warn(`${name} failed: ${error.kind}/${error.cause}${error.request_id ? ` (request ${error.request_id})` : ""}`);
    const payload = { error };
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
  }

  /**
   * An error the SDK built as text only (argument validation against the strict inputSchema,
   * unknown tool, output validation), as a JevError with kind and fix (break hunt 1).
   */
  static sdkError(message: string): JevError {
    if (message.includes("Output validation error")) {
      return new JevError({ kind: "internal", message, fix: "jev-mcp built a result that breaks its own outputSchema; judge inline and report it." });
    }
    return JevError.invalid(message, undefined, "Correct the argument the message names (see the tool's inputSchema) and call again; nothing was sent.");
  }

  /**
   * One outgoing JSON-RPC message. A tool result's text is JSON.stringify(structuredContent);
   * cleaning that JSON again as a string read object keys as `key: value` pairs (a question
   * named `token` lost its verdicts and the text was no longer JSON, break hunt 1). The
   * structure is cleaned (every string, key and split secret) and the text rebuilt from it, so
   * both stay the same JSON. Any other text is cleaned as text.
   */
  outgoing<T>(message: T): T {
    const result = (message as { result?: { content?: unknown; structuredContent?: unknown } }).result;
    const content: Array<{ type?: unknown; text?: unknown }> = Array.isArray(result?.content) ? result.content : [];
    const json = result?.structuredContent === undefined ? undefined : JSON.stringify(result.structuredContent);
    const derived = json !== undefined && content.length > 0 && content.every((c) => c?.type === "text" && c.text === json);
    if (!derived) return this.clean(message);
    const clean = this.clean({ ...message, result: { ...result, content: [] } }) as { result: { structuredContent: unknown } };
    const text = JSON.stringify(clean.result.structuredContent);
    return { ...clean, result: { ...clean.result, content: content.map(() => ({ type: "text", text })) } } as T;
  }

  /** A sanitized error; if even sanitizing fails, a generic secret error that quotes nothing. */
  private cleanError(error: JevErrorJson): JevErrorJson {
    try {
      return this.clean(error);
    } catch {
      return SecretGuard.refused("The error text").toJSON();
    }
  }
}
