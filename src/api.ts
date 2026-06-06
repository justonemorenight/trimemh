import type { Database } from "bun:sqlite";

import type { Context } from "hono";
import { Hono } from "hono";
import { ZodError, z } from "zod";

import { CONFIG } from "./config";
import { assembleMemoryContext } from "./context/context-runtime";
import type {
  CodeEntityType,
  CodeLinkRelation,
  MemoryEdgeRelation,
  MemoryItem,
  ProposalStatus,
} from "./domain/schema";
import {
  CODE_ENTITY_TYPES,
  CODE_LINK_RELATIONS,
  EvidenceSchema,
  MEMORY_EDGE_RELATIONS,
  MEMORY_KINDS,
  PROPOSAL_ACTIONS,
  PROPOSAL_STATUSES,
  VISIBILITY,
} from "./domain/schema";
import { loadConfig } from "./infrastructure/config";
import {
  GuardrailViolation,
  assertDirectWriteAllowed,
  capSearchLimit,
  guardRequestPayload,
} from "./infrastructure/guardrail";
import { getRateLimiter } from "./infrastructure/rate-limit";
import { getDb, runMigrations } from "./persistence/db";
import { embedText } from "./retrieval/embedding-provider";
import { vectorSearch } from "./retrieval/hybrid";
import {
  approve,
  approveMemoryLinkProposal,
  forget,
  hybridRecall,
  listAll,
  mcpGet,
  proposals,
  propose,
  proposeMemoryCodeLink,
  proposeMemoryEdge,
  recall,
  reject,
  rejectMemoryLinkProposal,
  remember,
  status,
} from "./service";

const RememberSchema = z.object({
  kind: z.enum(MEMORY_KINDS),
  text: z.string().min(1).max(CONFIG.zod.maxMemoryText),
  confidence: z.number().min(0).max(1).optional(),
  visibility: z.enum(VISIBILITY).optional(),
  evidence: z.array(EvidenceSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.string().datetime().optional(),
});

const RecallSchema = z.object({
  query: z.string().min(1).max(CONFIG.zod.maxQueryLength).optional(),
  vector: z.array(z.number()).optional(),
  mode: z.enum(["fts", "vector", "hybrid"]).default("fts"),
  limit: z.number().int().min(1).max(CONFIG.api.maxListLimit).default(CONFIG.api.defaultListLimit),
});

const ContextAssembleSchema = z.object({
  query: z.string().max(CONFIG.zod.maxQueryLength).optional(),
  open_paths: z.array(z.string().max(CONFIG.zod.maxPathLength)).optional(),
  openPaths: z.array(z.string().max(CONFIG.zod.maxPathLength)).optional(),
  include_lineage_for_ids: z.array(z.string().max(CONFIG.zod.maxLineageIds)).optional(),
  includeLineageForIds: z.array(z.string().max(CONFIG.zod.maxLineageIds)).optional(),
  model_context_tokens: z
    .number()
    .int()
    .min(CONFIG.context.minModelTokens)
    .max(CONFIG.context.maxModelTokens)
    .optional(),
  modelContextTokens: z
    .number()
    .int()
    .min(CONFIG.context.minModelTokens)
    .max(CONFIG.context.maxModelTokens)
    .optional(),
});

const ProposalSchema = z.object({
  kind: z.enum(MEMORY_KINDS),
  text: z.string().min(1).max(CONFIG.zod.maxMemoryText),
  action: z.enum(PROPOSAL_ACTIONS).default("create"),
  target_memory_id: z.string().optional(),
  targetMemoryId: z.string().optional(),
  proposed_by: z.string().min(1).max(CONFIG.zod.maxEntityLength).optional(),
  rationale: z.string().max(CONFIG.zod.maxMemoryRationale).optional(),
  evidence: z.array(EvidenceSchema).optional(),
});

const DecisionSchema = z.object({
  decided_by: z.string().min(1).max(CONFIG.zod.maxEntityLength).optional(),
  decidedBy: z.string().min(1).max(CONFIG.zod.maxEntityLength).optional(),
  note: z.string().max(CONFIG.zod.maxMemoryRationale).optional(),
});

const LinkProposalSchema = z.object({
  proposal_type: z.enum(["memory_edge", "memory_code_link"]),
  source_memory_id: z.string().optional(),
  sourceMemoryId: z.string().optional(),
  target_memory_id: z.string().optional(),
  targetMemoryId: z.string().optional(),
  memory_id: z.string().optional(),
  memoryId: z.string().optional(),
  entity_type: z.enum(CODE_ENTITY_TYPES).optional(),
  entityType: z.enum(CODE_ENTITY_TYPES).optional(),
  path: z.string().max(CONFIG.zod.maxPathLength).optional(),
  symbol: z.string().max(CONFIG.zod.maxSymbolLength).optional(),
  line_start: z.number().int().optional(),
  lineStart: z.number().int().optional(),
  line_end: z.number().int().optional(),
  lineEnd: z.number().int().optional(),
  fingerprint: z.string().max(CONFIG.zod.maxFingerprintLength).optional(),
  relation: z.string().min(1).max(CONFIG.zod.maxRelationLength),
  confidence: z.number().min(0).max(1).optional(),
  proposed_by: z.string().min(1).max(CONFIG.zod.maxEntityLength).optional(),
  proposedBy: z.string().min(1).max(CONFIG.zod.maxEntityLength).optional(),
  rationale: z.string().max(CONFIG.zod.maxMemoryRationale).optional(),
  evidence: z.array(EvidenceSchema).optional(),
});

function jsonError(c: Context, statusCode: number, message: string, details?: unknown) {
  return c.json({ success: false, error: message, details }, statusCode as never);
}

// ─── Rate limiting middleware ─────────────────────────────────────

/** Maps API path patterns to rate-limit tool names. */
function toolNameForPath(method: string, path: string): string {
  if (
    path.startsWith("/api/memories/recall") ||
    (path.startsWith("/api/memories") && method === "GET")
  ) {
    return "memory_search";
  }
  if (path.startsWith("/api/context/assemble")) {
    return "memory_context";
  }
  if (path.startsWith("/api/links/propose")) {
    return "memory_link_propose";
  }
  if (path.startsWith("/api/links/code/propose")) {
    return "memory_code_link_propose";
  }
  if (path.startsWith("/api/proposals") && method === "POST") {
    return "memory_propose";
  }
  if (path.startsWith("/api/proposals") && method === "GET") {
    return "memory_stats";
  }
  if (path.startsWith("/api/status")) {
    return "memory_stats";
  }
  if (path.startsWith("/api/memories/remember")) {
    return "memory_propose";
  }
  return "default";
}

function checkApiRateLimit(
  method: string,
  path: string,
): { allowed: true } | { allowed: false; retryAfter: number } {
  const rateLimiter = getRateLimiter();
  const toolName = toolNameForPath(method, path);
  const result = rateLimiter.check(toolName);
  if (!result.allowed) {
    console.warn(
      `[triMemh] api_rate_limit: ${toolName} (${method} ${path}) denied (retry in ${result.retryAfter}s)`,
    );
    return { allowed: false, retryAfter: result.retryAfter };
  }
  return { allowed: true };
}

function normalizeError(err: unknown): { message: string; details?: unknown } {
  if (err instanceof GuardrailViolation) {
    return {
      message: err.message,
      details: { code: err.code, statusCode: err.statusCode },
    };
  }
  if (err instanceof ZodError) {
    return {
      message: "Invalid request payload",
      details: z.treeifyError(err),
    };
  }
  if (err instanceof Error) {
    return { message: err.message };
  }
  return { message: "Unknown error" };
}

function _parseLimit(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(parsed, CONFIG.api.maxListLimit));
}

