import type { GitRunner } from "../refs/DiffSource.js";
import type { DecisionLog } from "./DecisionLog.js";

const FIX_TEST = /\b(fix|fixes|fixed)\b.*\btests?\b|\btests?\b.*\b(fix|fixes|fixed)\b/i;

/**
 * Seeds an evaluation set from git history: commits whose subject says
 * they fixed failing tests become `seed` records (hash and subject only). They are the
 * starting list for labelled test-triage cases; nothing is sent to TypeSafe.
 */
export class GitSeeder {
  constructor(
    private readonly git: GitRunner,
    private readonly log: DecisionLog,
    private readonly timeoutMs: number,
  ) {}

  async seed(cwd: string, limit = 300): Promise<{ scanned: number; seeded: number; error?: string }> {
    let out: string;
    try {
      out = await this.git(["log", `-n${limit}`, "--format=%H%x09%s"], cwd, this.timeoutMs);
    } catch (e) {
      // Not a git work tree, no git, or a timeout: reported next to the fits, never instead of them.
      const first = (e instanceof Error ? e.message : String(e)).split(/\r?\n/)[0] ?? "";
      return { scanned: 0, seeded: 0, error: `git log failed: ${first.slice(0, 200)}` };
    }
    const lines = out.split(/\r?\n/).filter((l) => l.includes("\t"));
    const known = new Set(this.log.all().flatMap((r) => (r.type === "seed" ? [r.commit] : [])));
    let seeded = 0;
    for (const line of lines) {
      const [commit = "", subject = ""] = line.split("\t");
      if (!FIX_TEST.test(subject) || known.has(commit)) continue;
      this.log.append({ type: "seed", ts: new Date().toISOString(), commit, subject: subject.slice(0, 200) });
      seeded++;
    }
    return { scanned: lines.length, seeded };
  }
}
