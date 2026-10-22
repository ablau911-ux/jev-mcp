import { TypeSafeClient, type Compression, type Logger } from "@typesafe-ai/sdk";
import { abortReason } from "../core/Deadline.js";
import type { WireRequest } from "../core/types.js";
import type { KeyProvider } from "../security/KeyProvider.js";
import { CompressingFetch, type CompressionMode, type FetchFn } from "./CompressingFetch.js";
import { abortError, mapSdkError } from "./ErrorMapper.js";
import type { JevTransport, TransportOptions, TransportResponse } from "./JevTransport.js";

export interface SdkTransportOptions {
  baseUrl: string;
  compression: CompressionMode;
  compressionMinBytes: number;
  fetch?: FetchFn;
}

const SILENT: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * JevTransport on the official @typesafe-ai/sdk 0.7.x. SDK retries are disabled (the Retrier
 * owns them) and SDK logging is off, because SDK debug logs do not redact bodies.
 *
 * Compression (JEV_COMPRESSION): `auto`/`zstd` let the SDK zstd-compress bodies of 1 KiB or
 * more (its default); `off` sends every body plain; `gzip` turns SDK compression off and
 * gzips JSON bodies in a fetch wrapper, for gateways that reject zstd. Exactly one layer is
 * ever applied. Images go as multipart/form-data parts (SDK 0.7 `assets`).
 */
export class SdkTransport implements JevTransport {
  private client: TypeSafeClient | null = null;
  private clientKeyFingerprint: string | null = null;

  constructor(
    private readonly keys: KeyProvider,
    private readonly options: SdkTransportOptions,
  ) {}

  async systemOne(body: WireRequest, options: TransportOptions): Promise<TransportResponse> {
    return this.call(options, async () => {
      const client = this.getClient();
      const request = body as unknown as Parameters<TypeSafeClient["systemOne"]>[0];
      const res = await client.systemOne(request, this.requestOptions(options)).withResponse();
      return { data: res.data, requestId: res.requestId ?? null };
    });
  }

  async listModels(options: TransportOptions): Promise<TransportResponse> {
    return this.call(options, async () => {
      const client = this.getClient();
      const res = await client.models.list(this.requestOptions(options)).withResponse();
      return { data: { models: res.data }, requestId: res.requestId ?? null };
    });
  }

  /** The SDK compression value for a mode; exposed for tests. */
  static sdkCompression(mode: CompressionMode): Compression | undefined {
    if (mode === "off" || mode === "gzip") return false;
    return undefined; // SDK default: zstd when the runtime has it, else plain.
  }

  private requestOptions(options: TransportOptions) {
    return { headers: options.headers, signal: options.signal, timeout: options.timeoutMs, retry: { maxRetries: 0 } };
  }

  /** SDK 0.7 rejects (never throws synchronously); both paths are mapped to JevError here. */
  private async call(options: TransportOptions, fn: () => Promise<TransportResponse>): Promise<TransportResponse> {
    if (options.signal?.aborted) throw abortError(abortReason(options.signal));
    try {
      return await fn();
    } catch (err) {
      throw mapSdkError(err, () => (options.signal?.aborted ? abortReason(options.signal) : null));
    }
  }

  private getClient(): TypeSafeClient {
    const key = this.keys.getKey();
    const fingerprint = `${key.length}:${key.slice(-4)}`;
    if (this.client && this.clientKeyFingerprint === fingerprint) return this.client;
    const base = this.options.fetch ?? ((input, init) => fetch(input, init));
    const mode = this.options.compression;
    const fetchFn = mode === "gzip" ? new CompressingFetch(base, "gzip", this.options.compressionMinBytes).fetch : base;
    this.client = new TypeSafeClient({
      apiKey: key,
      baseURL: this.options.baseUrl,
      logLevel: "off",
      logger: SILENT,
      retry: { maxRetries: 0 },
      compression: SdkTransport.sdkCompression(mode),
      fetch: fetchFn,
    });
    this.clientKeyFingerprint = fingerprint;
    return this.client;
  }
}
