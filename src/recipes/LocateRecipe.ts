import { z } from "zod";
import { AnswerDeriver } from "../core/AnswerDeriver.js";
import { fill } from "../core/ChoiceChunker.js";
import type { JevService } from "../core/JevService.js";
import type { ImageSpec, Questions } from "../core/types.js";
import { answerOf, sumUsage } from "./helpers.js";
import { Recipe, type RecipeContext } from "./Recipe.js";
import { commonCallShape, imageSpecSchema } from "../tools/schemas.js";

const shape = {
  image: imageSpecSchema.describe("The image to search (PNG/JPEG, 280-1568 px per side)."),
  target: z.string().min(1).describe('What to find, e.g. "the Save button" or "the red warning icon". One target per call.'),
  presence_check: z.boolean().optional().describe("Also ask a Noul whether the target is present (default true): Box always returns a box, even when the target is absent."),
  pad: z.number().min(0).max(0.5).optional().describe("Fraction of the image to add on each side (default 0)."),
  clamp: z.boolean().optional().describe("Clamp the padded box to 0..1 (default true)."),
  ...commonCallShape,
};

type Args = z.infer<z.ZodObject<typeof shape>>;

const IMAGE_NAME = "<image>";

/** locate: Box on one image with a presence Noul, on the locate model (jev-1.14.0), behind JEV_IMAGES. */
export class LocateRecipe extends Recipe<typeof shape> {
  readonly name = "locate";
  readonly summary =
    "Box + presence Noul on one image (jev-1.14.0). Off unless the user set JEV_IMAGES=1; experimental.";
  readonly example = { image: { path: "shot.png" }, target: "the Save button" };
  readonly schema = shape;

  constructor(private readonly service: JevService) {
    super();
  }

  async run(args: Args, ctx: RecipeContext): Promise<object> {
    const p = this.service.config.prompts;
    const questions: Questions = { box: { type: "box", instructions: fill(p.locateBox, { target: args.target }) } };
    const presence = args.presence_check !== false;
    if (presence) questions.present = { type: "noul", instructions: fill(p.locatePresence, { target: args.target }) };
    const call = await this.service.execute(
      {
        state: { image: IMAGE_NAME },
        questions,
        images: { [IMAGE_NAME]: args.image as ImageSpec },
        feature: "locate",
        cache: args.cache,
      },
      { tool: this.tool, signal: ctx.signal },
    );
    const box = answerOf(call, "box", "box");
    const padded = AnswerDeriver.pad(box.box, args.pad ?? 0, args.clamp !== false);
    const image = call.images[0];
    const presentP = presence ? answerOf(call, "present", "noul").noul : null;
    // Box always returns a box; null confidence or a likely-absent target means review.
    const decision = box.confidence === null || (presentP !== null && presentP < 0.5) ? "review" : "confirm";
    return {
      decision,
      present_probability: presentP,
      box: padded,
      pixel_box: image ? AnswerDeriver.toPixels(padded, image) : null,
      confidence: box.confidence,
      model: call.model,
      usage: sumUsage([call]),
      warnings: ["Box is experimental (Dreamer-ready), not production-recommended.", ...call.warnings],
    };
  }
}
