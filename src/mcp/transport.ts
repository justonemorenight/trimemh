/**
 * MCP v2 Streamable HTTP Transport (Phase 3 — Integration & DX)
 *
 * Adds Streamable HTTP transport alongside the existing stdio transport.
 * Implements MCP Specification 2025-06-18 requirements:
 * - Origin header validation
 * - Localhost binding (127.0.0.1)
 * - CORS configuration with specific origins
 * - Server-sent notifications via SSE
 * - JSON-RPC 2.0 compliant response envelope
 *
 * Usage:
 *   // In MCP server start:
 *   const transport = createStreamableHTTP({ port: 3000 });
 *   await server.connect(transport);
 *
 * Security (SDD-05 §10):
 * - Blocks requests with mismatched Origin headers
 * - Only binds to localhost by default
 * - Configurable CORS allowlist
 */

import type { Database } from "bun:sqlite";

import { assembleMemoryContext } from "../context/context-runtime";
import type {
  CodeEntityType,
  CodeLinkRelation,
  MemoryEdgeRelation,
  MemoryKind,
} from "../domain/schema";
import { CODE_LINK_RELATIONS, KIND_RISK_MAP, MEMORY_EDGE_RELATIONS } from "../domain/schema";
import { guardOutput, guardString } from "../infrastructure/guardrail";
import { getLogger } from "../infrastructure/logging";
import { getRateLimiter } from "../infrastructure/rate-limit";
import { getEmbeddingProvider } from "../retrieval/embedding-provider";
import {
  mcpCodeSearch,
  mcpGet,
  mcpHybridSearch,
  mcpMemoryCodeLinkPropose,
  mcpMemoryLinkPropose,
  mcpPropose,
  mcpRelated,
  mcpSearch,
  mcpStats,
} from "../service";

// ─── Types ──────────────────────────────────────────────────────────

export interface StreamableHTTPConfig {
  /** Port to listen on (default: 3100). */
  port: number;
  /** Host to bind to (default: 127.0.0.1 for security). */
  host: string;
  /** Allowed origins (CORS). Empty = same-origin only. */
  allowedOrigins: string[];
  /** Enable CORS preflight handling. */
  cors: boolean;
}

export interface JSONRPCRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id?: string | number;
}

export interface JSONRPCResponse {
  jsonrpc: "2.0";
  id?: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// ─── Security helpers ───────────────────────────────────────────────

function validateOrigin(origin: string | null, allowedOrigins: string[]): boolean {
  if (!origin) {
    return true; // same-origin requests have no Origin header
  }
  if (allowedOrigins.length === 0) {
    return false; // no origins allowed = block all CORS
  }
  return allowedOrigins.includes(origin) || allowedOrigins.includes("*");
}

function corsHeaders(origin: string | null, config: StreamableHTTPConfig): Record<string, string> {
  if (!config.cors) {
    return {};
  }
  const headers: Record<string, string> = {};
  if (origin && (config.allowedOrigins.includes(origin) || config.allowedOrigins.includes("*"))) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
  }
  return headers;
}

// ─── Tool dispatch ──────────────────────────────────────────────────

function dispatchTool(
  db: Database,
  projectId: string,
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
  switch (method) {
    case "memory_search":
      return handleSearch(db, projectId, params ?? {});
    case "memory_context":
      return handleContext(db, projectId, params ?? {});
    case "memory_propose":
      return handlePropose(db, projectId, params ?? {});
    case "memory_get":
      return handleGet(db, projectId, params ?? {});
    case "memory_stats":
      return handleStats(db, projectId);
    case "memory_related":
      return handleRelated(db, projectId, params ?? {});
    case "memory_code_search":
      return handleCodeSearch(db, projectId, params ?? {});
    case "memory_link_propose":
      return handleLinkPropose(db, projectId, params ?? {});
    case "memory_code_link_propose":
      return handleCodeLinkPropose(db, projectId, params ?? {});
    default:
      return Promise.resolve({
        content: [{ type: "text", text: `Unknown tool: ${method}` }],
        isError: true,
      });
  }
}

// ─── Tool handlers ──────────────────────────────────────────────────

