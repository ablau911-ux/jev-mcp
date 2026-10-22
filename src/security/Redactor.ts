import { FragmentIndex } from "./FragmentIndex.js";
import { JoinedText } from "./JoinedText.js";

const MASK = "[REDACTED]";

/** Shortest piece of a live secret that counts as a fragment; a quarter of the secret when longer. */
const MIN_FRAGMENT = 8;
/**
 * Floor of the fragment length for a short secret (8-15 characters, round 5): half the
 * secret, never below this. Six characters of a random secret (62^6 = 5.7e10 values) do not
 * turn up by chance in normal text, and every window of the secret must be found before a
 * request is refused, so ordinary text is not refused.
 */
const MIN_SHORT_FRAGMENT = 6;
/** `Bearer <value>`, with the `Authorization:` header key before it when there is one. */
const BEARER_RE = /(\bAuthorization["']?[ \t]*[:=][ \t]*["']?)?(Bearer\s+)([^\s"',]+)/gi;
/**
 * A plain prose word after `Bearer` (`Bearer tokens expire`, `Bearer authentication`): letters
 * only, shorter than a token (the guard's bearer_token needs 20+), sentence punctuation after it.
 * It stays unless an `Authorization` header holds it (break hunt: ordinary text was altered).
 */
const PLAIN_WORD_RE = /^[A-Za-z]{1,19}[.;:!?)]*$/;

/**
 * Final-pass scrubber for every string leaving the server (tool output, errors, logs), and
 * the registry of live secrets read at runtime (the TypeSafe key, the tea token). Removes
 * registered secrets and anything that looks like an Authorization header value.
 */
export class Redactor {
  private readonly secrets = new Map<string, string>();
  /** The registered secrets themselves (not their encoded forms): fragment assembly runs on these (bug r22b). */
  private readonly primary = new Set<string>();
  private readonly fragmentIndexes = new Map<string, FragmentIndex>();

  /**
   * Registers a live secret and (bug r15b) its encoded forms as plain substrings: hex (lower,
   * upper), base64 at the 3 byte alignments (the stable inner chunk; standard and url-safe) and
   * percent-encoding. Detection of an encoded live secret never depends on the decode budget,
   * and stays linear; an encoded form is masked as `live_credential_<encoding>` (refused).
   */
  addSecret(secret: string, kind = "typesafe_key"): void {
    if (secret.length < 8) return;
    this.secrets.set(secret, kind);
    this.primary.add(secret);
    for (const [form, encoding] of Redactor.encodedForms(secret)) {
      if (form.length >= 8 && !this.secrets.has(form)) this.secrets.set(form, `live_credential_${encoding}`);
    }
  }