function actorFromDecision(input: z.infer<typeof DecisionSchema>, fallback: string): string {
  return input.decided_by ?? input.decidedBy ?? fallback;
}

function targetMemoryId(input: z.infer<typeof ProposalSchema>): string | undefined {
  return input.targetMemoryId ?? input.target_memory_id;
}

function publicMemoryItem(item: MemoryItem): Omit<MemoryItem, "embedding"> {
  const { embedding: _embedding, ...publicItem } = item;
  return publicItem;
}

function publicResult<T extends { item: MemoryItem }>(
  result: T,
): Omit<T, "item"> & { item: Omit<MemoryItem, "embedding"> } {
  const { item, ...rest } = result;
  return {
    ...rest,
    item: publicMemoryItem(item),
  };
}

async function guardedBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const raw = await c.req.json();
  const guarded = guardRequestPayload({ payload: raw, surface: "api" });
  return schema.parse(guarded);
}

function assertLinkProposalShape(input: z.infer<typeof LinkProposalSchema>): void {
  if (input.proposal_type === "memory_edge") {
    const source = input.sourceMemoryId ?? input.source_memory_id;
    const target = input.targetMemoryId ?? input.target_memory_id;
    if (!(source && target)) {
      throw new Error("memory_edge proposals require source_memory_id and target_memory_id.");
    }
    if (!MEMORY_EDGE_RELATIONS.includes(input.relation as MemoryEdgeRelation)) {
      throw new Error(`Invalid memory edge relation "${input.relation}".`);
    }
    return;
  }

  const memoryId =
    input.memoryId ?? input.memory_id ?? input.sourceMemoryId ?? input.source_memory_id;
  const entityType = input.entityType ?? input.entity_type;
  if (!(memoryId && entityType && input.path)) {
    throw new Error("memory_code_link proposals require memory_id, entity_type, and path.");
  }
  if (!CODE_LINK_RELATIONS.includes(input.relation as CodeLinkRelation)) {
    throw new Error(`Invalid code link relation "${input.relation}".`);
  }
}

