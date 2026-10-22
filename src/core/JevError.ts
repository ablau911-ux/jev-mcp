/** Internal error kinds (fine grained; logged and returned as `cause`). */
export type ErrorKind =
  | "no_api_key"
  | "invalid_api_key"
  | "invalid_input"
  | "secret"
  | "auth"
  | "permission"
  | "not_found"
  | "context_too_long"
  | "bad_request"
  | "too_large"
  | "bad_encoding"
  | "validation"
  | "rate_limited"
  | "overloaded"
  | "server_error"
  | "timeout"
  | "network"
  | "cancelled"
  | "bad_response"
  | "budget_exceeded"
  | "internal";

/**
 * Public kinds the agent routes on. `unavailable`, `rate_limited` and
 * `budget_exceeded` mean: judge inline, do not retry in a loop.
 */
export type PublicKind = "invalid_input" | "too_large" | "secret" | "auth" | "unavailable" | "rate_limited" | "budget_exceeded" | "cancelled" | "internal";

const PUBLIC: Record<ErrorKind, PublicKind> = {
  no_api_key: "auth",
  invalid_api_key: "auth",
  auth: "auth",
  permission: "auth",
  invalid_input: "invalid_input",
  validation: "invalid_input",
  bad_request: "invalid_input",
  bad_encoding: "invalid_input",
  not_found: "invalid_input",
  secret: "secret",
  context_too_long: "too_large",
  too_large: "too_large",
  rate_limited: "rate_limited",
  overloaded: "unavailable",
  server_error: "unavailable",
  timeout: "unavailable",
  network: "unavailable",
  bad_response: "unavailable",
  budget_exceeded: "budget_exceeded",
  cancelled: "cancelled",
  internal: "internal",
};

export interface JevErrorInit {
  kind: ErrorKind;
  message: string;
  fix?: string;
  status?: number | null;
  requestId?: string | null;
  retryable?: boolean;
  detail?: unknown;
  retryAfterMs?: number | null;
  /** JSON path of the offending input field (from a 422 `loc` or a local check). */
  loc?: string | null;
}

/** Structured error object returned to the agent: `{kind, message, fix, retryable}` plus context. */
export interface JevErrorJson {
  kind: PublicKind;
  message: string;
  fix: string;
  retryable: boolean;
  cause: ErrorKind;
  status?: number;
  request_id?: string;
  retry_after_ms?: number;
  loc?: string;
  detail?: unknown;
}

/** The single error type every layer throws. Never carries secrets (scrubbed on output). */
export class JevError extends Error {
  readonly kind: ErrorKind;
  readonly fix: string;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly retryable: boolean;
  readonly detail: unknown;
  readonly retryAfterMs: number | null;
  readonly loc: string | null;

  constructor(init: JevErrorInit) {
    super(init.message);
    this.name = "JevError";
    this.kind = init.kind;
    // Every error carries a fix.
    this.fix = init.fix !== undefined && init.fix.length > 0 ? init.fix : "Judge inline; report this error if it repeats.";
    this.status = init.status ?? null;
    this.requestId = init.requestId ?? null;
    this.retryable = init.retryable ?? false;
    this.detail = init.detail;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.loc = init.loc ?? null;
  }

  static invalid(message: string, detail?: unknown, fix = "Fix the input; nothing was sent to the API.", loc?: string): JevError {
    return new JevError({ kind: "invalid_input", message, fix, detail, loc: loc ?? null });
  }

  get publicKind(): PublicKind {
    return PUBLIC[this.kind];
  }

  toJSON(): JevErrorJson {
    const out: JevErrorJson = { kind: this.publicKind, message: this.message, fix: this.fix, retryable: this.retryable, cause: this.kind };
    if (this.status !== null) out.status = this.status;
    if (this.requestId !== null) out.request_id = this.requestId;
    if (this.retryAfterMs !== null) out.retry_after_ms = this.retryAfterMs;
    if (this.loc !== null) out.loc = this.loc;
    if (this.detail !== undefined) out.detail = this.detail;
    return out;
  }
}

/** Wraps any thrown value as a JevError. */
export function asJevError(err: unknown): JevError {
  if (err instanceof JevError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new JevError({ kind: "internal", message, fix: "Unexpected error inside jev-mcp; judge inline and report it." });
}
