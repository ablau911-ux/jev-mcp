import * as zlib from "node:zlib";

export type CompressionMode = "auto" | "off" | "gzip" | "zstd";
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Fetch wrapper for `JEV_COMPRESSION=gzip` only: JSON string bodies of `minBytes` or more
 * get one gzip layer (`/api/errors.md` allows gzip). SDK compression is off in that mode, so
 * a body is never compressed twice. Multipart (Blob) bodies pass through unchanged.
 */
export class CompressingFetch {
  constructor(
    private readonly inner: FetchFn,
    private readonly mode: "gzip",
    private readonly minBytes: number,
  ) {}

  readonly fetch: FetchFn = (input, init) => {
    const body = init?.body;
    if (typeof body !== "string") return this.inner(input, init);
    const raw = Buffer.from(body, "utf8");
    if (raw.length < this.minBytes) return this.inner(input, init);
    const headers = new Headers(init?.headers);
    headers.set("Content-Encoding", this.algorithm());
    return this.inner(input, { ...init, headers, body: new Uint8Array(zlib.gzipSync(raw)) });
  };

  algorithm(): "gzip" {
    return this.mode;
  }
}