export function createApi(input: { db: Database; projectId: string }): Hono {
  const app = new Hono();
  const { db, projectId } = input;

  app.onError((err, c) => {
    const normalized = normalizeError(err);
    const statusCode =
      normalized.details &&
      typeof normalized.details === "object" &&
      "statusCode" in normalized.details &&
      typeof normalized.details.statusCode === "number"
        ? normalized.details.statusCode
        : 400;
    return jsonError(c, statusCode, normalized.message, normalized.details);
  });

  // ── Global rate-limit middleware ──────────────────────────────
  app.use("/api/*", async (c, next) => {
    const rl = checkApiRateLimit(c.req.method, c.req.path);
    if (!rl.allowed) {
      return c.json(
        {
          success: false,
          error: "Too Many Requests",
          retry_after_seconds: rl.retryAfter,
        },
        429,
      );
    }
    await next();
  });

  app.get("/api/status", (c) => {
    const data = status(db, projectId);
    return c.json({ success: true, project_id: projectId, data });
  });

  app.get("/api/memories", (c) => {
    const kind = c.req.query("kind");
    const itemStatus = c.req.query("status");
    const data = listAll(db, projectId, kind, itemStatus).map(publicMemoryItem);
    return c.json({ success: true, count: data.length, data });
  });

  app.get("/api/memories/:id", (c) => {
    const item = mcpGet(db, projectId, c.req.param("id"));
    if (!item) {
      return jsonError(c, 404, `Memory "${c.req.param("id")}" not found.`);
    }
    return c.json({ success: true, data: publicMemoryItem(item) });
  });

  app.post("/api/memories/remember", async (c) => {
    const body = await guardedBody(c, RememberSchema);
    assertDirectWriteAllowed({
      kind: body.kind,
      actor: "api:http:user_write",
      surface: "api",
    });

    const item = remember(db, {
      ...body,
      projectId,
      source: "api:http:user_write",
    });
    return c.json({ success: true, data: publicMemoryItem(item) }, 201);
  });

  app.delete("/api/memories/:id", (c) => {
    const deleted = forget(db, projectId, c.req.param("id"));
    return c.json({ success: true, deleted });
  });

  app.post("/api/memories/recall", async (c) => {
    const body = await guardedBody(c, RecallSchema);
    const limit = capSearchLimit(body.limit, "api");

    if (body.mode === "fts") {
      if (!body.query) {
        return jsonError(c, 400, "query is required for FTS recall mode.");
      }
      const results = recall(db, projectId, body.query, limit);
      const data = results.map(publicResult);
      return c.json({ success: true, mode: "fts", count: data.length, data });
    }

    if (body.mode === "vector") {
      if ((!body.vector || body.vector.length === 0) && !body.query) {
        return jsonError(c, 400, "query or vector is required for vector recall mode.");
      }
      const queryEmbedding =
        body.vector && body.vector.length > 0
          ? new Float32Array(body.vector)
          : embedText(body.query ?? "");
      const results = vectorSearch(db, projectId, queryEmbedding, limit);
      const data = results.map(publicResult);
      return c.json({ success: true, mode: "vector", count: data.length, data });
    }

    if (body.mode === "hybrid") {
      if (!body.query && (!body.vector || body.vector.length === 0)) {
        return jsonError(c, 400, "query or vector is required for hybrid recall mode.");
      }
      const queryEmbedding =
        body.vector && body.vector.length > 0 ? new Float32Array(body.vector) : null;
      const results = hybridRecall(db, projectId, body.query ?? null, queryEmbedding, limit);
      const data = results.map(publicResult);
      return c.json({ success: true, mode: "hybrid", count: data.length, data });
    }

    return jsonError(c, 400, `Unsupported recall mode "${body.mode}".`);
  });

  app.post("/api/context/assemble", async (c) => {
    const body = await guardedBody(c, ContextAssembleSchema);
    const assembled = assembleMemoryContext({
      db,
      projectId,
      query: body.query,
      openPaths: body.openPaths ?? body.open_paths ?? [],
      includeLineageForIds: body.includeLineageForIds ?? body.include_lineage_for_ids ?? [],
      modelContextTokens: body.modelContextTokens ?? body.model_context_tokens,
    });

    return c.json({
      success: true,
      data: {
        xml: assembled.xml,
        selected_detail_ids: assembled.selectedDetailIds,
        lineage_ids: assembled.lineageIds,
        evicted: assembled.evicted,
        compacted_index: assembled.compactedIndex,
        over_budget: assembled.overBudget,
        state: {
          turn: assembled.state.turn,
          active_detail_ids: assembled.state.activeDetails.map((detail) => detail.item.id),
        },
      },
    });
  });

  app.get("/api/proposals", (c) => {
    const statusFilter = c.req.query("status");
    const parsedStatus = statusFilter ? z.enum(PROPOSAL_STATUSES).parse(statusFilter) : undefined;
    const data = proposals(db, projectId, parsedStatus as ProposalStatus | undefined);
    return c.json({ success: true, count: data.length, data });
  });

  app.post("/api/proposals", async (c) => {
    const body = await guardedBody(c, ProposalSchema);
    const proposal = propose(db, {
      kind: body.kind,
      text: body.text,
      action: body.action,
      targetMemoryId: targetMemoryId(body),
      projectId,
      proposedBy: body.proposed_by ?? "api:http:agent",
      rationale: body.rationale,
      evidence: body.evidence,
    });
    return c.json({ success: true, data: proposal }, 201);
  });

  app.post("/api/proposals/:id/approve", async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const body = DecisionSchema.parse(guardRequestPayload({ payload: raw, surface: "api" }));
    const memory = approve(
      db,
      projectId,
      c.req.param("id"),
      actorFromDecision(body, "api:http:user"),
    );
    return c.json({
      success: true,
      message: "Proposal approved successfully",
      memory_id: memory?.id ?? null,
      data: memory ? publicMemoryItem(memory) : null,
    });
  });

  app.post("/api/proposals/:id/reject", async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const body = DecisionSchema.parse(guardRequestPayload({ payload: raw, surface: "api" }));
    const proposal = reject(
      db,
      projectId,
      c.req.param("id"),
      body.note ?? "Rejected via API",
      actorFromDecision(body, "api:http:user"),
    );
    return c.json({ success: true, message: "Proposal rejected successfully", data: proposal });
  });

  app.post("/api/links/propose", async (c) => {
    const body = await guardedBody(c, LinkProposalSchema);
    assertLinkProposalShape(body);

    if (body.proposal_type === "memory_edge") {
      const proposal = proposeMemoryEdge(db, {
        projectId,
        sourceMemoryId: body.sourceMemoryId ?? body.source_memory_id ?? "",
        targetMemoryId: body.targetMemoryId ?? body.target_memory_id ?? "",
        relation: body.relation as MemoryEdgeRelation,
        confidence: body.confidence,
        proposedBy: body.proposedBy ?? body.proposed_by ?? "api:http:agent",
        rationale: body.rationale,
        evidence: body.evidence,
      });
      return c.json({ success: true, data: proposal }, 201);
    }

    const proposal = proposeMemoryCodeLink(db, {
      projectId,
      memoryId:
        body.memoryId ?? body.memory_id ?? body.sourceMemoryId ?? body.source_memory_id ?? "",
      path: body.path ?? "",
      entityType: (body.entityType ?? body.entity_type) as CodeEntityType,
      symbol: body.symbol,
      lineStart: body.lineStart ?? body.line_start,
      lineEnd: body.lineEnd ?? body.line_end,
      fingerprint: body.fingerprint,
      relation: body.relation as CodeLinkRelation,
      confidence: body.confidence,
      proposedBy: body.proposedBy ?? body.proposed_by ?? "api:http:agent",
      rationale: body.rationale,
      evidence: body.evidence,
    });
    return c.json({ success: true, data: proposal }, 201);
  });

  app.post("/api/links/:id/approve", async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const body = DecisionSchema.parse(guardRequestPayload({ payload: raw, surface: "api" }));
    const link = approveMemoryLinkProposal(
      db,
      projectId,
      c.req.param("id"),
      actorFromDecision(body, "api:http:user"),
    );
    return c.json({
      success: true,
      message: "Link proposal approved successfully",
      link_id: link.id,
      data: link,
    });
  });

  app.post("/api/links/:id/reject", async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const body = DecisionSchema.parse(guardRequestPayload({ payload: raw, surface: "api" }));
    const proposal = rejectMemoryLinkProposal(
      db,
      projectId,
      c.req.param("id"),
      body.note ?? "Rejected via API",
      actorFromDecision(body, "api:http:user"),
    );
    return c.json({
      success: true,
      message: "Link proposal rejected successfully",
      data: proposal,
    });
  });

  return app;
}

export function createDefaultApi(): Hono {
  const config = loadConfig();
  const db = getDb(config.dbPath);
  runMigrations(db);
  return createApi({ db, projectId: config.projectId });
}

let defaultApi: Hono | null = null;

function getDefaultApi(): Hono {
  defaultApi ??= createDefaultApi();
  return defaultApi;
}

export default {
  port: Number.parseInt(process.env.PORT ?? `${CONFIG.api.defaultPort}`, 10),
  fetch(request: Request) {
    return getDefaultApi().fetch(request);
  },
};
