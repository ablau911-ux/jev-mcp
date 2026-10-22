import { z } from "zod";
import type { BatchRunner } from "../core/BatchRunner.js";
import { fill } from "../core/ChoiceChunker.js";
import { JevError } from "../core/JevError.js";
import type { JevService } from "../core/JevService.js";
import type { CallResult, Questions } from "../core/types.js";
import { answerOf, sumUsage, warningsOf } from "./helpers.js";
import { Recipe, type RecipeContext } from "./Recipe.js";
import { commonCallShape } from "../tools/schemas.js";

const shape = {
  text: z.string().optional().describe("Text to search (give text or file)."),
  file: z
    .object({ path: z.string(), start_line: z.number().int().positive().optional(), end_line: z.number().int().positive().optional() })
    .optional()
    .describe("File to search, inside the allowed roots (max 1 MiB)."),
  description: z.string().min(1).describe('What to find, e.g. "where the retry limit is configured".'),
  window: z.number().int().min(2).max(255).optional().describe("Lines per request (default 200; Choice max 255)."),
  found_at: z.number().min(0).max(1).optional().describe("exists >= this means found (default 0.7, cookbook value)."),
  absent_at: z.number().min(0).max(1).optional().describe("exists < this means absent (default 0.35, cookbook value)."),
  top: z.number().int().min(1).max(20).optional().describe("Lines to return (default 5)."),
  concurrency: z.number().int().min(1).max(64).optional(),
  ...commonCallShape,
};

type Args = z.infer<z.ZodObject<typeof shape>>;

/** Line ends: \r\n, \r (classic Mac) or \n, the same rule as the $file line index. */
const LINE_END = /\r\n|\r|\n/;

interface Window {
  start: number;
  lines: string[];
}

/** Splits lines into overlapping windows. */
export function makeWindows(lines: string[], size: number, overlap: number): Window[] {
  const step = Math.max(1, size - Math.min(overlap, size - 1));
  const out: Window[] = [];
  for (let start = 0; start < lines.length; start += step) {
    out.push({ start, lines: lines.slice(start, start + size) });
    if (start + size >= lines.length) break;
  }
  return out;
}

/** jev_find_lines (P1): semantic line search (`/cookbooks/semantic_find.md`). */
export class FindLinesRecipe extends Recipe<typeof shape> {
  readonly name = "find_lines";
  readonly summary =
    "Semantic grep: which lines of a file match a description (L000 tags, one Choice + exists Noul per window). Use real grep first when a pattern exists.";
  readonly example = { file: { path: "src/server.ts" }, description: "where the retry limit is configured" };
  readonly schema = shape;

  constructor(
    private readonly service: JevService,
    private readonly batch: BatchRunner,
  ) {
    super();
  }

  async run(args: Args, ctx: RecipeContext): Promise<object> {
    const { lines, offset } = await this.load(args);
    const cfg = this.service.config.findLines;
    const windows = makeWindows(lines, args.window ?? cfg.window, cfg.overlap);
    this.checkCeiling(windows.length);
    const width = Math.max(3, String(lines.length - 1).length);
    const tag = (i: number) => `L${String(i).padStart(width, "0")}`;
    const warnings: string[] = [];
    const gate = this.batch.createGate(args.concurrency, warnings);
    const calls = await this.batch.map(windows, gate.concurrency, (w) =>
      this.service.execute(
        { state: w.lines.map((l, i) => `${tag(w.start + i)}| ${l}`).join("\n"), questions: this.questions(args, w, tag), cache: args.cache },
        { tool: this.tool, signal: ctx.signal, gate, retryProfile: "batch" },
      ),
    );
    return this.output(args, windows, calls, lines, offset, tag, warnings);
  }

  /** One request per window: refuse before sending anything when the call would exceed its ceiling or the per-minute budget. */
  private checkCeiling(count: number): void {
    const max = Math.min(this.service.config.findLines.maxWindows, this.service.config.session.requestsPerMinute);
    if (count > max) {
      throw JevError.invalid(`${count} windows exceed the find_lines ceiling of ${max} requests; nothing was sent.`, undefined, "Narrow with file.start_line/end_line, raise window (max 255), or grep first.", "$.args");
    }
  }

  private async load(args: Args): Promise<{ lines: string[]; offset: number }> {
    if ((args.text === undefined) === (args.file === undefined)) throw JevError.invalid("Give exactly one of text or file.");
    let text = args.text ?? "";
    let offset = 0;
    if (args.file) {
      text = await this.service.refs.readText(args.file.path);
      const all = text.split(LINE_END);
      const start = (args.file.start_line ?? 1) - 1;
      const end = args.file.end_line ?? all.length;
      offset = start;
      text = all.slice(start, end).join("\n");
    }
    const lines = text.split(LINE_END);
    if (lines.length === 0 || text.length === 0) throw JevError.invalid("Nothing to search: the text is empty.");
    return { lines, offset };
  }

  private questions(args: Args, w: Window, tag: (i: number) => string): Questions {
    const p = this.service.config.prompts;
    return {
      where: { type: "choice", instructions: fill(p.findWhere, { query: args.description }), criteria: Object.fromEntries(w.lines.map((_, i) => [tag(w.start + i), null])) },
      exists: { type: "noul", instructions: fill(p.findExists, { query: args.description }), criteria: { true: p.findExistsTrue, false: p.findExistsFalse } },
    };
  }

  private output(args: Args, windows: Window[], calls: CallResult[], lines: string[], offset: number, tag: (i: number) => string, warnings: string[]): object {
    const cfg = this.service.config.findLines;
    const exists = calls.map((c) => answerOf(c, "exists", "noul").noul);
    const best = exists.indexOf(Math.max(...exists));
    const bestCall = calls[best];
    const bestWindow = windows[best];
    const probs = bestCall ? answerOf(bestCall, "where", "choice").probabilities : {};
    const index = new Map((bestWindow?.lines ?? []).map((_, i) => [tag((bestWindow?.start ?? 0) + i), (bestWindow?.start ?? 0) + i]));
    // A label outside the window is not a line of this text: drop it, never map it to a line.
    const known = Object.entries(probs).filter(([t]) => index.has(t));
    if (known.length < Object.keys(probs).length) warnings.push(`${Object.keys(probs).length - known.length} answer label(s) not in the window were dropped.`);
    const top = known.sort((a, b) => b[1] - a[1]).slice(0, args.top ?? 5);
    const e = exists[best] ?? 0;
    const foundAt = args.found_at ?? cfg.foundAt;
    const absentAt = args.absent_at ?? cfg.absentAt;
    return {
      verdict: e >= foundAt ? "found" : e < absentAt ? "absent" : "partial",
      exists: e,
      lines: top.map(([t, p]) => {
        const i = index.get(t) as number;
        return { line: offset + i + 1, tag: t, p, text: lines[i] ?? "" };
      }),
      windows: windows.map((w, i) => ({ start_line: offset + w.start + 1, end_line: offset + w.start + w.lines.length, exists: exists[i] })),
      model: calls[0]?.model ?? null,
      usage: sumUsage(calls),
      warnings: warningsOf(calls, warnings),
    };
  }
}
