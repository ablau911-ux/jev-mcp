import { textHash } from "../calibration/AutoLabeler.js";
import type { DecisionRecord } from "../calibration/DecisionLog.js";
import type { Preset } from "../config/types.js";
import type { BatchRun, ItemResult } from "../core/BatchRunner.js";
import { EntryWalker } from "../core/EntryWalker.js";
import { AnswerShaper, type ShortAnswer } from "../output/AnswerShaper.js";

export type ReturnMode = "ranked" | "flagged" | "all";

export interface BatchShape {
  presetName: string;
  preset: Preset;
  rankBy?: string;
  mode?: ReturnMode;
  topK: number;
  detail: boolean;
}

export interface BatchRow {
  item: string;
  verdict: string | null;
  p: number | null;
  decision: string;
  flag?: boolean;
  /** Which question gave `p` when several Nouls are combined with max. */
  by?: string;
  answers?: Record<string, ShortAnswer>;
}

/**
 * Concise jev_batch output: `[{item, verdict, p, decision}]` sorted by p,
 * as top-k (ranked) or only the flagged items, with a summary count and every failure
 * expanded. Recall-filter presets (flag_at) combine several Nouls per item with max (diff
 * review recipe). State is never echoed.
 */
export class BatchShaper {
  constructor(private readonly shaper: AnswerShaper) {}

  shape(run: BatchRun, o: BatchShape) {
    const warnings = [...run.warnings];
    const rankBy = BatchShaper.rankBy(run, o.rankBy, warnings);
    const shaped = run.results.filter((r) => r.ok && r.call).map((r) => this.row(r, { ...o, rankBy }));
    const missing = shaped.filter((s) => s.missing).length;
    if (missing > 0) warnings.push(`rank_by ${JSON.stringify(rankBy)} has no answer for ${missing} item(s); they show p null and decision review.`);
    const mode = o.mode ?? (o.preset.flag_at ? "flagged" : rankBy ? "ranked" : "all");
    const sorted = [...shaped].sort((a, b) => (b.row.p ?? -1) - (a.row.p ?? -1));
    const flagged = sorted.filter((s) => s.flagged);
    const picked = (mode === "flagged" ? flagged : sorted).map((s) => s.row);
    const items = picked.slice(0, mode === "all" ? undefined : o.topK);
    return { model: run.models.length === 1 ? run.models[0] : run.models, summary: this.summary(run, flagged.length, items.length), items, failures: this.failures(run.results), warnings };
  }

  /** Keep the requested metric even when absent, so no row can substitute another question. */
  private static rankBy(run: BatchRun, rankBy: string | undefined, warnings: string[]): string | undefined {
    if (rankBy === undefined || run.questions.includes(rankBy)) return rankBy;
    warnings.push(`rank_by ${JSON.stringify(rankBy)} names no question (${run.questions.join(", ")}); rows show p null and decision review.`);
    return rankBy;
  }

  private row(r: ItemResult, o: BatchShape): { row: BatchRow; flagged: boolean; missing: boolean } {
    const call = r.call!;
    // Exactly the asked questions, as in jev_ask: a missing answer is review, an unasked one is dropped (break hunt 1).
    const answers = this.shaper.shapeAll(call, { presetName: o.presetName, preset: o.preset, detail: o.detail, subject: BatchShaper.subject(r), ...(r.asked ? { asked: r.asked } : {}) });
    const [by, top] = this.primary(answers, o);
    const row: BatchRow = { item: r.id, verdict: top?.verdict ?? null, p: top?.p ?? null, decision: top?.decision ?? "review" };
    if (o.preset.flag_at) row.flag = Object.values(answers).some((a) => a.flag === true);
    if (Object.keys(answers).length > 1) row.by = by;
    if (o.detail) row.answers = answers;
    // Without flag_at an item is flagged when ANY answer is not auto, not only the primary one (break: flagged first question).
    const flagged = o.preset.flag_at ? row.flag === true : row.decision !== "auto" || Object.values(answers).some((a) => a.decision !== "auto");
    return { row, flagged, missing: o.rankBy !== undefined && top === undefined };
  }

  /** rank_by question (own key only; missing = undefined); else for recall filters the Noul with the highest p; else the first. */
  private primary(answers: Record<string, ShortAnswer>, o: BatchShape): [string, ShortAnswer | undefined] {
    if (o.rankBy !== undefined) return [o.rankBy, Object.hasOwn(answers, o.rankBy) ? answers[o.rankBy] : undefined];
    const entries = Object.entries(answers);
    if (o.preset.flag_at) return entries.reduce((best, cur) => ((cur[1].p ?? -1) > (best[1].p ?? -1) ? cur : best), entries[0] ?? ["", undefined as never]);
    return entries[0] ?? ["", undefined];
  }

  private summary(run: BatchRun, flagged: number, shown: number) {
    const ok = run.results.filter((r) => r.ok && r.call);
    const fresh = ok.filter((r) => !r.call!.cached);
    const tokens = fresh.reduce((a, r) => a + r.call!.usage.input_tokens, 0);
    return {
      total: run.results.length,
      ok: ok.length,
      failed: run.results.filter((r) => !r.ok && !r.skipped).length,
      skipped: run.results.filter((r) => r.skipped).length,
      flagged,
      shown,
      cached: ok.length - fresh.length,
      input_tokens: tokens,
      est_cost_usd: fresh.reduce((a, r) => a + r.call!.usage.est_cost_usd, 0),
      // Every sent request counts, ok or failed (break: secrets_redacted).
      secrets_redacted: run.results.reduce((a, r) => a + (r.call?.secrets_redacted ?? r.secrets_redacted ?? 0), 0),
      wall_ms: run.wall_ms,
      rate_limit_events: run.rate_limit_events,
    };
  }

  private failures(results: ItemResult[]) {
    return results.filter((r) => !r.ok).map((r) => (r.skipped ? { item: r.id, skipped: r.skipped } : { item: r.id, error: { kind: r.error?.kind, message: r.error?.message, fix: r.error?.fix, retryable: r.error?.retryable } }));
  }

  static subject(r: ItemResult): DecisionRecord["subject"] {
    const s = r.item.subject;
    if (!s || s.kind === "item") return { kind: "item", key: s?.key ?? r.id, hash: BatchShaper.itemHash(r) };
    return s.kind === "hunk" ? { kind: "hunk", key: s.key, hash: textHash(s.text ?? "") } : { kind: s.kind, key: s.key };
  }

  /** What the item says, so a rerun labels only decisions on this content, not an unrelated batch's reuse of its id. */
  static itemHash(r: ItemResult): string {
    // Production calls carry the exact prepared input identity, including expanded refs.
    if (r.call?.content_hash) return r.call.content_hash;
    return textHash(EntryWalker.canonical({
      state: r.item.state,
      questions: r.effectiveQuestions ?? r.item.questions ?? null,
      images: Object.fromEntries((r.call?.images ?? []).map((image) => [image.name, image.sha256])),
    }));
  }
}
