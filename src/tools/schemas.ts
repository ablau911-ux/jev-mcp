import { z } from "zod";
import { JevError } from "../core/JevError.js";
import { ModelRegistry } from "../models/ModelRegistry.js";

/** Any JSON value. Deep rules (nesting, finite numbers, secrets) are checked on the server. */
export const entry = z.any();

export const QUESTION_HELP =
  'Question = {type:"noul", instructions, criteria?:{true?,false?}} | {type:"choice", instructions?, criteria:{label: description|null} (1-255)} | {type:"score", instructions?, criteria:[level0..levelN] (2-10, describe situations)} | {type:"box", instructions} (images only). Point at state fields with backticked paths like `diff.text`.';

export const stateSchema = entry.describe(
  'What the questions are about: a string, or an object/array with named fields. Refs are expanded on the server, never paste files: "$file:src/a.ts#L10-80", "$diff" (uncommitted) / "$diff:staged" / "$diff:<ref>", "$log:test.log". Name untrusted fields untrusted_*.',
);

export const questionSchema = z
  .object({
    type: z.enum(["noul", "choice", "score", "box"]),
    instructions: entry.optional(),
    criteria: entry.optional(),
  })
  .describe(QUESTION_HELP);

/**
 * `__proto__` cannot name a question: JSON.parse keeps it as an own key, but zod records and
 * plain-object writes drop it, so the question was silently never asked (break hunt 1). It is
 * refused instead: by the MCP input schema and by the tools' run() (in-process calls).
 */
const RESERVED_QUESTION_NAMES: readonly string[] = ["__proto__"];

function reservedQuestionName(questions: unknown): string | undefined {
  if (typeof questions !== "object" || questions === null) return undefined;
  return RESERVED_QUESTION_NAMES.find((name) => Object.hasOwn(questions, name));
}

/** Throws invalid_input when `questions` uses a reserved name (see RESERVED_QUESTION_NAMES). */
export function refuseReservedNames(questions: unknown, where: string): void {
  const name = reservedQuestionName(questions);
  if (name !== undefined) throw JevError.invalid(`${where}: "${name}" cannot be a question name.`, undefined, "Rename the question and call again; nothing was sent.", where);
}

const QUESTIONS_HELP = "Questions by unique name (names are never shown to the model). Put every question about this state in one call.";

export const questionsSchema = z
  .preprocess((value, ctx) => {
    const name = reservedQuestionName(value);
    if (name !== undefined) ctx.addIssue({ code: "custom", message: `"${name}" cannot be a question name.` });
    return value;
  }, z.record(z.string(), questionSchema).describe(QUESTIONS_HELP))
  .describe(QUESTIONS_HELP);

export const imageSpecSchema = z.object({
  path: z.string().optional().describe("PNG/JPEG file path inside the workspace."),
  data_base64: z.string().optional().describe("Base64 image bytes (no data: prefix)."),
  format: z.enum(["png", "jpg", "jpeg"]).optional(),
});

export const imagesSchema = z
  .record(z.string(), imageSpecSchema)
  .describe('Images by placeholder like "<shot>", written inside a state string. Off unless the user set JEV_IMAGES=1.');

/**
 * The `{error}` of a failed call (JevErrorJson). Declared in every tool's outputSchema: a strict
 * MCP client validates structuredContent even when isError is set, so an undeclared `error`
 * made the client throw and the agent never saw kind / fix (break hunt 1).
 */
export const errorOutputSchema = z
  .looseObject({ kind: z.string(), message: z.string(), fix: z.string(), retryable: z.boolean() })
  .describe("Only on a failed call (isError): kind, message, fix, retryable, plus cause / loc / status / request_id when known.");

export const presetSchema = z.string().describe("Decision preset: gate (default) | triage | review_filter | strict. Thresholds live in config.");

export const commonCallShape = {
  cache: z.boolean().optional().describe("Use the response cache (default true)."),
};

export const longContextSchema = z
  .union([z.boolean(), z.literal("auto")])
  .optional()
  .describe('Long-context header (262k tokens, slower, less accurate). "auto" uses it only when over the 64k/32k limits.');

/**
 * The raw-questions part of a jev_ask input (jev_ask adds recipe + args). jev_status validate
 * parses its request with this same shape, so it accepts and refuses what jev_ask does.
 */
export const askInputShape = {
  state: stateSchema.optional(),
  questions: questionsSchema.optional(),
  preset: presetSchema.optional(),
  detail: z.boolean().optional().describe("Add probabilities and routing reasons (more tokens)."),
  images: imagesSchema.optional(),
  long_context: longContextSchema,
  ...commonCallShape,
};

const ASK_REQUEST = z.strictObject(askInputShape);

/**
 * Parses a jev_ask input (raw questions) the way jev_ask does, for jev_status validate (break
 * hunt 1: validate refused preset / detail / cache, and a null question or image spec reached
 * the preparer and failed internal). Like jev_ask without a recipe, state and questions are
 * required.
 */
export function parseAskRequest(request: Record<string, unknown>) {
  const parsed = ASK_REQUEST.safeParse(request);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => `$.${i.path.map(String).join(".")}: ${i.message}`);
    throw JevError.invalid(errors[0] ?? "Invalid request.", errors, "Fix the request the way jev_ask expects it; nothing was sent.");
  }
  const missing = (["state", "questions"] as const).find((k) => parsed.data[k] === undefined);
  if (missing) throw JevError.invalid(`$.request.${missing}: required (a jev_ask input has state and questions).`, undefined, "Pass request: {state, questions} (a jev_ask input); nothing is sent.", `$.${missing}`);
  return parsed.data;
}

/**
 * Model pins change only through config `models.override`: a `model` argument is
 * refused (invalid_input, value never quoted) instead of being silently ignored.
 */
export function refuseModelArg(args: unknown): void {
  if (typeof args === "object" && args !== null && (args as Record<string, unknown>).model !== undefined) throw ModelRegistry.pinned();
}
