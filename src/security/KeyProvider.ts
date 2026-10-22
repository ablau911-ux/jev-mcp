import { readFileSync } from "node:fs";
import { join } from "node:path";
import { typesafeHome } from "../config/ConfigStore.js";
import { JevError } from "../core/JevError.js";
import type { Redactor } from "./Redactor.js";

/** Leading byte order mark (U+FEFF). */
const BOM_RE = new RegExp(`^${String.fromCharCode(0xfeff)}`);

export type KeySource = "env" | "file" | "missing";

type Env = Record<string, string | undefined>;
type ReadText = (path: string) => string;

const SETUP_HINT =
  "Set TYPESAFE_API_KEY, or put the key in %USERPROFILE%\\.typesafe\\api-key.txt. Create keys at https://console.typesafe.ai/keys.";

/**
 * Resolves the TypeSafe API key: TYPESAFE_API_KEY (non-empty after trim), else the key file.
 * The key goes only into the Authorization header. It is registered with the Redactor so any
 * accidental echo is scrubbed. It never appears in tool output, errors, logs or cache keys.
 */
export class KeyProvider {
  readonly keyFilePath: string;

  constructor(
    private readonly redactor: Redactor,
    private readonly env: Env = process.env,
    private readonly readText: ReadText = (p) => readFileSync(p, "utf8"),
    keyFilePath?: string,
  ) {
    this.keyFilePath = keyFilePath ?? join(typesafeHome(env), "api-key.txt");
  }

  /** Where a key would come from right now. Never returns the key itself. */
  source(): KeySource {
    if (this.fromEnv() !== undefined) return "env";
    return this.fromFile() !== undefined ? "file" : "missing";
  }

  /** Returns the validated key or throws `no_api_key` / `invalid_api_key`. */
  getKey(): string {
    const envKey = this.fromEnv();
    const key = envKey ?? this.fromFile();
    if (key === undefined) {
      throw new JevError({ kind: "no_api_key", message: "No TypeSafe API key found.", fix: SETUP_HINT });
    }
    this.validate(key, envKey !== undefined ? "TYPESAFE_API_KEY" : "the key file");
    this.redactor.addSecret(key);
    return key;
  }

  /** Registers the key with the Redactor when one is available; never throws. */
  prime(): void {
    try {
      this.getKey();
    } catch {
      // Missing or malformed keys surface later as structured errors.
    }
  }

  private fromEnv(): string | undefined {
    const raw = this.env.TYPESAFE_API_KEY;
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private fromFile(): string | undefined {
    let text: string;
    try {
      text = this.readText(this.keyFilePath);
    } catch {
      return undefined;
    }
    const trimmed = text.replace(BOM_RE, "").trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  /** Mirrors SDK key rules: no internal whitespace, no control characters, ASCII only. */
  private validate(key: string, where: string): void {
    let problem: string | null = null;
    if (/\s/.test(key)) problem = "contains whitespace";
    else if ([...key].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) problem = "contains control characters";
    else if (/[^\x20-\x7e]/.test(key)) problem = "contains non-ASCII characters";
    if (problem !== null) {
      throw new JevError({
        kind: "invalid_api_key",
        message: `The API key from ${where} is malformed: it ${problem}.`,
        fix: SETUP_HINT,
      });
    }
  }
}
