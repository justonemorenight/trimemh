import { z } from "zod";

import { CONFIG } from "../config";
import { guardString } from "../infrastructure/guardrail";
import {
  CODE_ENTITY_TYPES,
  CODE_LINK_RELATIONS,
  EvidenceSchema,
  MEMORY_EDGE_RELATIONS,
  MEMORY_KINDS,
  PROPOSAL_ACTIONS,
  PROPOSAL_STATUSES,
  VISIBILITY,
} from "./schema";

// ─── Shared validation primitives ──────────────────────────────────

/** Refine that validates a string is under the guardrail byte limit. */
function safeString(maxBytes: number) {
  return z.string().refine(
    (s) => {
      try {
        guardString(s, "value");
        return true;
      } catch {
        return false;
      }
    },
    { message: `String exceeds maximum size of ${maxBytes} bytes` },
  );
}

const idField = z.string().max(CONFIG.zod.maxLineageIds);
const pathField = z.string().min(1).max(CONFIG.zod.maxPathLength);
const symbolField = z.string().max(CONFIG.zod.maxSymbolLength);
const confidenceField = z.number().min(0).max(1);
const rationaleField = safeString(CONFIG.guardrails.maxStringBytes).optional();
const maxText = safeString(CONFIG.guardrails.maxStringBytes);

// ─── memory_search / recall ────────────────────────────────────────

