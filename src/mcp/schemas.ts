// MCP tool input schemas.
// Shared validation core lives in domain/schemas.ts.
// MCP-specific limits and field conventions are applied here.

import { z } from "zod";

import { CONFIG } from "../config";
import {
  ApproveSchema,
  CodeImpactSchema,
  CodeSearchSchema,
  ContextSchema,
  FeedbackSchema,
  GetSchema,
  ListProposalsSchema,
  MemoryCodeLinkProposeSchema,
  MemoryLinkProposeSchema,
  ProposeSchema,
  RejectSchema,
  RelatedSchema,
  RetrieveSchema,
} from "../domain/schemas";

// ─── MCP-specific Search schema (tighter limit than REST API) ──────

export const SearchInputSchema = z.object({
  query: z.string().max(CONFIG.zod.maxQueryLength).describe("Search query text"),
  kind: z.string().optional().describe("Filter by memory kind"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(CONFIG.mcp.maxSearchLimitSchema)
    .default(CONFIG.mcp.defaultSearchLimit)
    .describe(
      `Max results (1-${CONFIG.mcp.maxSearchLimitSchema}, server-capped at ${CONFIG.mcp.maxSearchResults})`,
    ),
  mode: z
    .enum(["fts", "vector", "hybrid"])
    .default("fts")
    .describe("Search mode: fts (full-text), vector (embedding similarity), hybrid (RRF fusion)"),
  embedding: z
    .array(z.number())
    .optional()
    .describe("Query embedding vector for vector/hybrid modes"),
});

// ─── Re-exports (no MCP-specific overrides needed) ─────────────────

export {
  ApproveSchema,
  CodeImpactSchema as CodeImpactInputSchema,
  CodeSearchSchema as CodeSearchInputSchema,
  ContextSchema as ContextInputSchema,
  FeedbackSchema as FeedbackInputSchema,
  GetSchema as GetInputSchema,
  ListProposalsSchema,
  MemoryCodeLinkProposeSchema as MemoryCodeLinkProposeInputSchema,
  MemoryLinkProposeSchema as MemoryLinkProposeInputSchema,
  ProposeSchema as ProposeInputSchema,
  RejectSchema,
  RelatedSchema as RelatedInputSchema,
  RetrieveSchema as RetrieveInputSchema,
};
