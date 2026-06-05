import { z } from "zod";

import { guardString } from "../infrastructure/guardrail";
import { MAX_STRING_BYTES } from "../infrastructure/sanitize";

export const SearchInputSchema = z.object({
  query: z
    .string()
    .max(2000)
    .refine(
      (s) => {
        try {
          guardString(s, "query");
          return true;
        } catch {
          return false;
        }
      },
      {
        message: `"query" exceeds maximum size of ${MAX_STRING_BYTES} bytes`,
      },
    )
    .describe("Search query text"),
  kind: z.string().optional().describe("Filter by memory kind"),
  limit: z.number().min(1).max(20).default(10).describe("Max results (1-20, server-capped at 5)"),
  mode: z
    .enum(["fts", "vector", "hybrid"])
    .default("fts")
    .describe("Search mode: fts (full-text), vector (embedding similarity), hybrid (RRF fusion)"),
  embedding: z
    .array(z.number())
    .optional()
    .describe("Query embedding vector for vector/hybrid modes"),
});

export const ProposeInputSchema = z.object({
  kind: z
    .string()
    .describe(
      "Memory kind: preference, fact, decision, session_summary, code_context, procedure, mistake, trade_rule, security_rule",
    ),
  text: z
    .string()
    .min(1)
    .refine(
      (s) => {
        try {
          guardString(s, "text");
          return true;
        } catch {
          return false;
        }
      },
      {
        message: `"text" exceeds maximum size of ${MAX_STRING_BYTES} bytes`,
      },
    )
    .describe("Proposed memory text (max 10 KB)"),
  rationale: z
    .string()
    .optional()
    .refine(
      (s) => {
        if (s === undefined) {
          return true;
        }
        try {
          guardString(s, "rationale");
          return true;
        } catch {
          return false;
        }
      },
      {
        message: `"rationale" exceeds maximum size of ${MAX_STRING_BYTES} bytes`,
      },
    )
    .describe("Why this memory should exist"),
});

export const GetInputSchema = z.object({
  id: z.string().max(256).describe("Memory ID"),
});

export const RelatedInputSchema = z.object({
  id: z.string().max(256).describe("Memory ID"),
  depth: z.number().min(1).max(2).default(1).describe("Traversal depth, capped at 2"),
});

export const MemoryLinkProposeInputSchema = z.object({
  source_memory_id: z.string().max(256).describe("Source memory ID"),
  relation: z
    .string()
    .describe("supports, contradicts, depends_on, derived_from, supersedes, relates_to"),
  target_memory_id: z.string().max(256).describe("Target memory ID"),
  rationale: z
    .string()
    .optional()
    .refine(
      (s) => {
        if (s === undefined) {
          return true;
        }
        try {
          guardString(s, "rationale");
          return true;
        } catch {
          return false;
        }
      },
      {
        message: `"rationale" exceeds maximum size of ${MAX_STRING_BYTES} bytes`,
      },
    )
    .describe("Why this link should exist"),
  confidence: z.number().min(0).max(1).default(0.5).describe("Confidence 0-1"),
});

export const MemoryCodeLinkProposeInputSchema = z.object({
  memory_id: z.string().max(256).describe("Memory ID"),
  path: z
    .string()
    .min(1)
    .refine(
      (s) => {
        try {
          guardString(s, "path");
          return true;
        } catch {
          return false;
        }
      },
      {
        message: `"path" exceeds maximum size of ${MAX_STRING_BYTES} bytes`,
      },
    )
    .describe("Code file path"),
  relation: z
    .string()
    .default("relates_to")
    .describe("relates_to, documents, warns_about, implements, depends_on"),
  entity_type: z.string().default("file").describe("file, function, class, module, section"),
  symbol: z.string().max(512).optional().describe("Function/class/module symbol"),
  line_start: z.number().int().optional().describe("Start line"),
  line_end: z.number().int().optional().describe("End line"),
  fingerprint: z.string().max(256).optional().describe("Code fingerprint/hash"),
  rationale: z
    .string()
    .optional()
    .refine(
      (s) => {
        if (s === undefined) {
          return true;
        }
        try {
          guardString(s, "rationale");
          return true;
        } catch {
          return false;
        }
      },
      {
        message: `"rationale" exceeds maximum size of ${MAX_STRING_BYTES} bytes`,
      },
    )
    .describe("Why this link should exist"),
  confidence: z.number().min(0).max(1).default(0.5).describe("Confidence 0-1"),
});

export const CodeSearchInputSchema = z.object({
  path: z.string().min(1).max(1024).describe("Code file path"),
  symbol: z.string().max(512).optional().describe("Function/class/module symbol"),
});

export const RetrieveInputSchema = z.object({
  memory_id: z
    .string()
    .max(256)
    .describe("Memory ID to retrieve full text for (from a deferred/compressed detail)"),
});

export const FeedbackInputSchema = z.object({
  memory_id: z.string().max(256).describe("Memory ID to provide feedback for"),
  useful: z.boolean().describe("Whether this memory was useful for the current task"),
  reason: z
    .string()
    .max(500)
    .optional()
    .describe("Why it was (not) useful — helps improve future retrieval"),
});

export const ContextInputSchema = z.object({
  query: z
    .string()
    .max(2000)
    .optional()
    .refine(
      (s) => {
        if (s === undefined) {
          return true;
        }
        try {
          guardString(s, "query");
          return true;
        } catch {
          return false;
        }
      },
      {
        message: `"query" exceeds maximum size of ${MAX_STRING_BYTES} bytes`,
      },
    )
    .describe("Current user/agent task text used for semantic and operational memory triggers"),
  open_paths: z
    .array(z.string().max(1024))
    .default([])
    .describe("Open code file paths used for code-linked memory triggers"),
  include_lineage_for_ids: z
    .array(z.string().max(256))
    .default([])
    .describe("Memory IDs whose one-turn lineage/audit context should be included"),
  model_context_tokens: z
    .number()
    .int()
    .min(1000)
    .max(1000000)
    .default(32000)
    .describe("Model context window tokens; memory context is capped to 10%"),
});
