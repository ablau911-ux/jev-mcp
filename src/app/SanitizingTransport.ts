import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { SecretGuard } from "../validation/SecretGuard.js";

/** JSON-RPC "internal error": the reply when a response cannot be sanitized. */
const INTERNAL_ERROR = -32603;

/**
 * THE outbound layer of the MCP server (round 7): every JSON-RPC message the server sends
 * (results of every handler, SDK-built errors such as "resource not found" or Zod validation,
 * unknown-method errors, notifications) passes the same sanitizer as tool output before it
 * reaches the client, from the first call on. Handlers need no secret code of their own.
 * A message that cannot be sanitized is replaced by an error that quotes nothing.
 */
export class SanitizingTransport {
  constructor(private readonly clean: <T>(value: T) => T) {}

  /** Wraps `transport.send` in place and returns the transport. */
  wrap<T extends Transport>(transport: T): T {
    const send = transport.send.bind(transport);
    transport.send = (message: JSONRPCMessage, options?: TransportSendOptions) => send(this.message(message), options);
    return transport;
  }

  /** The whole message is cleaned: `id`, `method`, `result`, `error` and any other field (round 8). */
  private message(message: JSONRPCMessage): JSONRPCMessage {
    try {
      return { ...this.clean(message), jsonrpc: "2.0" } as JSONRPCMessage;
    } catch {
      const id = (message as { id?: unknown }).id;
      if (id === undefined) return { jsonrpc: "2.0", method: "notifications/message", params: { level: "error", data: SecretGuard.refused("A notification").message } };
      return { jsonrpc: "2.0", id: this.safeId(id), error: { code: INTERNAL_ERROR, message: SecretGuard.refused("The response").message } } as JSONRPCMessage;
    }
  }

  /** The id when it cleans unchanged; else null (a JSON-RPC error with an unknown id). */
  private safeId(id: unknown): unknown {
    try {
      return this.clean({ id }).id === id ? id : null;
    } catch {
      return null;
    }
  }
}
