import { BatchItemSource } from "../batch/BatchItemSource.js";
import { BatchShaper } from "../batch/BatchShaper.js";
import { GitSeeder } from "../calibration/GitSeeder.js";
import { BatchRunner } from "../core/BatchRunner.js";
import { AnswerShaper } from "../output/AnswerShaper.js";
import { DecisionPolicy } from "../policy/DecisionPolicy.js";
import { ClassifyRecipe } from "../recipes/ClassifyRecipe.js";
import { DecideRecipe } from "../recipes/DecideRecipe.js";
import { FindLinesRecipe } from "../recipes/FindLinesRecipe.js";
import { LocateRecipe } from "../recipes/LocateRecipe.js";
import { RecipeRegistry } from "../recipes/RecipeRegistry.js";
import { RerankRecipe } from "../recipes/RerankRecipe.js";
import { SelfConsistencyRecipe } from "../recipes/SelfConsistencyRecipe.js";
import { VerifyClaimRecipe } from "../recipes/VerifyClaimRecipe.js";
import { CalibrationService } from "../status/CalibrationService.js";
import { HealthCheck } from "../status/HealthCheck.js";
import { ModelCatalog } from "../status/ModelCatalog.js";
import { ArgumentGuard } from "../tools/ArgumentGuard.js";
import { AskTool } from "../tools/AskTool.js";
import { BatchTool } from "../tools/BatchTool.js";
import type { JevTool } from "../tools/JevTool.js";
import { StatusTool } from "../tools/StatusTool.js";
import { execGit } from "../refs/DiffSource.js";
import type { JevApp } from "./JevApp.js";

/**
 * Builds the surface: exactly three tools — jev_ask, jev_batch, jev_status —
 * and the seven recipes reachable through jev_ask.
 */
export class Toolset {
  readonly recipes: RecipeRegistry;
  readonly tools: JevTool[];
  readonly health: HealthCheck;
  readonly batch: BatchRunner;
  /** Credential and strict-schema checks of tool arguments. */
  readonly argGuard: ArgumentGuard;

  constructor(app: JevApp) {
    const s = app.service;
    const policy = new DecisionPolicy(app.config);
    const shaper = new AnswerShaper(policy, app.decisions);
    this.batch = new BatchRunner(s);
    this.recipes = new RecipeRegistry([
      new ClassifyRecipe(s),
      new DecideRecipe(s, policy, shaper),
      new VerifyClaimRecipe(s),
      new RerankRecipe(s, this.batch, app.decisions),
      new SelfConsistencyRecipe(s),
      new FindLinesRecipe(s, this.batch),
      new LocateRecipe(s),
    ]);
    this.health = new HealthCheck(app.transport, app.keys, app.config);
    const git = app.options.git ?? execGit;
    const scrub = <T>(v: T): T => app.outbound.scrubValue(v);
    const argGuard = (this.argGuard = new ArgumentGuard(app.secrets));
    this.tools = [
      new AskTool(s, policy, shaper, this.recipes, argGuard, app.config.limits.questionsPerState),
      new BatchTool(this.batch, new BatchItemSource(app.refs, scrub), new BatchShaper(shaper), policy, app.labeler, app.guard, app.config.batch.topK, scrub, argGuard, app.config.limits.questionsPerState),
      new StatusTool({
        service: s, ledger: app.ledger, limiter: app.limiter, keys: app.keys, config: app.config, cache: app.cache, health: this.health,
        catalog: new ModelCatalog(s), calibration: new CalibrationService(app.decisions, new GitSeeder(git, app.decisions, app.config.refs.gitTimeoutMs), app.config),
        processGuard: app.processGuard, guard: app.guard, argGuard,
      }),
    ];
  }
}
