import type { Entry, Questions, WireAsset, WireRequest } from "../core/types.js";
import { SecretGuard, SPLIT_KIND, type GuardContext } from "../validation/SecretGuard.js";
import { JoinedText } from "./JoinedText.js";

export interface SanitizedWire {
  wire: WireRequest;
  counts: Record<string, number>;
  total: number;
}

/**
 * THE choke point of the secret guard (project policy: code may go out, secrets
 * never). It runs on the complete wire payload right before the transport sends it, on every
 * record written to disk or returned over MCP (scrubValue) and on every log line (scrubText),
 * all through ONE masking pipeline (clean, bug r19), so no sink can differ:
 * - every string and every object key of state and questions (question names, generated
 *   instructions such as injection probes, criteria labels and descriptions) is masked in
 *   redact mode; in refuse mode any secret refuses the request;
 * - the model id and the asset (image) references are never masked: a secret there refuses;
 * - image bytes are scanned as text (metadata chunks); a secret there refuses;
 * - an encoded form (base64, hex, percent, escapes) of a live credential refuses;
 * - a secret split between fields: all strings, keys and numbers joined in document
 *   order (no separator, one space) get the narrowed joined scan (bug r5: live secrets,
 *   secret values split from their key, pattern matches cut inside their body); a
 *   live credential that can be put together from fragments anywhere in the payload refuses,
 *   any other split secret is masked (bug r9);
 * - a final whole-value scan re-masks residue; what is still secret after that refuses.
 */
export class OutboundSanitizer {
  constructor(private readonly guard: SecretGuard) {}

  sanitize(wire: WireRequest): SanitizedWire {
    if (this.guard.findings(wire.model).length > 0) throw SecretGuard.refused("The model id");
    const counts: Record<string, number> = {};
    if (this.guard.mode === "refuse" && this.detects([wire.state, wire.questions as unknown as Entry])) throw SecretGuard.refused("The request");
    // The model id joins the split scan as context; it is never masked.
    const clean = this.clean([wire.state, wire.questions as unknown as Entry], counts, [wire.model], "request");
    SecretGuard.refuseEncodedLive(counts);
    if (clean.live) throw SecretGuard.refused("The request (a secret split between fields)");
    if (clean.left) throw SecretGuard.refused("The request");
    const [state, questions] = clean.value as [Entry, Entry];
    const out: WireRequest = { model: wire.model, state, questions: questions as unknown as Questions };
    if (wire.assets) out.assets = this.checkAssets(wire.assets);
    return { wire: out, counts, total: SecretGuard.total(counts) };
  }

  /**
   * A sanitized copy of a record before it is persisted or returned over MCP (always masks, in
   * any mode): the same pipeline as the wire (bug r19). Refuses only when a registered live
   * secret is left behind after masking (bug r43).
   */
  scrubValue<T>(value: T): T {
    return this.scrub(value, "data");
  }

  /** Trusted answer/cache sinks preserve validated probability fields, never input state. */
  scrubResult<T>(value: T): T {
    return this.scrub(value, "output");
  }

  private scrub<T>(value: T, context: GuardContext): T {
    const json = JSON.stringify(value);
    if (json === undefined) return value;
    const clean = this.clean(JSON.parse(json) as Entry, {}, [], context);
    if (clean.left) throw SecretGuard.refused("A record (a secret split between fields)");
    return clean.value as T;
  }

  /**
   * Refuse mode (bug r25): ANY detection refuses before anything is masked: per string and pair,
   * split between fields, and split between values with object keys in between
   * (`{k: "password=", v: "x"}`: the value leaves joined without their keys).
   */
  private detects(values: Entry[]): boolean {
    if (this.guard.check([values], "request").length > 0 || this.splitKinds(values, true).length > 0) return true;
    const { parts, keys } = JoinedText.partsWithKeys(values as Entry);
    const leaves = parts.filter((_, i) => !keys.has(i));
    return this.guard.joinedFindings(leaves, "", true).length > 0 || this.guard.joinedFindings(leaves, " ", true).length > 0;
  }

  /** A log line through the same pipeline (bug r19); a line that cannot be cleaned is replaced whole. */
  scrubText(text: string): string {
    try {
      return this.scrubValue(text);
    } catch {
      return "[REDACTED]";
    }
  }

  /**
   * THE masking pipeline of every sink (bug r19: wire, disk, MCP output, logs run the same
   * steps): every string and key masked (SecretGuard.redactTree); a secret split between fields
   * masked (live fragments and keyed / pattern pieces); residue the final whole-value
   * scan still finds re-masked (bug r13). `context` (the model id) joins the scans but is never
   * masked. `live`: a registered live secret was split between fields (the wire refuses it);
   * `left`: a registered live secret is still found after masking (checked only when a step had
   * to mask); a non-live leftover is masked line by line and sent (bug r43).
   */
  private clean(value: Entry, counts: Record<string, number>, context: unknown[] = [], scope: GuardContext = "data"): { value: Entry; live: boolean; left: boolean } {
    let out = this.guard.redactTree(value, counts, false, scope);
    const split = this.splitKinds([...context, out], true);
    if (split.length > 0) {
      out = this.guard.maskSplit(this.guard.maskFragments(out), true);
      counts[SPLIT_KIND] = (counts[SPLIT_KIND] ?? 0) + 1;
    }
    const residue = this.residue(out, context, scope).length > 0;
    if (residue) out = this.guard.maskResidue(out, counts, undefined, false, scope);
    const left = split.length > 0 || residue ? [...this.splitKinds([...context, out], true), ...this.residue(out, context, scope)] : [];
    // Only a registered live secret left behind refuses (bug r43: a non-live leftover is masked as far as spans and lines go, and sent).
    return { value: out, live: split.includes("live_credential"), left: left.some((k) => k === "live_credential" || k.includes("live credential")) };
  }

  /**
   * What the whole-value scan finds: per string and per pair, and in the serialized payload
   * (keyed values were judged per string and per pair; in the serialized JSON its own quotes
   * would be misread).
   */
  private residue(value: Entry, context: unknown[], scope: GuardContext): string[] {
    return [...this.guard.check([value], scope), ...this.guard.check(context), ...this.guard.findings(JSON.stringify([...context, value]), false)];
  }

  /**
   * Kinds of secret that only appear once the strings, keys and numbers are put together
   * (`live_credential` when a registered secret can be assembled from fragments). `patterns`
   * adds pattern matches cut inside their body.
   */
  private splitKinds(values: unknown[], patterns = false): string[] {
    const { parts, keys } = JoinedText.partsWithKeys(values as Entry);
    const kinds = new Set([...this.guard.joinedFindings(parts, "", patterns, keys), ...this.guard.joinedFindings(parts, " ", patterns, keys)]);
    if (this.guard.assembledFrom(parts)) kinds.add("live_credential");
    return [...kinds];
  }

  private checkAssets(assets: Record<string, WireAsset>): Record<string, WireAsset> {
    for (const [ref, asset] of Object.entries(assets)) {
      if (this.guard.findings(ref).length > 0) throw SecretGuard.refused("An image reference");
      const data = asset.data;
      if (data instanceof Uint8Array && this.guard.findings(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("latin1")).length > 0) {
        throw SecretGuard.refused("An image (its metadata)");
      }
    }
    return assets;
  }
}
