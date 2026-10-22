import { realpath, stat, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { JevError } from "../core/JevError.js";

export type RootsProvider = () => Promise<string[]>;

/**
 * Restricts file access to allowed roots (MCP client roots, the working directory and
 * configured extra roots) and refuses credential files:
 * - `..` traversal and symlink escapes are caught by comparing real paths;
 * - the credential denylist is matched on the real path, so a symlink to `~/.ssh/id_rsa`
 *   is refused too;
 * - refusals are silent: a credential path gets the same "not available" error as a missing
 *   file, and no error ever echoes the allowed roots.
 */
export class PathGuard {
  private readonly deny: RegExp[];

  constructor(
    private readonly roots: RootsProvider,
    /** Per-file byte limit: a whole file, a line range or a log tail. */
    readonly maxBytes: number,
    denylist: string[] = [],
  ) {
    this.deny = denylist.map((p) => new RegExp(p, "i"));
  }

  /** True when a path (any separator) matches the credential denylist. */
  isCredential(path: string): boolean {
    const normalized = path.replace(/\\/g, "/");
    return this.deny.some((re) => re.test(normalized));
  }

  /** Resolves `path` to a real path inside a root, or throws a generic `invalid_input`. */
  async resolveInside(path: string): Promise<string> {
    const roots = await this.realRoots();
    const candidate = isAbsolute(path) ? path : resolve(roots[0] ?? process.cwd(), path);
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      throw PathGuard.unavailable(path);
    }
    if (this.isCredential(candidate) || this.isCredential(real)) throw PathGuard.unavailable(path);
    if (!roots.some((root) => this.isInside(root, real))) {
      throw JevError.invalid(`File ${path} is outside the allowed roots.`, undefined, "Use a path inside the working directory or the client's MCP roots.");
    }
    return real;
  }

  /** The first allowed root (working directory for git and relative paths). */
  async primaryRoot(): Promise<string> {
    return (await this.realRoots())[0] ?? process.cwd();
  }

  /** Real path and size of a regular file inside a root (no content read). */
  async stat(path: string): Promise<{ real: string; size: number }> {
    const real = await this.resolveInside(path);
    const info = await stat(real);
    if (!info.isFile()) throw JevError.invalid(`Not a regular file: ${path}`);
    return { real, size: info.size };
  }

  /** Reads a file inside a root, enforcing the byte limit (`limit` overrides the default). */
  async readBytes(path: string, limit = this.maxBytes): Promise<Buffer> {
    const { real, size } = await this.stat(path);
    if (size > limit) throw JevError.invalid(`File ${path} is ${size} bytes; the limit is ${limit}.`, undefined, "Pass a line range ($file:path#L10-80) or a smaller file.");
    return readFile(real);
  }

  /** Resolves a path to write (the file may not exist yet; its directory must be inside a root). */
  async resolveForWrite(path: string): Promise<string> {
    const roots = await this.realRoots();
    const candidate = isAbsolute(path) ? path : resolve(roots[0] ?? process.cwd(), path);
    let dir: string;
    try {
      dir = await realpath(dirname(candidate));
    } catch {
      throw JevError.invalid(`Directory for ${path} does not exist.`);
    }
    const target = join(dir, basename(candidate));
    if (this.isCredential(target) || !roots.some((root) => this.isInside(root, target))) {
      throw JevError.invalid(`Output path ${path} is not allowed.`, undefined, "Write inside the working directory.");
    }
    return target;
  }

  /** True when `target` is inside one of the allowed roots (no I/O on the target). */
  async isAllowed(target: string): Promise<boolean> {
    const roots = await this.realRoots();
    return roots.some((root) => this.isInside(root, resolve(target)));
  }

  private static unavailable(path: string): JevError {
    return JevError.invalid(`File not available: ${path}`, undefined, "Check the path; it must be an existing, readable file inside the workspace.");
  }

  private isInside(root: string, target: string): boolean {
    const rel = relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }

  private async realRoots(): Promise<string[]> {
    const out: string[] = [];
    for (const root of await this.roots()) {
      try {
        out.push(await realpath(root));
      } catch {
        // Missing roots are ignored.
      }
    }
    return out;
  }
}
