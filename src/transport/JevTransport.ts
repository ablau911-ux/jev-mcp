import type { WireRequest } from "../core/types.js";

export interface TransportOptions {
  headers: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface TransportResponse {
  data: unknown;
  requestId: string | null;
}

/**
 * One HTTP attempt against the TypeSafe API. Implementations do not retry (the Retrier
 * owns retries, Retry-After and the rate gate) and throw only JevError.
 */
export interface JevTransport {
  systemOne(body: WireRequest, options: TransportOptions): Promise<TransportResponse>;
  listModels(options: TransportOptions): Promise<TransportResponse>;
}
