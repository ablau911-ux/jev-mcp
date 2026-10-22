import { LogFile } from "./LogFile.js";

export interface DecisionRecord {
  type: "decision";
  id: string;
  ts: string;
  preset: string;
  metric: string;
  p: number | null;
  action: string;
  verdict: string | null;
  model: string;
  /** What was judged, for auto-labels: a diff hunk (file + text hash) or a file path. */
  subject?: { kind: "hunk" | "file" | "item"; key: string; hash?: string };
}

export interface LabelRecord {
  type: "label";
  id: string;
  ts: string;
  /** True when the decision's verdict was right. */
  label: boolean;
  source: "agent" | "rerun" | "hunk_edit" | "file_open" | "git_seed";
}

export interface SeedRecord {
  type: "seed";
  ts: string;
  commit: string;
  subject: string;
}

export type LogRecord = DecisionRecord | LabelRecord | SeedRecord;

/**
 * Append-only JSONL of decisions and labels, metadata only: never state,
 * questions or file content. Lives in `%USERPROFILE%\.typesafe\jev-decisions.jsonl`
 * (outside any repo). An in-memory copy serves the session when the file is off, and keeps
 * the records the file refused (read-only file, full disk) so this session still sees them.
 */
export class DecisionLog {
  /** Records not on disk: every record while the file is off, else only those whose write failed. */
  private readonly memory: LogRecord[] = [];
  private readonly file: LogFile | null;

  constructor(
    path: string | null,
    /** Secret guard for persisted records (OutboundSanitizer.scrubValue); identity in unit tests. */
    private readonly sanitize: <T>(value: T) => T = (v) => v,
  ) {
    this.file = path ? new LogFile(path) : null;
  }

  append(raw: LogRecord): void {
    const record = this.sanitize(raw);
    // Flush older failed writes first. A recovered file must never put a correction
    // ahead of the older feedback still waiting in memory (even with identical ts).
    if (this.file) {
      while (this.memory.length > 0) {
        if (!this.file.append(this.memory[0]!)) {
          this.memory.push(record);
          return;
        }
        this.memory.shift();
      }
      if (this.file.append(record)) return;
    }
    this.memory.push(record);
  }

  /** The file's records plus the ones this session could not write. */
  all(): LogRecord[] {
    return [...(this.file?.index().records ?? []), ...this.memory];
  }

  decisions(): DecisionRecord[] {
    return [...(this.file?.index().decisions ?? []), ...this.memory.filter((r): r is DecisionRecord => r.type === "decision")];
  }

  /** One decision by its exact id, without a scan of the lifetime log. */
  decision(id: string): DecisionRecord | undefined {
    return this.file?.index().decision(id) ?? this.memory.find((r): r is DecisionRecord => r.type === "decision" && r.id === id);
  }

  /** Ids of the decisions already labelled by one of `sources`, in this session or an earlier one. */
  labelledBy(...sources: Array<LabelRecord["source"]>): Set<string> {
    const out = this.file?.index().labelledBy(sources, new Set()) ?? new Set<string>();
    for (const r of this.memory) if (r.type === "label" && sources.includes(r.source)) out.add(r.id);
    return out;
  }

  /** Decision records joined with their latest label and where it came from. */
  labelled(): Array<DecisionRecord & { label: boolean; source: LabelRecord["source"] }> {
    const labels = new Map<string, LabelRecord>();
    for (const r of this.all()) if (r.type === "label") labels.set(r.id, r);
    return this.decisions().flatMap((d) => {
      const l = labels.get(d.id);
      return l ? [{ ...d, label: l.label, source: l.source }] : [];
    });
  }
}