  /** The encoded forms of `secret` that hold it as a contiguous run, with the encoding name. */
  private static encodedForms(secret: string): Array<[string, string]> {
    const bytes = Buffer.from(secret, "utf8");
    const hex = bytes.toString("hex");
    const forms: Array<[string, string]> = [[hex, "hex"], [hex.toUpperCase(), "hex"]];
    for (let pad = 0; pad < 3; pad++) {
      const b64 = Buffer.concat([Buffer.alloc(pad), bytes]).toString("base64");
      // Only the characters whose 6 bits all come from the secret's bytes.
      const chunk = b64.slice(Math.ceil((8 * pad) / 6), Math.floor((8 * (pad + bytes.length)) / 6));
      forms.push([chunk, "base64"], [chunk.replace(/\+/g, "-").replace(/\//g, "_"), "base64"]);
    }
    const percent = [...bytes].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("");
    forms.push([percent, "percent"], [percent.toUpperCase(), "percent"], [encodeURIComponent(secret), "percent"]);
    return forms.filter(([form]) => form !== secret);
  }

  scrub(text: string): string {
    let out = text;
    for (const secret of this.secrets.keys()) {
      if (out.includes(secret)) out = out.split(secret).join(MASK);
    }
    return out.replace(BEARER_RE, (all: string, header: string | undefined, bearer: string, value: string) =>
      header === undefined && PLAIN_WORD_RE.test(value) ? all : `${header ?? ""}${bearer}${MASK}`,
    );
  }

  /** Every occurrence of a live secret (or one of its encoded forms) in `text`, with its kind (used by the secret guard). */
  secretRanges(text: string): Array<{ start: number; end: number; kind: string }> {
    const out: Array<{ start: number; end: number; kind: string }> = [];
    for (const [secret, kind] of this.secrets) {
      for (let at = text.indexOf(secret); at >= 0; at = text.indexOf(secret, at + secret.length)) out.push({ start: at, end: at + secret.length, kind });
    }
    return out;
  }

  /**
   * Scrubs every string and object key inside a JSON-compatible value. Each string is scrubbed on
   * its own, never the serialized JSON: a mask there could eat a JSON escape (`\"`) and break the
   * parse (break hunt: `"Bearer " + token` turned a tool result into an internal error).
   */
  scrubValue<T>(value: T): T {
    const json = JSON.stringify(value);
    return this.scrubTree(json === undefined ? null : JSON.parse(json)) as T;
  }

  private scrubTree(value: unknown): unknown {
    if (typeof value === "string") return this.scrub(value);
    if (Array.isArray(value)) return value.map((v) => this.scrubTree(v));
    if (value === null || typeof value !== "object") return value;
    // fromEntries defines own properties, so a `__proto__` key stays a field.
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [this.scrub(k), this.scrubTree(v)]));
  }

  /**
   * True when a registered secret can be put together from pieces found in `parts`:
   * every character of the secret lies inside a fragment of `fragmentLength(secret)` characters
   * that occurs in one part. Catches a secret split across
   * fields that are not adjacent (state vs. an instruction). One rolling-hash pass over the
   * text per secret (FragmentIndex), so the work is linear in the text.
   */
  assembledFrom(parts: string[]): boolean {
    if (this.secrets.size === 0) return false;
    const text = parts.join(" ");
    for (const index of this.indexes()) if (Redactor.covered(index, text)) return true;
    return false;
  }

  /**
   * Masks every fragment (a window of `fragmentLength(secret)` characters) of a registered
   * secret in `text` with `replace(kind)`; used once a record is known to hold a split secret.
   */
  maskFragments(text: string, replace: (kind: string) => string): string {
    const hit = new Uint8Array(text.length);
    const found: { kind: string | null } = { kind: null };
    for (const index of this.indexes()) {
      let until = 0;
      index.scan(text, (pos) => {
        found.kind = this.secrets.get(index.secret) ?? "live_credential";
        for (let i = Math.max(pos, until); i < pos + index.m; i++) hit[i] = 1;
        until = Math.max(until, pos + index.m);
        return false;
      });
    }
    return found.kind === null ? text : JoinedText.replaceMarked(text, hit, replace(found.kind));
  }

  /** Window coverage: every window start found in `text`, then one sweep over the secret. */
  private static covered(index: FragmentIndex, text: string): boolean {
    const { secret, m } = index;
    if (secret.length <= m) return false;
    const found = new Uint8Array(secret.length - m + 1);
    let left = index.groups;
    const seen = new Set<object>();
    index.scan(text, (_pos, starts, group) => {
      if (seen.has(group)) return false;
      seen.add(group);
      for (const s of starts) found[s] = 1;
      return --left === 0;
    });
    let reach = 0;
    for (let i = 0; i < found.length && reach < secret.length; i++) {
      if (i > reach) return false;
      if (found[i] === 1) reach = i + m;
    }
    return reach >= secret.length;
  }

  private indexes(): FragmentIndex[] {
    const out: FragmentIndex[] = [];
    for (const secret of this.primary) {
      let index = this.fragmentIndexes.get(secret);
      if (!index) {
        index = new FragmentIndex(secret, Redactor.fragmentLength(secret.length));
        this.fragmentIndexes.set(secret, index);
      }
      out.push(index);
    }
    return out;
  }

  /**
   * Window length k of the Rabin-Karp table: a quarter of the secret, at least MIN_FRAGMENT;
   * for a secret under 2 * MIN_FRAGMENT characters, half of it, at least MIN_SHORT_FRAGMENT
   * (k = 7 for 14-15 characters, 6 for 8-13), so two halves of a short secret are caught.
   */
  static fragmentLength(length: number): number {
    if (length < 2 * MIN_FRAGMENT) return Math.max(MIN_SHORT_FRAGMENT, Math.floor(length / 2));
    return Math.max(MIN_FRAGMENT, Math.floor(length / 4));
  }

  /** How many strings (secrets and encoded forms) are registered; it only grows (a cache key for scan results). */
  get registered(): number {
    return this.secrets.size;
  }

  /** True when `text` contains a registered secret. */
  containsSecret(text: string): boolean {
    for (const secret of this.secrets.keys()) if (text.includes(secret)) return true;
    return false;
  }
}
