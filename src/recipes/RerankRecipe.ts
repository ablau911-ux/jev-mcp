import { z } from "zod";
import type { DecisionLog } from "../calibration/DecisionLog.js";
import type { BatchRunner } from "../core/BatchRunner.js";
import { ChoiceChunker } from "../core/ChoiceChunker.js";
import { asJevError, JevError } from "../core/JevError.js";
import type { JevService } from "../core/JevService.js";
import type { CallResult, Entry } from "../core/types.js";
import { answerOf, sumUsage, warningsOf } from "./helpers.js";
import { Recipe, type RecipeContext } from "./Recipe.js";
import { commonCallShape, entry } from "../tools/schemas.js";

const shape = {
  query: entry.describe("What relevance is judged against (string or object)."),
  candidates: z
    .array(z.object({ id: z.string().min(1), text: entry.describe("Candidate text or object ($file allowed).") }))
    .min(1)
    .describe("Candidates to order. Narrow large sets with BM25/grep first; use Jev for the final order."),
  mode: z.enum(["pointwise", "listwise"]).optional().describe("pointwise: one Noul per candidate (one request each, rate-gated). listwise: one Choice over all (chunked above 200). Default pointwise."),
  top_k: z.number().int().positive().optional(),
  instructions: entry.optional().describe("Override the relevance question (pointwise state fields: query_excerpt, candidate_passage; listwise: query)."),
  concurrency: z.number().int().min(1).max(64).optional(),
  ...commonCallShape,
};

type Args = z.infer<z.ZodObject<typeof shape>>;

interface Ranked {
  id: string;
  score: number | null;
  rank: number;
  error?: string;
}

/** jev_rerank (P1): order candidates by relevance to a query. */
export class RerankRecipe extends Recipe<typeof shape> {
  readonly name = "rerank";
  readonly summary =
    "Order candidates (files, snippets) by relevance: one Noul per candidate (pointwise) or one Choice (listwise). Shortlist ~16 first (cap 64).";
  readonly example = { query: "where are retries configured", candidates: [{ id: "a", text: "$file:src/core/Retrier.ts" }, { id: "b", text: "$file:src/server.ts" }] };
  readonly schema = shape;

  constructor(
    private readonly service: JevService,
    private readonly batch: BatchRunner,
    private readonly log?: DecisionLog,
  ) {
    super();
  }

  async run(args: Args, ctx: RecipeContext): Promise<object> {
    const ids = new Set(args.candidates.map((c) => c.id));
    if (ids.size !== args.candidates.length) throw JevError.invalid("Candidate ids must be unique.");
    const r = this.service.config.rerank;
    if (args.candidates.length > r.maxCandidates) {
      throw JevError.invalid(`${args.candidates.length} candidates; the window is at most ${r.maxCandidates}.`, undefined, `Shortlist with grep/BM25 first (about ${r.shortlist}); wide windows give tiny margins.`);
    }
    const out = args.mode === "listwise" ? await this.listwise(args, ctx) : await this.pointwise(args, ctx);
    const ranked = RerankRecipe.rank(out.scores, args.candidates.map((c) => c.id), out.errors);
    const warnings = args.candidates.length > r.shortlist ? [`${args.candidates.length} candidates: above the ~${r.shortlist} shortlist, margins shrink.`] : [];
    out.warnings.push(...warnings);
    return {
      ranked: args.top_k ? ranked.slice(0, args.top_k) : ranked,
      mode: args.mode ?? "pointwise",
      model: out.calls[0]?.model ?? null,
      usage: sumUsage(out.calls),
      warnings: warningsOf(out.calls, out.warnings),
    };
  }

