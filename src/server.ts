#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { JevApp } from "./app/JevApp.js";
import { McpAdapter } from "./app/McpAdapter.js";

/** Starts the stdio MCP server. All logs go to stderr; stdout is the MCP channel. */
export async function main(): Promise<void> {
  let adapter: McpAdapter | null = null;
  let extraRoots: string[] = [];
  const app: JevApp = new JevApp({
    roots: async (): Promise<string[]> => {
      const fromClient = adapter ? await clientRoots(adapter) : [];
      return [process.cwd(), ...fromClient, ...extraRoots];
    },
  });
  app.processGuard.install();
  extraRoots = app.config.files.extraRoots;
  adapter = new McpAdapter(app);
  await adapter.server.connect(new StdioServerTransport());
  // Startup health check: background, never blocks; jev_status reports it.
  if (app.config.health.onStartup) void app.toolset.health.run();
  app.logger.info(`jev-mcp ready (key source: ${app.keys.source()}, models: ${JSON.stringify(app.config.models.features)}, backend: ${app.config.backend})`);
}

/** Reads the client's MCP roots when it supports them. */
async function clientRoots(adapter: McpAdapter): Promise<string[]> {
  const caps = adapter.server.server.getClientCapabilities();
  if (!caps?.roots) return [];
  try {
    const res = await adapter.server.server.listRoots();
    return res.roots.filter((r) => r.uri.startsWith("file:")).map((r) => fileURLToPath(r.uri));
  } catch {
    return [];
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[jev-mcp] fatal: ${err instanceof Error ? err.message : String(err)}
`);
  process.exit(1);
});