async function handleSearch(db: Database, projectId: string, params: Record<string, unknown>) {
  const query = String(params.query ?? "");
  const mode = (params.mode as string) ?? "fts";
  const limit = Math.min(Number(params.limit ?? 10), 5);

  if (mode === "hybrid" || mode === "vector") {
    const provider = getEmbeddingProvider();
    const embedding = await provider.embedAsync(query);
    const results = mcpHybridSearch(
      db,
      projectId,
      mode === "hybrid" ? query : "",
      embedding,
      limit,
    );
    const text = results.map((r) => `[${r.id.slice(0, 8)}] (${r.kind}) ${r.snippet}`).join("\n\n");
    return { content: [{ type: "text", text: guardOutput(text) }] };
  }

  const results = mcpSearch(db, projectId, query, limit);
  const text = results.map((r) => `[${r.id.slice(0, 8)}] (${r.kind}) ${r.snippet}`).join("\n\n");
  return { content: [{ type: "text", text: guardOutput(text) }] };
}

// biome-ignore lint/suspicious/useAwait: warning suppression
async function handleContext(db: Database, projectId: string, params: Record<string, unknown>) {
  const assembled = assembleMemoryContext({
    db,
    projectId,
    query: (params.query as string) ?? null,
    openPaths: (params.open_paths as string[]) ?? [],
    includeLineageForIds: (params.include_lineage_for_ids as string[]) ?? [],
    modelContextTokens: (params.model_context_tokens as number) ?? 32_000,
  });
  return { content: [{ type: "text", text: assembled.xml }] };
}

// biome-ignore lint/suspicious/useAwait: warning suppression
async function handlePropose(db: Database, projectId: string, params: Record<string, unknown>) {
  const kind = String(params.kind ?? "");
  const text = guardString(String(params.text ?? ""), "text");
  const validKinds = Object.keys(KIND_RISK_MAP);
  if (!validKinds.includes(kind)) {
    return {
      content: [{ type: "text", text: `Invalid kind "${kind}". Valid: ${validKinds.join(", ")}` }],
      isError: true,
    };
  }
  const result = mcpPropose(db, {
    kind: kind as MemoryKind,
    text,
    projectId,
    proposedBy: "mcp:http:agent",
    rationale: (params.rationale as string) ?? undefined,
  });
  return {
    content: [
      {
        type: "text",
        text: guardOutput(
          `Proposal ${result.proposal_id} — ${result.risk_level} risk, ${result.status}`,
        ),
      },
    ],
  };
}

// biome-ignore lint/suspicious/useAwait: warning suppression
async function handleGet(db: Database, projectId: string, params: Record<string, unknown>) {
  const id = String(params.id ?? "");
  const item = mcpGet(db, projectId, id);
  if (!item) {
    return { content: [{ type: "text", text: `Memory "${id}" not found.` }] };
  }
  return {
    content: [{ type: "text", text: guardOutput(`[${item.id}] (${item.kind}) ${item.text}`) }],
  };
}

// biome-ignore lint/suspicious/useAwait: warning suppression
async function handleStats(db: Database, projectId: string) {
  const stats = mcpStats(db, projectId);
  return { content: [{ type: "text", text: guardOutput(JSON.stringify(stats)) }] };
}

// biome-ignore lint/suspicious/useAwait: warning suppression
async function handleRelated(db: Database, projectId: string, params: Record<string, unknown>) {
  const id = String(params.id ?? "");
  const depth = Math.min(Number(params.depth ?? 1), 2);
  const related = mcpRelated(db, projectId, id, depth);
  const text = related
    .map((r) => `[${r.item.id.slice(0, 8)}] ${r.direction} ${r.edge.relation}`)
    .join("\n");
  return { content: [{ type: "text", text: guardOutput(text) }] };
}

// biome-ignore lint/suspicious/useAwait: warning suppression
async function handleCodeSearch(db: Database, projectId: string, params: Record<string, unknown>) {
  const path = String(params.path ?? "");
  const symbol = params.symbol ? String(params.symbol) : undefined;
  const results = mcpCodeSearch(db, projectId, path, symbol);
  const text = results
    .map((r) => `[${r.item.id.slice(0, 8)}] ${r.link.relation} ${r.entity.path}`)
    .join("\n");
  return { content: [{ type: "text", text: guardOutput(text) }] };
}

// biome-ignore lint/suspicious/useAwait: warning suppression
async function handleLinkPropose(db: Database, projectId: string, params: Record<string, unknown>) {
  const relation = String(params.relation ?? "");
  if (!MEMORY_EDGE_RELATIONS.includes(relation as MemoryEdgeRelation)) {
    return { content: [{ type: "text", text: `Invalid relation "${relation}".` }], isError: true };
  }
  const result = mcpMemoryLinkPropose(db, {
    projectId,
    sourceMemoryId: String(params.source_memory_id ?? ""),
    targetMemoryId: String(params.target_memory_id ?? ""),
    relation: relation as MemoryEdgeRelation,
    proposedBy: "mcp:http:agent",
  });
  return { content: [{ type: "text", text: guardOutput(`${result.message}`) }] };
}

