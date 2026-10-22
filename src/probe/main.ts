#!/usr/bin/env node
import { JevApp } from "../app/JevApp.js";
import { ProbeRunner } from "./ProbeRunner.js";

/**
 * `npm run probe` (opt-in, JEV_LIVE=1): about 110 live calls, well under $0.01. Prints one
 * JSON summary to stdout. The key is read from the key file at runtime and never printed.
 */
async function main(): Promise<void> {
  if (process.env.JEV_LIVE !== "1") {
    process.stderr.write("probe: set JEV_LIVE=1 to run (sends live requests to TypeSafe).\n");
    process.exit(2);
  }
  const app = new JevApp();
  const runner = new ProbeRunner(app.service);
  const started = Date.now();
  const bias = await runner.bias();
  const tokens = await runner.tokens();
  const usage = app.ledger.snapshot();
  const out = { ran_at: new Date().toISOString(), wall_ms: Date.now() - started, models: [...runner.models], bias, tokens, usage: { requests: usage.requests, input_tokens: usage.input_tokens, est_cost_usd: usage.est_cost_usd } };
  process.stdout.write(`${JSON.stringify(app.redactor.scrubValue(out), null, 2)}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`probe failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
