import { LineIndex } from "../files/LineIndex.js";

export interface LogTrimOptions {
  tailLines: number;
  maxFrames: number;
  framePatterns: string[];
  dropPatterns: string[];
}

/**
 * `$log` source (§3 test triage): keeps the last N lines and, in each stack
 * trace, only the top `maxFrames` frames that are not library/runtime frames. Minimal state
 * costs fewer tokens and gives injected text less room.
 */
export class LogTrimmer {
  private readonly frame: RegExp[];
  private readonly drop: string[];

  constructor(private readonly o: LogTrimOptions) {
    this.frame = o.framePatterns.map((p) => new RegExp(p));
    this.drop = o.dropPatterns;
  }

  /** Default tail length (lines). */
  get tailLines(): number {
    return this.o.tailLines;
  }

  /** `skipped`: lines before `text` that were never read (the tail of a large file). */
  trim(text: string, tail = this.o.tailLines, skipped = 0): string {
    const all = LineIndex.split(text);
    const lines = all.slice(Math.max(0, all.length - tail));
    const earlier = all.length - lines.length + skipped;
    const out: string[] = earlier > 0 ? [`... ${earlier} earlier lines trimmed`] : [];
    let kept = 0;
    let dropped = 0;
    for (const line of lines) {
      if (!this.isFrame(line)) {
        this.flush(out, dropped);
        kept = 0;
        dropped = 0;
        out.push(line);
        continue;
      }
      if (kept < this.o.maxFrames && !this.drop.some((d) => line.includes(d))) {
        out.push(line);
        kept++;
      } else dropped++;
    }
    this.flush(out, dropped);
    return out.join("\n");
  }

  isFrame(line: string): boolean {
    return this.frame.some((re) => re.test(line));
  }

  private flush(out: string[], dropped: number): void {
    if (dropped > 0) out.push(`    ... ${dropped} frames trimmed`);
  }
}
