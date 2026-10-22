import { JevError } from "./JevError.js";
import { QuestionSet } from "./QuestionSet.js";
import type { AskInput, CallContext, JevService } from "./JevService.js";
import type { CallResult, Entry, ImageSpec, Questions, RawAnswer } from "./types.js";

export interface ChunkedChoiceInput {
  state: Entry;
  options: Record<string, Entry>;
  instructions?: Entry;
  extraQuestions?: Questions;
  images?: Record<string, ImageSpec>;
  model?: string;
  cache?: boolean;
}

export interface ChunkedChoiceResult {
  answer: Extract<RawAnswer, { type: "choice" }>;
  extra: Record<string, RawAnswer>;
  calls: CallResult[];
  round1?: Record<string, string>;
}

/** Fills `{name}` placeholders in a config template. */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

/**
 * One Choice over many options. Up to `chunkSize` options it is a single question; above,
 * round 1 asks one Choice per chunk in a single request and round 2 asks a Choice over the
 * chunk winners (`/cookbooks/skill_suggestion.md`).
 */
export class ChoiceChunker {
  constructor(
    private readonly service: JevService,
    private readonly chunkSize: number,
  ) {}

  static chunks<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  }

  async run(input: ChunkedChoiceInput, ctx: CallContext): Promise<ChunkedChoiceResult> {
    const labels = Object.keys(input.options);
    if (labels.length <= this.chunkSize) {
      const call = await this.ask(input, { main: this.question(input, input.options) }, ctx, true);
      return { answer: this.choiceOf(call, "main"), extra: this.rest(call, "main"), calls: [call] };
    }
    const groups = ChoiceChunker.chunks(labels, this.chunkSize);
    const round1Questions: Questions = {};
    groups.forEach((g, i) => {
      round1Questions[`chunk_${i}`] = this.question(input, Object.fromEntries(g.map((l) => [l, input.options[l] ?? null])));
    });
    const first = await this.ask(input, round1Questions, ctx, true);
    const winners = groups.map((_, i) => this.choiceOf(first, `chunk_${i}`).choice);
    const finalOptions = Object.fromEntries(winners.map((l) => [l, input.options[l] ?? null]));
    const second = await this.ask(input, { main: this.question(input, finalOptions) }, ctx, false);
    const round1 = Object.fromEntries(winners.map((w, i) => [`chunk_${i}`, w]));
    return { answer: this.choiceOf(second, "main"), extra: this.rest(first, ""), calls: [first, second], round1 };
  }

  private question(input: ChunkedChoiceInput, criteria: Record<string, Entry>) {
    const q: Questions[string] = { type: "choice", criteria };
    if (input.instructions !== undefined) q.instructions = input.instructions;
    return q;
  }

  private ask(input: ChunkedChoiceInput, questions: Questions, ctx: CallContext, withExtra: boolean): Promise<CallResult> {
    const ask: AskInput = {
      state: input.state,
      questions: withExtra ? QuestionSet.merge(questions, input.extraQuestions ?? {}) : questions,
      images: input.images,
      model: input.model,
      cache: input.cache,
    };
    return this.service.execute(ask, ctx);
  }

  private choiceOf(call: CallResult, id: string): Extract<RawAnswer, { type: "choice" }> {
    const a = call.answers[id];
    if (!a || a.type !== "choice") {
      throw new JevError({ kind: "bad_response", message: `Response lacks choice answer ${id}.`, fix: "Retry.", requestId: call.request_id });
    }
    return a;
  }

  private rest(call: CallResult, skip: string): Record<string, RawAnswer> {
    return Object.fromEntries(Object.entries(call.answers).filter(([k]) => k !== skip && !k.startsWith("chunk_")));
  }
}
