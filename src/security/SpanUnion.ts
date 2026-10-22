/** A span to mask: `[start, end)` of the text, its kind, and the kind's rank (higher wins in a merged run). */
export interface MaskSpan {
  start: number;
  end: number;
  kind: string;
  rank: number;
}

/**
 * The union of every span the guard wants masked in one string (bug r20): live secrets,
 * known-token patterns and keyed values are all found on the ORIGINAL text, then overlapping
 * spans are merged into one run, so a pattern match inside a keyed value never shortens the
 * keyed span (and a keyed value never hides a live secret). A merged run takes the kind of its
 * highest-ranked span (a live credential over a pattern over a keyed value).
 */
export class SpanUnion {
  private readonly spans: MaskSpan[] = [];

  add(start: number, end: number, kind: string, rank: number): void {
    if (end > start) this.spans.push({ start, end, kind, rank });
  }

  /** `text` with every merged run replaced by `mask(kind)`. */
  apply(text: string, mask: (kind: string) => string): string {
    let out = "";
    let at = 0;
    for (const run of this.runs()) {
      out += text.slice(at, run.start) + mask(run.kind);
      at = run.end;
    }
    return out + text.slice(at);
  }

  /** The spans merged where they overlap, in order. */
  private runs(): MaskSpan[] {
    const sorted = [...this.spans].sort((a, b) => a.start - b.start || b.end - a.end);
    const runs: MaskSpan[] = [];
    for (const s of sorted) {
      const last = runs[runs.length - 1];
      if (last && s.start < last.end) {
        last.end = Math.max(last.end, s.end);
        if (s.rank > last.rank) [last.kind, last.rank] = [s.kind, s.rank];
      } else runs.push({ ...s });
    }
    return runs;
  }
}
