import { APIConnectionError, APIError, APITimeoutError, APIUserAbortError, TypeSafeError } from "@typesafe-ai/sdk";
import { JevError } from "../core/JevError.js";

const MAX_MESSAGE = 600;
const INLINE = "Judge inline for now; do not retry in a loop.";

/** Reads `retry-after-ms` first, then `Retry-After` (seconds or HTTP date). Null when absent. */
export function parseRetryAfter(headers: Headers | undefined, now: () => number = Date.now): number | null {
  if (!headers) return null;
  const msRaw = headers.get("retry-after-ms");
  if (msRaw !== null) {
    const ms = Number(msRaw);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  const raw = headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - now());
  return null;
}

function bodyText(body: unknown): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function serverMessage(body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    for (const key of ["message", "error", "detail", "code"]) {
      const v = b[key];
      if (typeof v === "string" && v.length > 0) return v;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const inner = (v as Record<string, unknown>).message;
        if (typeof inner === "string") return inner;
      }
    }
  }
  return bodyText(body).slice(0, MAX_MESSAGE);
}

interface ValidationDetail {
  loc?: unknown;
  msg?: unknown;
  type?: unknown;
}

/** 422 `loc` (`["body","questions","q",0]`) as a JSON path (`$.questions.q[0]`). */
export function locToJsonPath(loc: unknown): string | null {
  if (!Array.isArray(loc)) return null;
  const parts = loc[0] === "body" ? loc.slice(1) : loc;
  return parts.reduce<string>((path, p) => {
    if (typeof p === "number") return `${path}[${p}]`;
    // Only primitives are stringified: String() on a hostile object can throw (break: 422 fuzz).
    const key = p !== null && typeof p === "object" ? "?" : String(p);
    return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
  }, "$");
}

/** The readable entries of a 422 `detail[]` list; null and non-object entries are skipped (break: 422 fuzz). */
function validationEntries(body: unknown): ValidationDetail[] {
  if (!body || typeof body !== "object") return [];
  const detail = (body as { detail?: unknown }).detail;
  if (!Array.isArray(detail)) return [];
  return detail.filter((d): d is ValidationDetail => d !== null && typeof d === "object" && !Array.isArray(d));
}

/** Renders a 422 `detail[]` list as readable lines: `$.questions.q1.criteria: msg (type)`. */
export function renderValidationDetail(body: unknown): string[] {
  return validationEntries(body).map((d) => {
    const type = typeof d.type === "string" ? ` (${d.type})` : "";
    return `${locToJsonPath(d.loc) ?? "?"}: ${typeof d.msg === "string" ? d.msg : "invalid"}${type}`;
  });
}

interface StatusRule {
  kind: JevError["kind"];
  fix: string;
  retryable: boolean;
}

const STATUS_RULES: Record<number, StatusRule> = {
  401: { kind: "auth", fix: "Check or recreate the API key at https://console.typesafe.ai/keys. " + INLINE, retryable: false },
  403: { kind: "permission", fix: "The key has no access to this resource or model. Use a listed model (jev_status action models).", retryable: false },
  404: { kind: "not_found", fix: "Check the model name; use jev_status action models.", retryable: false },
  408: { kind: "timeout", fix: "Request timed out on the server. " + INLINE, retryable: true },
  413: { kind: "too_large", fix: "Over a size limit (body, image, pixels, expanded request or reference). Trim state or split into jev_batch items.", retryable: false },
  415: { kind: "bad_encoding", fix: "Disable compression with JEV_COMPRESSION=off (or gzip for gateways that reject zstd).", retryable: false },
  429: { kind: "rate_limited", fix: "Rate limited. " + INLINE, retryable: true },
  529: { kind: "overloaded", fix: "TypeSafe is overloaded. " + INLINE, retryable: true },
};

/** Maps an HTTP status + body + headers to a JevError. */
export function mapHttpError(status: number, body: unknown, headers?: Headers): JevError {
  const requestId = headers?.get("x-typesafe-request-id") ?? null;
  const retryAfterMs = parseRetryAfter(headers);
  const message = serverMessage(body) || `HTTP ${status}`;
  const base = { status, requestId, retryAfterMs };
  if (status === 400) return mapBadRequest(body, message, base);
  if (status === 422) return mapValidation(body, message, base);
  const rule = STATUS_RULES[status];
  if (rule) return new JevError({ ...base, ...rule, message });
  if (status >= 500) {
    return new JevError({ ...base, kind: "server_error", message, fix: `Server error (retried at most once; not a documented retryable status). ${INLINE}`, retryable: true });
  }
  return new JevError({ ...base, kind: "bad_request", message, fix: `Unexpected HTTP ${status}. ${INLINE}` });
}

function mapValidation(body: unknown, message: string, base: { status: number; requestId: string | null; retryAfterMs: number | null }): JevError {
  const lines = renderValidationDetail(body);
  const first = validationEntries(body)[0];
  const loc = first ? locToJsonPath(first.loc) : null;
  return new JevError({
    ...base,
    kind: "validation",
    message: lines.length > 0 ? `Validation failed: ${lines.join("; ")}` : message,
    fix: "The server rejected the request shape. Fix the field at `loc` and resend once.",
    detail: lines.length > 0 ? lines : undefined,
    loc,
  });
}

function mapBadRequest(body: unknown, message: string, base: { status: number; requestId: string | null; retryAfterMs: number | null }): JevError {
  if (bodyText(body).includes("max_tokens_exceeded")) {
    return new JevError({ ...base, kind: "context_too_long", message, fix: "Trim state (line ranges, $diff hunks, top frames) or split it into jev_batch items." });
  }
  return new JevError({ ...base, kind: "bad_request", message, fix: "The server rejected the request (request rules, images header, unreferenced asset or image limits). Fix and resend once." });
}

/** Maps an error thrown or rejected by @typesafe-ai/sdk 0.7 (or fetch) to a JevError. */
export function mapSdkError(err: unknown, aborted: () => "deadline" | "caller" | null): JevError {
  if (err instanceof JevError) return err;
  if (err instanceof APIError) return mapHttpError(err.status, err.body, err.headers);
  if (err instanceof APIUserAbortError) return abortError(aborted());
  // APITimeoutError extends APIConnectionError in 0.7: check it first.
  if (err instanceof APITimeoutError) return new JevError({ kind: "timeout", message: err.message, fix: `Attempt timed out. ${INLINE}`, retryable: true });
  if (err instanceof APIConnectionError) return new JevError({ kind: "network", message: err.message, fix: `Connection failed (offline?). ${INLINE}`, retryable: true });
  if (err instanceof TypeSafeError) return JevError.invalid(err.message);
  const message = err instanceof Error ? err.message : String(err);
  return new JevError({ kind: "network", message, fix: `Transport failure. ${INLINE}`, retryable: true });
}

export function abortError(reason: "deadline" | "caller" | null): JevError {
  if (reason === "deadline") {
    return new JevError({ kind: "timeout", message: "Total deadline exceeded.", fix: `Jev did not answer in time. ${INLINE}`, retryable: false });
  }
  return new JevError({ kind: "cancelled", message: "Request cancelled.", fix: "Cancelled by the client." });
}
