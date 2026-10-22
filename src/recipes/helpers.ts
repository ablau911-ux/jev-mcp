import { JevError } from "../core/JevError.js";
import type { BoxCoords, CallResult, RawAnswer } from "../core/types.js";
import { DecisionPolicy } from "../policy/DecisionPolicy.js";

export interface UsageSum {
  /** Paid requests (cache hits excluded). */
  requests: number;
  /** True only when every call of the recipe was served from the cache (jev_ask outputSchema: boolean). */
  cached: boolean;
  input_tokens: number;
  output_tokens: number;
  est_cost_usd: number;
}

/** Sums usage over several calls (cached calls cost nothing). */
export function sumUsage(calls: CallResult[]): UsageSum {
  const out: UsageSum = { requests: 0, cached: calls.length > 0 && calls.every((c) => c.cached), input_tokens: 0, output_tokens: 0, est_cost_usd: 0 };
  for (const c of calls) {
    if (c.cached) continue;
    out.requests++;
    out.input_tokens += c.usage.input_tokens;
    out.output_tokens += c.usage.output_tokens;
    out.est_cost_usd += c.usage.est_cost_usd;
  }
  return out;
}

/** Reads an answer of the expected type or throws `bad_response`. */
export function answerOf<T extends RawAnswer["type"]>(call: CallResult, id: string, type: T): Extract<RawAnswer, { type: T }> {
  const a = call.answers[id];
  if (!a || a.type !== type) {
    throw new JevError({ kind: "bad_response", message: `Response lacks ${type} answer "${id}".`, fix: "Retry.", requestId: call.request_id });
  }
  return a as Extract<RawAnswer, { type: T }>;
}

export function warningsOf(calls: CallResult[], extra: string[] = []): string[] {
  return [...new Set([...extra, ...calls.flatMap((c) => c.warnings), ...trustWarnings(calls)])];
}

/**
 * Recipes without a decision still report what DecisionPolicy.cap would do: a likely injection
 * (probe) means review, untrusted state ($log, outside the workspace) means confirm at most.
 */
function trustWarnings(calls: CallResult[]): string[] {
  const probe = Math.max(-1, ...calls.map((c) => c.injection_p ?? -1));
  const ctx = { untrusted: calls.some((c) => c.untrusted), injectionP: probe < 0 ? null : probe };
  const action = DecisionPolicy.cap({ action: "auto", verdict: null, p: null, metric: "recipe", reason: "" }, ctx).action;
  if (action === "review") return [`Injection probe ${probe.toFixed(3)}: the untrusted content may be steering the answer; review it yourself.`];
  if (action === "confirm") return ["Untrusted content ($log or outside the workspace) in the state: treat the result as confirm, not auto."];
  return [];
}

/** Intersection over union of two normalized boxes (0 when either is empty or inverted). */
export function boxIoU(a: BoxCoords, b: BoxCoords): number {
  const area = (x: BoxCoords) => Math.max(0, x.right - x.left) * Math.max(0, x.bottom - x.top);
  const inter = area({ left: Math.max(a.left, b.left), right: Math.min(a.right, b.right), top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom) });
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Population standard deviation. */
export function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

/**
 * Up to k deterministic option orders for order checks, each different from `items` and from
 * one another: reversed first, then spread rotations, then any other rotation or reversed
 * rotation. Fewer than k come back when fewer distinct orders exist (2 items: only 1).
 */
export function permutations<T>(items: T[], k: number): T[][] {
  const n = items.length;
  const ids = items.map((_, i) => i);
  const rotate = (o: number[], s: number) => [...o.slice(s), ...o.slice(0, s)];
  function* candidates(): Generator<number[]> {
    yield [...ids].reverse();
    for (let i = 2; i <= k; i++) yield rotate(ids, Math.max(1, Math.floor(((i - 1) * n) / k)) % Math.max(1, n));
    for (let s = 1; s < n; s++) yield rotate(ids, s);
    for (let s = 0; s < n; s++) yield rotate(ids, s).reverse();
  }
  const seen = new Set([ids.join(",")]);
  const out: T[][] = [];
  for (const order of candidates()) {
    if (out.length >= k) break;
    const key = order.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(order.map((i) => items[i] as T));
  }
  return out;
}
