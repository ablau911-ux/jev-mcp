import type { JevService } from "../core/JevService.js";
import type { Entry, Questions } from "../core/types.js";
import { codeSamples, SIDE_EFFECT_OPTIONS, tokenSamples } from "./ProbeSamples.js";

export interface BiasResult {
  samples: number;
  calls: number;
  flip_rate: number;
  mean_p_first: number;
  mean_abs_delta: number;
  accuracy_order_a: number;
  accuracy_order_b: number;
}

export interface TokenRow {
  kind: string;
  chars: number;
  input_tokens: number;
  state_tokens: number;
  chars_per_token: number;
  chars4_over_actual: number;
}

export interface TokenResult {
  overhead_tokens: number;
  rows: TokenRow[];
  chars_per_token: Record<string, number>;
}

const MODEL = "jev-1.13.0";
const INSTRUCTIONS = "Which description fits `code` best?";
const TOKEN_Q: Questions = { q: { type: "noul", instructions: "Is `doc` empty?" } };

/**
 * The live probe (cut to two measurements): Choice
 * first-option bias on 50 code samples in both orders, and chars/token on code, JSON and
 * Hebrew. Sequential, uncached, pinned to jev-1.13.0. Each number sets a default.
 */
export class ProbeRunner {
  models = new Set<string>();

  constructor(private readonly service: JevService) {}

  async bias(): Promise<BiasResult> {
    const labels = Object.keys(SIDE_EFFECT_OPTIONS);
    const reversed = [...labels].reverse();
    let flips = 0, pFirst = 0, delta = 0, okA = 0, okB = 0, calls = 0;
    const samples = codeSamples();
    for (const s of samples) {
      const a = await this.choice(s.code, labels);
      const b = await this.choice(s.code, reversed);
      calls += 2;
      if (a.choice !== b.choice) flips++;
      pFirst += (a.probabilities[labels[0] ?? ""] ?? 0) + (b.probabilities[reversed[0] ?? ""] ?? 0);
      delta += Math.abs((a.probabilities.side_effects ?? 0) - (b.probabilities.side_effects ?? 0));
      if (a.choice === s.expected) okA++;
      if (b.choice === s.expected) okB++;
    }
    const n = samples.length;
    return { samples: n, calls, flip_rate: flips / n, mean_p_first: pFirst / (2 * n), mean_abs_delta: delta / n, accuracy_order_a: okA / n, accuracy_order_b: okB / n };
  }

  async tokens(): Promise<TokenResult> {
    const overhead = await this.inputTokens("");
    const rows: TokenRow[] = [];
    for (const s of tokenSamples()) {
      const tokens = await this.inputTokens(s.state as Entry);
      const stateTokens = Math.max(1, tokens - overhead);
      rows.push({ kind: s.kind, chars: s.chars, input_tokens: tokens, state_tokens: stateTokens, chars_per_token: s.chars / stateTokens, chars4_over_actual: s.chars / 4 / stateTokens });
    }
    return { overhead_tokens: overhead, rows, chars_per_token: ProbeRunner.factorPerKind(rows) };
  }

  /** Factor per kind from the largest sample (least overhead noise), rounded down to 0.1. */
  static factorPerKind(rows: TokenRow[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const kind of new Set(rows.map((r) => r.kind))) {
      const largest = rows.filter((r) => r.kind === kind).sort((a, b) => b.chars - a.chars)[0];
      if (largest) out[kind] = Math.floor(largest.chars_per_token * 10) / 10;
    }
    return out;
  }

  private async choice(code: string, order: string[]) {
    const criteria = Object.fromEntries(order.map((l) => [l, SIDE_EFFECT_OPTIONS[l] ?? null]));
    const r = await this.service.execute(
      { state: { code }, questions: { c: { type: "choice", instructions: INSTRUCTIONS, criteria } }, model: MODEL, cache: false },
      { tool: "probe" },
    );
    this.models.add(r.model);
    const a = r.answers.c;
    if (a?.type !== "choice") throw new Error("probe: missing choice answer");
    return a;
  }

  private async inputTokens(doc: Entry): Promise<number> {
    const r = await this.service.execute({ state: { doc }, questions: TOKEN_Q, model: MODEL, cache: false }, { tool: "probe" });
    this.models.add(r.model);
    return r.usage.input_tokens;
  }
}
