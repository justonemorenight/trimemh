import type { Database } from "bun:sqlite";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { ResolvedTriMemhConfig } from "../infrastructure/config";
import { getRateLimiter } from "../infrastructure/rate-limit";
import { enforceStdinPayloadLimit } from "./runtime";
import { registerMemoryTools } from "./tools";

export async function startMcpServer(db: Database, config: ResolvedTriMemhConfig): Promise<void> {
  const rateLimiter = getRateLimiter();

  // SDD-05 §10.1: enforce 15KB total request body limit on process.stdin.
  enforceStdinPayloadLimit();

  const server = new McpServer(
    {
      name: "trimemh",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        "triMemh provides persistent local project memory. At the start of a task, call memory_context with the user task and open paths, then memory_search with mode='hybrid' for relevant prior decisions, mistakes, procedures, preferences, and code context. Use memory_code_search for specific files or symbols. Repository state and explicit user instructions override memory.",
    },
  );

  registerMemoryTools(server, db, config, rateLimiter);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