export const SearchSchema = z.object({
  query: z.string().max(CONFIG.zod.maxQueryLength).describe("Search query text"),
  kind: z.string().optional().describe("Filter by memory kind"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(CONFIG.api.maxListLimit)
    .default(CONFIG.api.defaultListLimit)
    .describe(`Max results (1-${CONFIG.api.maxListLimit})`),
  mode: z
    .enum(["fts", "vector", "hybrid"])
    .default("fts")
    .describe("Search mode: fts (full-text), vector (embedding similarity), hybrid (RRF fusion)"),
  embedding: z.array(z.number()).optional().describe("Query embedding vector"),
});

export type SearchInput = z.infer<typeof SearchSchema>;

// ─── memory_propose ────────────────────────────────────────────────

export const ProposeSchema = z.object({
  kind: z.enum(MEMORY_KINDS).describe(`Memory kind: ${MEMORY_KINDS.join(", ")}`),
  text: z
    .string()
    .min(1)
    .max(CONFIG.zod.maxMemoryText)
    .pipe(maxText)
    .describe("Proposed memory text"),
  action: z.enum(PROPOSAL_ACTIONS).default("create").describe("Proposal action"),
  target_memory_id: idField.optional().describe("Target memory ID (for update/delete)"),
  proposed_by: z
    .string()
    .min(1)
    .max(CONFIG.zod.maxEntityLength)
    .optional()
    .describe("Who proposed"),
  rationale: rationaleField.describe("Why this memory should exist"),
  require_review: z
    .boolean()
    .optional()
    .default(false)
    .describe("Force manual review even when auto-approve would apply"),
  auto_approve: z
    .boolean()
    .optional()
    .describe("Request immediate approval when risk level allows (overrides default pending)"),
  confidence: confidenceField.optional().describe("Confidence score (0-1)"),
  evidence: z.array(EvidenceSchema).optional().describe("Supporting evidence"),
});

export type ProposeInput = z.infer<typeof ProposeSchema>;

// ─── memory_get ────────────────────────────────────────────────────

export const GetSchema = z.object({
  id: idField.describe("Memory ID"),
});

// ─── memory_related ────────────────────────────────────────────────

export const RelatedSchema = z.object({
  id: idField.describe("Memory ID"),
  depth: z
    .number()
    .int()
    .min(1)
    .max(CONFIG.service.maxGraphDepth)
    .default(1)
    .describe("Traversal depth"),
});

// ─── memory_link_propose ───────────────────────────────────────────

export const MemoryLinkProposeSchema = z.object({
  source_memory_id: idField.describe("Source memory ID"),
  relation: z.enum(MEMORY_EDGE_RELATIONS).describe(MEMORY_EDGE_RELATIONS.join(", ")),
  target_memory_id: idField.describe("Target memory ID"),
  rationale: rationaleField.describe("Why this link should exist"),
  confidence: confidenceField.default(0.5).describe("Confidence 0-1"),
  require_review: z
    .boolean()
    .optional()
    .default(false)
    .describe("Set to true to bypass auto-approve"),
});

// ─── memory_code_link_propose ──────────────────────────────────────

export const MemoryCodeLinkProposeSchema = z.object({
  memory_id: idField.describe("Memory ID"),
  path: pathField.describe("Code file path"),
  relation: z
    .enum(CODE_LINK_RELATIONS)
    .default("relates_to")
    .describe(CODE_LINK_RELATIONS.join(", ")),
  entity_type: z.enum(CODE_ENTITY_TYPES).default("file").describe(CODE_ENTITY_TYPES.join(", ")),
  symbol: symbolField.optional().describe("Function/class/module symbol"),
  line_start: z.number().int().optional().describe("Start line"),
  line_end: z.number().int().optional().describe("End line"),
  fingerprint: z
    .string()
    .max(CONFIG.zod.maxFingerprintLength)
    .optional()
    .describe("Code fingerprint/hash"),
  rationale: rationaleField.describe("Why this link should exist"),
  confidence: confidenceField.default(0.5).describe("Confidence 0-1"),
  require_review: z
    .boolean()
    .optional()
    .default(false)
    .describe("Set to true to bypass auto-approve"),
});

// ─── memory_code_search ────────────────────────────────────────────

export const CodeSearchSchema = z.object({
  path: pathField.describe("Code file path"),
  symbol: symbolField.optional().describe("Function/class/module symbol"),
});

// ─── memory_code_impact ────────────────────────────────────────────

export const CodeImpactSchema = z.object({
  path: pathField.describe("Code file path"),
  symbol: symbolField.optional().describe("Optional function/class/module symbol"),
  depth: z.number().int().min(1).max(2).default(1).describe("Memory graph traversal depth"),
});

// ─── memory_retrieve ───────────────────────────────────────────────

export const RetrieveSchema = z.object({
  memory_id: idField.describe("Memory ID to retrieve full text for (CCR deferred detail)"),
});

// ─── memory_feedback ───────────────────────────────────────────────

export const FeedbackSchema = z.object({
  memory_id: idField.describe("Memory ID to provide feedback for"),
  useful: z.boolean().describe("Whether this memory was useful for the current task"),
  reason: z
    .string()
    .max(CONFIG.zod.maxMemoryRationale)
    .optional()
    .describe("Why it was (not) useful"),
});

// ─── memory_context ────────────────────────────────────────────────

export const ContextSchema = z.object({
  query: safeString(CONFIG.guardrails.maxStringBytes)
    .optional()
    .describe("Current user/agent task for semantic memory triggers"),
  open_paths: z
    .array(pathField)
    .default([])
    .describe("Open code file paths for code-linked memory triggers"),
  include_lineage_for_ids: z
    .array(idField)
    .default([])
    .describe("Memory IDs whose lineage/audit context should be included"),
  model_context_tokens: z
    .number()
    .int()
    .min(CONFIG.context.minModelTokens)
    .max(CONFIG.context.maxModelTokens)
    .default(CONFIG.context.defaultModelTokens)
    .describe("Model context window tokens; memory context is capped to 10%"),
});

export type ContextInput = z.infer<typeof ContextSchema>;

// ─── memory_list_proposals ─────────────────────────────────────────

export const ListProposalsSchema = z.object({
  status: z.enum(PROPOSAL_STATUSES).default("pending").describe("Filter proposals by status"),
  limit: z.number().int().min(1).max(50).default(20).describe("Max proposals to return"),
});

// ─── memory_approve ────────────────────────────────────────────────

export const ApproveSchema = z.object({
  proposal_id: idField.describe("Proposal ID to approve (full UUID or prefix)"),
  decided_by: z.string().min(1).max(CONFIG.zod.maxEntityLength).optional().describe("Who decided"),
  note: z.string().max(CONFIG.zod.maxMemoryRationale).optional().describe("Optional note"),
});

// ─── memory_reject ─────────────────────────────────────────────────

export const RejectSchema = z.object({
  proposal_id: idField.describe("Proposal ID to reject (full UUID or prefix)"),
  note: z.string().max(CONFIG.zod.maxMemoryRationale).optional().describe("Reason for rejection"),
  decided_by: z.string().min(1).max(CONFIG.zod.maxEntityLength).optional().describe("Who decided"),
});

// ─── remember (direct write, CLI / API) ────────────────────────────

export const RememberSchema = z.object({
  kind: z.enum(MEMORY_KINDS),
  text: z.string().min(1).max(CONFIG.zod.maxMemoryText).pipe(maxText),
  confidence: confidenceField.optional(),
  visibility: z.enum(VISIBILITY).optional(),
  evidence: z.array(EvidenceSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.string().datetime().optional(),
});

// ─── link proposal (API unified endpoint) ──────────────────────────

export const LinkProposalSchema = z.object({
  proposal_type: z.enum(["memory_edge", "memory_code_link"]),
  // memory_edge fields
  source_memory_id: idField.optional(),
  target_memory_id: idField.optional(),
  // memory_code_link fields
  memory_id: idField.optional(),
  entity_type: z.enum(CODE_ENTITY_TYPES).optional(),
  path: pathField.optional(),
  symbol: symbolField.optional(),
  line_start: z.number().int().optional(),
  line_end: z.number().int().optional(),
  fingerprint: z.string().max(CONFIG.zod.maxFingerprintLength).optional(),
  // common
  relation: z.string().min(1).max(CONFIG.zod.maxRelationLength),
  confidence: confidenceField.optional(),
  proposed_by: z.string().min(1).max(CONFIG.zod.maxEntityLength).optional(),
  rationale: z.string().max(CONFIG.zod.maxMemoryRationale).optional(),
  evidence: z.array(EvidenceSchema).optional(),
});

// ─── decision (generic approve/reject payload) ─────────────────────

export const DecisionSchema = z.object({
  decided_by: z.string().min(1).max(CONFIG.zod.maxEntityLength).optional(),
  note: z.string().max(CONFIG.zod.maxMemoryRationale).optional(),
});

export type DecisionInput = z.infer<typeof DecisionSchema>;

// ─── memory_session_close ──────────────────────────────────────────

export const SessionCloseSchema = z.object({
  summary: z
    .string()
    .min(1)
    .max(CONFIG.zod.maxMemoryText)
    .pipe(maxText)
    .describe("What happened this turn/session"),
  files: z.array(pathField).optional().describe("Files touched"),
  commands: z.array(z.string().max(200)).optional().describe("Notable commands run"),
  decisions: z
    .array(safeString(CONFIG.guardrails.maxStringBytes))
    .optional()
    .describe("Product/engineering decisions made"),
  tooling: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        files: z.array(pathField).optional(),
        note: z.string().max(CONFIG.zod.maxMemoryRationale).optional(),
      }),
    )
    .optional()
    .describe("Tooling/setup changes (Biome, Tailwind, etc.)"),
  handoff_notes: z.string().max(CONFIG.zod.maxMemoryRationale).optional(),
  session_id: z.string().max(CONFIG.zod.maxEntityLength).optional(),
  auto_approve: z
    .boolean()
    .optional()
    .default(true)
    .describe("Auto-approve created memories when risk allows"),
});

export type SessionCloseInput = z.infer<typeof SessionCloseSchema>;
