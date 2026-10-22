import { Calibrator } from "../calibration/Calibrator.js";
import type { DecisionLog } from "../calibration/DecisionLog.js";
import type { GitSeeder } from "../calibration/GitSeeder.js";
import type { JevConfig } from "../config/types.js";
import { JevError } from "../core/JevError.js";

/**
 * Feedback and calibration for jev_status: `feedback` stores a label for
 * a decision id; `calibrate` fits a threshold per (preset, metric) group once it has enough
 * labelled records to reach the target precision (Calibrator.need, 50 by default), and can first seed an eval list from git history. Fitted values are reported,
 * never applied automatically: the user copies them into jev-config.json with `tuned_on`.
 */
export class CalibrationService {
  private readonly calibrator: Calibrator;

  constructor(
    private readonly log: DecisionLog,
    private readonly seeder: GitSeeder,
    config: JevConfig,
  ) {
    this.calibrator = new Calibrator(config.calibration);
  }

  feedback(id: string | undefined, label: boolean | undefined): object {
    if (!id || label === undefined) throw JevError.invalid("feedback needs id and label.", undefined, 'Example: {action:"feedback", id:"3fa2c1d9e8b7.q", label:true}', "$.id");
    const ids = this.targets(id);
    if (ids.length === 0) throw JevError.invalid(`No decision with id ${id}.`, undefined, "Use the id from a jev_ask/jev_batch result, plus .<question> for one question.", "$.id");
    for (const one of ids) this.log.append({ type: "label", id: one, ts: new Date().toISOString(), label, source: "agent" });
    return { labelled: ids.length };
  }

  /**
   * An exact decision id labels that one decision (question names may contain '.', so `<call>.a`
   * is also a prefix of `<call>.a.b`); an id that names no decision labels every `<id>.*` one.
   */
  private targets(id: string): string[] {
    if (this.log.decision(id)) return [id];
    return this.log.decisions().flatMap((d) => (d.id.startsWith(`${id}.`) ? [d.id] : []));
  }

  async calibrate(preset: string | undefined, seedGit: boolean, cwd: string): Promise<object> {
    const seed = seedGit ? await this.seeder.seed(cwd) : undefined;
    const groups = new Map<string, Array<{ p: number; label: boolean; source: string }>>();
    for (const r of this.log.labelled()) {
      if (r.p === null || (preset && r.preset !== preset)) continue;
      const key = `${r.preset}/${r.metric}`;
      const list = groups.get(key) ?? [];
      // A label says the verdict was right; a Noul fit needs "a yes at this p would be right",
      // so a right "no" counts as a wrong yes and a wrong "no" as a right yes.
      const label = r.metric === "noul_p" && r.verdict === "no" ? !r.label : r.label;
      list.push({ p: r.p, label, source: r.source });
      groups.set(key, list);
    }
    // Label sources per fit: proxy labels (rerun, hunk_edit, file_open, git_seed) are not yet
    // checked against agent labels, so the user sees what a fitted threshold rests on.
    const sources = (samples: Array<{ source: string }>) => samples.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.source]: (acc[s.source] ?? 0) + 1 }), {});
    const fits = Object.fromEntries([...groups].map(([k, samples]) => [k, { ...this.calibrator.fit(samples), label_sources: sources(samples) }]));
    const warnings = this.calibrator.warnings;
    return { fits, target_precision: this.calibrator.o.targetPrecision, min_records: this.calibrator.need(), ...(seed ? { git_seed: seed } : {}), ...(warnings.length ? { warnings } : {}), note: "Fitted thresholds are not applied automatically; copy them into jev-config.json presets with tuned_on." };
  }
}
