import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Where the opt-in disk cache may live: never inside a git work tree
 * (cached judgments of source code must not be committed) and created user-only (0700; on
 * Windows the user profile ACL applies). Returns null and a warning when refused.
 */
export class CacheDirPolicy {
  static check(dir: string | null): { dir: string | null; warning: string | null } {
    if (!dir) return { dir: null, warning: null };
    const abs = resolve(dir);
    const repo = CacheDirPolicy.repoRoot(abs);
    if (repo) return { dir: null, warning: "JEV_CACHE_DIR is inside a git repository; disk cache disabled. Use a directory outside any repo." };
    try {
      mkdirSync(abs, { recursive: true, mode: 0o700 });
    } catch {
      return { dir: null, warning: "JEV_CACHE_DIR cannot be created; disk cache disabled." };
    }
    return { dir: abs, warning: null };
  }

  /** Nearest ancestor holding `.git`, or null. */
  static repoRoot(start: string): string | null {
    let current = start;
    for (;;) {
      if (existsSync(join(current, ".git"))) return current;
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}
