import type { JevConfig } from "../config/types.js";
import { EntryWalker } from "./EntryWalker.js";
import type { Entry, Questions, RawAnswer } from "./types.js";

export const PROBE_PREFIX = "jev_injection_probe_";
const MAX_PROBES = 3;
const ESCAPED_LT = String.fromCharCode(0x2039);

export interface InjectionPlan {
  /** Untrusted top-level state fields (`untrusted_*`), or `state` for untrusted refs. */
  fields: string[];
  probes: Questions;
  state: Entry;
}

/**
 * Prompt-injection defenses (effect unmeasured). State fields named
 * `untrusted_*` and content from `$log` or outside the workspace are untrusted:
 * - a probe Noul per untrusted field runs in the same request (questions are independent,
 *   so it costs only its own tokens) and only when untrusted content is present;
 * - image placeholder literals inside untrusted fields are escaped, so text cannot pull an
 *   image into a place the agent did not put it;
 * - DecisionPolicy caps decisions at `confirm` whenever untrusted content is present.
 */
export class InjectionGuard {
  constructor(
    private readonly config: JevConfig["injection"],
    private readonly probePrompt: string,
  ) {}

  plan(state: Entry, untrustedRefs: boolean, imageNames: string[]): InjectionPlan {
    const fields = this.untrustedFields(state);
    if (untrustedRefs && fields.length === 0) fields.push("state");
    const escaped = this.escape(state, fields, imageNames);
    return { fields, probes: this.probes(fields), state: escaped };
  }

  /**
   * Highest probe probability, and the answers without the probes. Only the probe ids `plan`
   * generated for this request count: a caller's own question named `jev_injection_probe_*`
   * stays an ordinary answer.
   */
  static split(answers: Record<string, RawAnswer>, probeIds: readonly string[]): { answers: Record<string, RawAnswer>; probeP: number | null } {
    let probeP: number | null = null;
    const rest: Record<string, RawAnswer> = {};
    for (const [id, a] of Object.entries(answers)) {
      if (probeIds.includes(id) && a.type === "noul") probeP = Math.max(probeP ?? 0, a.noul);
      else rest[id] = a;
    }
    return { answers: rest, probeP };
  }

  private untrustedFields(state: Entry): string[] {
    if (typeof state !== "object" || state === null || Array.isArray(state)) return [];
    return Object.keys(state).filter((k) => k.startsWith(this.config.untrustedPrefix));
  }

  private probes(fields: string[]): Questions {
    if (!this.config.probe) return {};
    const out: Questions = {};
    fields.slice(0, MAX_PROBES).forEach((field, i) => {
      out[`${PROBE_PREFIX}${i}`] = { type: "noul", instructions: this.probePrompt.replace("{field}", field) };
    });
    return out;
  }

  private escape(state: Entry, fields: string[], names: string[]): Entry {
    if (names.length === 0 || fields.length === 0) return state;
    const esc = (s: string) => names.reduce((t, n) => t.split(n).join(ESCAPED_LT + n.slice(1)), s);
    if (fields.includes("state") || typeof state !== "object" || state === null || Array.isArray(state)) return EntryWalker.mapStrings(state, esc);
    const out: Record<string, Entry> = { ...state };
    for (const f of fields) if (out[f] !== undefined) out[f] = EntryWalker.mapStrings(out[f] as Entry, esc);
    return out;
  }
}