  /** Sorts by score descending; ties and missing scores keep input order (stable). */
  static rank(scores: Map<string, number>, order: string[], errors: Map<string, string> = new Map()): Ranked[] {
    const rows = order.map((id, i) => ({ id, i, score: scores.get(id) ?? null }));
    rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.i - b.i);
    return rows.map((r, idx) => {
      const out: Ranked = { id: r.id, score: r.score, rank: idx + 1 };
      const err = errors.get(r.id);
      if (err) out.error = err;
      return out;
    });
  }

  /** Logs a decision per `$file` candidate so a later read of that file auto-labels it. */
  private recordFile(text: unknown, p: number, call: CallResult): void {
    const path = typeof text === "string" ? /^\$file:([^#]+)/.exec(text)?.[1] : undefined;
    if (!path || !this.log || call.cached) return;
    this.log.append({ type: "decision", id: `${call.client_id.replace(/-/g, "").slice(0, 12)}.relevant`, ts: new Date().toISOString(), preset: "rerank", metric: "noul_p", p, action: "auto", verdict: p >= 0.5 ? "yes" : "no", model: call.model, subject: { kind: "file", key: path } });
  }

  private async pointwise(args: Args, ctx: RecipeContext) {
    const warnings: string[] = [];
    const gate = this.batch.createGate(args.concurrency, warnings);
    const instructions = (args.instructions as Entry | undefined) ?? this.service.config.prompts.rerankPointwise;
    const calls: CallResult[] = [];
    const scores = new Map<string, number>();
    const errors = new Map<string, string>();
    await this.batch.map(args.candidates, gate.concurrency, async (cand) => {
      try {
        const call = await this.service.execute(
          { state: { query_excerpt: args.query as Entry, candidate_passage: cand.text as Entry }, questions: { relevant: { type: "noul", instructions } }, cache: args.cache },
          { tool: this.tool, signal: ctx.signal, gate, retryProfile: "batch" },
        );
        calls.push(call);
        const p = answerOf(call, "relevant", "noul").noul;
        scores.set(cand.id, p);
        this.recordFile(cand.text, p, call);
      } catch (err) {
        const e = asJevError(err);
        if (e.kind === "invalid_input" || e.kind === "no_api_key" || e.kind === "cancelled") throw e;
        errors.set(cand.id, `${e.kind}: ${e.message}`);
      }
    });
    if (errors.size > 0) warnings.push(`${errors.size} candidate(s) failed; ranked last.`);
    return { scores, errors, calls, warnings };
  }

  private async listwise(args: Args, ctx: RecipeContext) {
    const cfg = this.service.config;
    // Candidates become Choice criteria, which prepare never resolves: expand their refs here (once).
    const resolved = await Promise.all(args.candidates.map((c) => this.service.refs.resolveWithMeta(c.text as Entry)));
    const options = Object.fromEntries(args.candidates.map((c, i) => [c.id, resolved[i]?.value ?? (c.text as Entry)]));
    const untrusted = resolved.filter((r) => r.meta.untrusted).length;
    const chunker = new ChoiceChunker(this.service, args.candidates.length > cfg.limits.choiceMax ? cfg.rerank.listwiseChunk : cfg.limits.choiceMax);
    const res = await chunker.run(
      { state: { query: args.query as Entry }, options, instructions: (args.instructions as Entry | undefined) ?? cfg.prompts.rerankListwise, cache: args.cache },
      { tool: this.tool, signal: ctx.signal },
    );
    const scores = new Map<string, number>(Object.entries(res.answer.probabilities));
    const warnings: string[] = [];
    if (untrusted > 0) warnings.push(`${untrusted} candidate(s) hold untrusted content ($log or outside the workspace); no injection probe covers options: treat the order as confirm, not auto.`);
    if (res.round1 && res.calls[0]) {
      warnings.push("Chunked: finalists scored in round 2; other candidates carry round-1 probability scaled below the finalists.");
      const floor = Math.min(...scores.values(), 1);
      for (const a of Object.values(res.calls[0].answers)) {
        if (a.type !== "choice") continue;
        for (const [id, p] of Object.entries(a.probabilities)) if (!scores.has(id)) scores.set(id, p * floor * 0.999);
      }
    }
    return { scores, errors: new Map<string, string>(), calls: res.calls, warnings };
  }
}
