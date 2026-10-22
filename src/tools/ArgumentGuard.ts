import { DEFAULT_CREDENTIAL_ARG_NAMES, DEFAULT_IGNORED_ARG_NAMES } from "../config/prompts.js";
import { EntryWalker } from "../core/EntryWalker.js";
import { JevError } from "../core/JevError.js";
import type { SecretGuard } from "../validation/SecretGuard.js";

const KEY_HINT = "The TypeSafe key is read from TYPESAFE_API_KEY or %USERPROFILE%\\.typesafe\\api-key.txt; nothing was sent.";

/**
 * Structural control: credentials are never accepted as tool arguments.
 * - an argument NAMED like a credential (`api_key`, `token`, `password`, `authorization`, ...)
 *   is refused, at the top level and inside recipe `args`;
 * - a control argument (preset, rank_by, output_path, ...) whose VALUE holds a secret is
 *   refused. Content arguments (state, questions, items, ...) are not refused here: the
 *   request pipeline masks secrets in them;
 * - an argument the tool does not declare is refused (round 5: strict schemas), after the
 *   credential NAME checks, so a credential-named argument still gets the credential error,
 *   and before any value is walked (an undeclared value is never read).
 * Messages name the argument but never quote its value.
 */
export class ArgumentGuard {
  private readonly names: Set<string>;

  constructor(
    private readonly secrets: SecretGuard,
    names: string[] = DEFAULT_CREDENTIAL_ARG_NAMES,
    /** Guard-override names dropped without effect (see DEFAULT_IGNORED_ARG_NAMES). */
    private readonly ignored: readonly string[] = DEFAULT_IGNORED_ARG_NAMES,
  ) {
    this.names = new Set(names.map(ArgumentGuard.normalize));
  }

  /**
   * Throws `invalid_input` for a credential argument or an undeclared one; `content` lists the
   * content arguments, `declared` every argument the tool accepts.
   */
  check(args: unknown, content: ReadonlySet<string>, declared: readonly string[]): void {
    if (typeof args !== "object" || args === null) return;
    for (const name of Object.keys(args)) {
      if (this.names.has(ArgumentGuard.normalize(name))) throw this.named(name);
      if (this.holdsSecret(name)) throw this.valued(name);
    }
    const recipeArgs = (args as Record<string, unknown>).args;
    if (typeof recipeArgs === "object" && recipeArgs !== null && !Array.isArray(recipeArgs)) {
      for (const name of Object.keys(recipeArgs)) if (this.names.has(ArgumentGuard.normalize(name))) throw this.named(`args.${name}`);
    }
    const unknown = Object.keys(args).filter((name) => !declared.includes(name) && !this.ignored.includes(name));
    if (unknown.length > 0) throw JevError.invalid(this.unknownMessage(unknown, declared), undefined, `Remove it and call again. Accepted: ${declared.join(", ")}.`);
    // Values last: an undeclared argument is refused above by its name, before its value is
    // walked (break hunt 1: a 20,000-deep undeclared value overflowed the stack first).
    for (const [name, value] of Object.entries(args)) if (!content.has(name) && this.holdsSecret(value)) throw this.valued(name);
  }

  /** Refuses a control value that holds a secret (the batch writer's final file name, bug r5). */
  checkValue(name: string, value: unknown): void {
    if (this.holdsSecret(value)) throw this.valued(name);
  }

  /**
   * The message for undeclared arguments (also the strict MCP schema's error): the credential
   * message when one of them is credential-named, else one that names each argument.
   */
  unknownMessage(names: readonly string[], declared: readonly string[]): string {
    const credential = names.find((n) => this.names.has(ArgumentGuard.normalize(n)));
    if (credential !== undefined) return this.named(credential).message;
    const shown = names.map((n) => (this.holdsSecret(n) ? "(a name that holds a secret)" : `"${n}"`)).join(", ");
    return `Unknown argument${names.length > 1 ? "s" : ""}: ${shown}. Accepted: ${declared.join(", ")}.`;
  }

  private holdsSecret(value: unknown): boolean {
    let hit = false;
    EntryWalker.forEachStringOrKey(value, (s) => {
      if (!hit && this.secrets.findings(s).length > 0) hit = true;
    });
    return hit;
  }

  private named(name: string): JevError {
    const shown = this.printable(name);
    return JevError.invalid(`${shown} is a credential name: jev-mcp never accepts credentials as tool arguments.`, undefined, `Remove ${shown} and call again. ${KEY_HINT}`);
  }

  private valued(name: string): JevError {
    const shown = this.printable(name);
    return JevError.invalid(`${shown} holds a credential or secret: jev-mcp never accepts credentials as tool arguments.`, undefined, `Remove the credential from ${shown} and call again. ${KEY_HINT}`);
  }

  /** `Argument "name"`, or a generic label when the name itself holds a secret. */
  private printable(name: string): string {
    return this.holdsSecret(name) ? "An argument" : `Argument "${name}"`;
  }

  private static normalize(name: string): string {
    return name.toLowerCase().replace(/[_-]/g, "");
  }
}
