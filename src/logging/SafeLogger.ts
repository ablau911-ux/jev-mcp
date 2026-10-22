import type { Redactor } from "../security/Redactor.js";

export type LogLevel = "error" | "warn" | "info";

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2 };

type Sink = (line: string) => void;

/** One-line request summary logged at `info`. Never contains state, bodies or keys. */
export interface RequestLogLine {
  tool: string;
  model: string;
  questions: number;
  status: string;
  latency_ms: number;
  input_tokens?: number;
  request_id?: string | null;
}

/**
 * Logger that writes only to stderr (stdout is the MCP channel), filters by level, runs the
 * secret guard's full value scan on every message (bug r10) and passes every line through the
 * Redactor (registered secrets and their fragments).
 */
export class SafeLogger {
  constructor(
    private readonly redactor: Redactor,
    private level: LogLevel = "warn",
    private readonly sink: Sink = (line) => process.stderr.write(`${line}\n`),
    /** The secret guard's full value scan of the message (bug r10); identity when absent. */
    private readonly scan: (text: string) => string = (text) => text,
  ) {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  error(message: string): void {
    this.write("error", message);
  }

  warn(message: string): void {
    this.write("warn", message);
  }

  info(message: string): void {
    this.write("info", message);
  }

  request(line: RequestLogLine): void {
    this.write("info", `request ${JSON.stringify(line)}`);
  }

  private write(level: LogLevel, message: string): void {
    if (ORDER[level] > ORDER[this.level]) return;
    // Bug r9: no PART of a live secret is printed either (a config path or a parse error quoting the key).
    // The message is scanned on its own, so its lines keep their own format (bug r10).
    this.sink(this.redactor.maskFragments(this.redactor.scrub(`[jev-mcp] ${level}: ${this.scan(message)}`), () => "[REDACTED]"));
  }
}
