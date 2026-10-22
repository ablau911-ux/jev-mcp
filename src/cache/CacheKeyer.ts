import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EntryWalker } from "../core/EntryWalker.js";

export interface CacheKeyParts {
  namespace: string;
  state: unknown;
  questions: unknown;
  imageHashes: Record<string, string>;
  longContext: boolean;
}

/**
 * Cache keys as HMAC-SHA256 with a per-install secret: a bare SHA-256
 * lets anyone holding a candidate file confirm it was judged. The secret lives in
 * `%USERPROFILE%\.typesafe\jev-cache-secret` (created 0600); without a path it is random per
 * process. The key never includes the API key.
 */
export class CacheKeyer {
  private readonly secret: Buffer;

  constructor(secretPath: string | null) {
    this.secret = secretPath ? CacheKeyer.loadOrCreate(secretPath) : randomBytes(32);
  }

  key(parts: CacheKeyParts): string {
    return `${parts.namespace}:${createHmac("sha256", this.secret).update(EntryWalker.canonical(parts)).digest("hex")}`;
  }

  static loadOrCreate(path: string): Buffer {
    try {
      const hex = readFileSync(path, "utf8").trim();
      if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, "hex");
    } catch {
      // Created below.
    }
    const secret = randomBytes(32);
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, secret.toString("hex"), { mode: 0o600 });
    } catch {
      // Unwritable home: the in-memory secret still works for this process.
    }
    return secret;
  }
}