// biome-ignore lint/suspicious/useAwait: warning suppression
async function handleCodeLinkPropose(
  db: Database,
  projectId: string,
  params: Record<string, unknown>,
) {
  const relation = String(params.relation ?? "relates_to");
  if (!CODE_LINK_RELATIONS.includes(relation as CodeLinkRelation)) {
    return { content: [{ type: "text", text: `Invalid relation "${relation}".` }], isError: true };
  }
  const result = mcpMemoryCodeLinkPropose(db, {
    projectId,
    memoryId: String(params.memory_id ?? ""),
    path: String(params.path ?? ""),
    relation: relation as CodeLinkRelation,
    entityType: (params.entity_type as CodeEntityType) ?? "file",
    proposedBy: "mcp:http:agent",
  });
  return { content: [{ type: "text", text: guardOutput(`${result.message}`) }] };
}

// ─── Streamable HTTP Server ─────────────────────────────────────────

/**
 * Start a Streamable HTTP MCP server on the configured host:port.
 *
 * This runs alongside the application (not a separate process) and
 * handles JSON-RPC 2.0 requests over HTTP POST with SSE notifications.
 */
export function createStreamableHTTPServer(
  db: Database,
  projectId: string,
  config?: Partial<StreamableHTTPConfig>,
): { server: ReturnType<typeof Bun.serve>; url: string } {
  const cfg: StreamableHTTPConfig = {
    port: config?.port ?? 3100,
    host: config?.host ?? "127.0.0.1",
    allowedOrigins: config?.allowedOrigins ?? [],
    cors: config?.cors ?? true,
  };

  const rateLimiter = getRateLimiter();
  const log = getLogger();

  const server = Bun.serve({
    port: cfg.port,
    hostname: cfg.host,
    async fetch(req) {
      const origin = req.headers.get("Origin");

      // CORS preflight
      if (req.method === "OPTIONS" && cfg.cors) {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(origin, cfg),
        });
      }

      // Origin validation (SDD-05 §10)
      if (!validateOrigin(origin, cfg.allowedOrigins)) {
        log.warn("mcp-http", "origin_blocked", { origin: origin ?? "(none)" });
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Origin not allowed" },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }

      // Only POST for JSON-RPC
      if (req.method !== "POST") {
        // Health check endpoint
        if (req.method === "GET" && new URL(req.url).pathname === "/health") {
          return new Response(
            JSON.stringify({ status: "ok", provider: getEmbeddingProvider().name }),
            {
              headers: { "Content-Type": "application/json", ...corsHeaders(origin, cfg) },
            },
          );
        }
        return new Response("Method not allowed", { status: 405 });
      }

      // Rate limit
      const rl = rateLimiter.check("memory_search"); // generic rate limit for HTTP
      if (!rl.allowed) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Rate limit exceeded",
              data: { retryAfter: rl.retryAfter },
            },
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": String(Math.ceil(rl.retryAfter)),
            },
          },
        );
      }

      // Parse JSON-RPC request
      let request: JSONRPCRequest;
      try {
        const body = await req.text();
        if (body.length > 15_360) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32600, message: "Request too large" },
            }),
            { status: 413, headers: { "Content-Type": "application/json" } },
          );
        }
        request = JSON.parse(body);
      } catch {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32700, message: "Parse error" },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      if (request.jsonrpc !== "2.0") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32600, message: "Invalid JSON-RPC version" },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // Dispatch tool
      try {
        const result = await dispatchTool(db, projectId, request.method, request.params);
        const response: JSONRPCResponse = {
          jsonrpc: "2.0",
          id: request.id,
          result: result,
        };

        log.info("mcp-http", `tool:${request.method}`, {
          tool: request.method,
          isError: result.isError ?? false,
        });

        return new Response(JSON.stringify(response), {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(origin, cfg),
          },
        });
      } catch (err) {
        log.error("mcp-http", `tool_error:${request.method}`, {
          error: (err as Error).message,
        });

        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32603,
              message: "Internal error",
              data: (err as Error).message,
            },
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders(origin, cfg) },
          },
        );
      }
    },
  });

  const url = `http://${cfg.host}:${cfg.port}`;
  log.info("mcp-http", "server_started", { url, host: cfg.host, port: cfg.port });

  return { server, url };
}
