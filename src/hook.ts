#!/usr/bin/env node
import { JevApp } from "./app/JevApp.js";
import { HookRunner, type HookEvent } from "./hooks/HookRunner.js";
import { DecisionPolicy } from "./policy/DecisionPolicy.js";

/**
 * `jev-mcp-hook <pre-tool-use|post-tool-use>`: reads the Claude Code hook JSON on stdin and
 * prints a hook decision on stdout, or nothing. Always exits 0 (fails open). Registering it
 * in settings.json is the user's choice; see README "Hooks".
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const event = process.argv[2] as HookEvent;
  if (event !== "pre-tool-use" && event !== "post-tool-use") {
    process.stderr.write("usage: jev-mcp-hook pre-tool-use|post-tool-use\n");
    return;
  }
  const app = new JevApp();
  app.processGuard.install();
  const runner = new HookRunner(app.service, new DecisionPolicy(app.config), app.config);
  const out = await runner.run(event, JSON.parse((await readStdin()) || "{}"));
  if (out) process.stdout.write(`${JSON.stringify(app.redactor.scrubValue(out))}\n`);
}

main().catch(() => undefined);
