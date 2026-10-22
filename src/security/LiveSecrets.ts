import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Redactor } from "./Redactor.js";

type Env = Record<string, string | undefined>;
type ReadText = (path: string) => string;

/**
 * Registers secrets that live on this machine with the Redactor, so the secret guard masks
 * them in outbound text and the logger never prints them (project policy): the tea
 * CLI token(s) in `%LOCALAPPDATA%\tea\config.yml`. The TypeSafe key is registered by
 * KeyProvider. Values are read at runtime and never logged or returned.
 */
export class LiveSecrets {
  constructor(
    private readonly redactor: Redactor,
    private readonly env: Env = process.env,
    private readonly readText: ReadText = (p) => readFileSync(p, "utf8"),
  ) {}

  load(): number {
    const base = this.env.LOCALAPPDATA;
    if (!base) return 0;
    let text: string;
    try {
      text = this.readText(join(base, "tea", "config.yml"));
    } catch {
      return 0;
    }
    const tokens = LiveSecrets.teaTokens(text);
    for (const t of tokens) this.redactor.addSecret(t, "tea_token");
    return tokens.length;
  }

  /** `token: <value>` lines of a tea config (pure; exposed for tests). */
  static teaTokens(yaml: string): string[] {
    const out: string[] = [];
    for (const m of yaml.matchAll(/^\s*token:\s*["']?([^\s"'#]+)["']?\s*$/gm)) if (m[1]) out.push(m[1]);
    return out;
  }
}
