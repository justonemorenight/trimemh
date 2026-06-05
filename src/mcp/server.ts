import type { Database } from "bun:sqlite";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { getRateLimiter } from "../infrastructure/rate-limit";
import { enforceStdinPayloadLimit } from "./runtime";
import { registerMemoryTools } from "./tools";

export async function startMcpServer(db: Database, projectId: string): Promise<void> {
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
    },
  );

  registerMemoryTools(server, db, projectId, rateLimiter);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
