/**
 * Deterministic inputs for the live probe (`npm run probe`). Nothing here is random, so a
 * rerun sends the same content and the numbers stay comparable.
 */
export interface CodeSample {
  id: string;
  code: string;
  /** The option a careful reader would pick; used only to report accuracy per order. */
  expected: "side_effects" | "pure";
}

const NAMES = ["total", "price", "count", "score", "width", "offset", "limit", "ratio", "index", "weight"];

const PURE: Array<(n: string) => string> = [
  (n) => `function double${n}(${n}: number): number {\n  return ${n} * 2;\n}`,
  (n) => `const clamp${n} = (${n}: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, ${n}));`,
  (n) => `function sum${n}(xs: number[]): number {\n  return xs.reduce((a, b) => a + b, 0);\n}`,
  (n) => `export function format${n}(${n}: number): string {\n  return ${n}.toFixed(2);\n}`,
  (n) => `function isValid${n}(${n}: unknown): boolean {\n  return typeof ${n} === "number" && Number.isFinite(${n});\n}`,
];

const IMPURE: Array<(n: string) => string> = [
  (n) => `function save${n}(${n}: number): void {\n  fs.writeFileSync("${n}.txt", String(${n}));\n}`,
  (n) => `async function load${n}(): Promise<number> {\n  const r = await fetch("/api/${n}");\n  return (await r.json()).${n};\n}`,
  (n) => `let cache${n} = 0;\nfunction bump${n}(${n}: number) {\n  cache${n} += ${n};\n  return cache${n};\n}`,
  (n) => `function log${n}(${n}: number): number {\n  console.log("${n}", ${n});\n  return ${n};\n}`,
  (n) => `function reset${n}(db: Db) {\n  db.exec("DELETE FROM ${n}");\n}`,
];

/** 50 small TypeScript snippets: 25 pure, 25 with side effects. */
export function codeSamples(): CodeSample[] {
  const out: CodeSample[] = [];
  for (let i = 0; i < 25; i++) {
    const name = NAMES[i % NAMES.length] ?? "x";
    const pure = PURE[i % PURE.length];
    const impure = IMPURE[i % IMPURE.length];
    if (pure) out.push({ id: `pure_${i}`, code: pure(name), expected: "pure" });
    if (impure) out.push({ id: `impure_${i}`, code: impure(name), expected: "side_effects" });
  }
  return out;
}

export const SIDE_EFFECT_OPTIONS: Record<string, string> = {
  side_effects: "The code reads or writes files, network, a database, the console or state outside the function",
  pure: "The code only computes a value from its inputs and changes nothing outside the function",
};

const CODE_UNIT = `export class RetryQueue<T> {\n  private items: T[] = [];\n  push(item: T): void {\n    if (this.items.length >= 64) this.items.shift();\n    this.items.push(item);\n  }\n}\n`;
const JSON_UNIT = { id: "ord-1042", status: "shipped", items: [{ sku: "A-17", qty: 2, price: "19.90" }], tags: ["priority", "eu"] };
const HEBREW_UNIT = "הלקוח הביא את הרכב למוסך בגלל רעש חזק מהבלמים בזמן נסיעה בעיר. ";

/** Token-estimate inputs: the same content kind repeated to several sizes. */
export function tokenSamples(): Array<{ kind: "code" | "json" | "hebrew"; state: string | object; chars: number }> {
  const out: Array<{ kind: "code" | "json" | "hebrew"; state: string | object; chars: number }> = [];
  for (const reps of [4, 16, 64]) {
    const code = CODE_UNIT.repeat(reps);
    const json = { orders: Array.from({ length: reps }, (_, i) => ({ ...JSON_UNIT, id: `ord-${1000 + i}` })) };
    const hebrew = HEBREW_UNIT.repeat(reps);
    out.push({ kind: "code", state: code, chars: code.length });
    out.push({ kind: "json", state: json, chars: JSON.stringify(json).length });
    out.push({ kind: "hebrew", state: hebrew, chars: hebrew.length });
  }
  return out;
}
