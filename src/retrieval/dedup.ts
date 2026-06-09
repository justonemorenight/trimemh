import { createHash } from "node:crypto";

import type { MemoryItem } from "../domain/schema";
import { cosineSimilarity } from "./embedding";

// ─── Hash-based exact dedup (unchanged) ───────────────────────────

// Hash a text string using standard SHA-256.
export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Normalize text before hashing: trim whitespace, collapse newlines.
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Compute content hash for storage.
export function contentHash(text: string): string {
  return hashText(normalizeText(text));
}

// ─── Semantic dedup (SDD-06) ──────────────────────────────────────

/**
 * Default cosine-similarity threshold for near-duplicate detection.
 * Memories whose embeddings score ≥ this value are considered semantic
 * near-duplicates and should be merged rather than duplicated.
 *
 * Chosen per PLAN_EVALUATION.md §1.1: 0.90 is the widely-used threshold
 * for "same meaning, different wording" in production memory systems.
 *
 * For per-kind thresholds, see KIND_DEDUP_THRESHOLDS below.
 */
export const SEMANTIC_DEDUP_THRESHOLD = 0.9;

/**
 * Minimum embedding dimension for semantic dedup to be reliable.
 *
 * Low-dimensional vectors (e.g. 4-dim test fixtures) have artificially
 * high cosine similarity by random chance.  Real embedding models
 * produce ≥ 384 dimensions where vectors are reliably orthogonal when
 * semantically different.  Skipping low-dim embeddings prevents false
 * positive merges while having zero impact on production workloads.
 */
export const SEMANTIC_DEDUP_MIN_DIMENSION = 128;

/**
 * Per-kind semantic dedup thresholds (P1 — Intelligence Upgrade).
 *
 * Different memory kinds have different tolerance for near-duplicate
 * merging. A security rule being falsely merged is dangerous (high cost
 * of false positive), while a preference being re-stated with slightly
 * different wording is harmless (low cost of false negative).
 *
 * Strategy:
 *   critical risk (security_rule, trade_rule)  → 0.95 (very strict)
 *   high risk (procedure, mistake)             → 0.92 (strict)
 *   medium risk (decision, code_context, session_summary) → 0.88
 *   low risk (preference, fact)                → 0.85 (lenient)
 *
 * These thresholds are used INSTEAD of SEMANTIC_DEDUP_THRESHOLD
 * when the kind of the EXISTING candidate is known.
 */
export const KIND_DEDUP_THRESHOLDS: Record<string, number> = {
  security_rule: 0.95, // false merge = security breach
  trade_rule: 0.95, // false merge = financial risk
  procedure: 0.92, // procedures need exact matching
  mistake: 0.92, // mistakes need context preserved
  decision: 0.88, // decisions can be reaffirmed with variation
  code_context: 0.88, // code context varies by file/function
  session_summary: 0.85, // session summaries naturally overlap
  tooling: 0.85,
  preference: 0.85, // preferences are re-stated with variation
  fact: 0.88, // facts should be reasonably precise
};

/**
 * Get the dedup threshold for a specific memory kind.
 * Falls back to SEMANTIC_DEDUP_THRESHOLD for unknown kinds.
 */
export function dedupThresholdForKind(kind: string): number {
  return KIND_DEDUP_THRESHOLDS[kind] ?? SEMANTIC_DEDUP_THRESHOLD;
}

/** A near-duplicate match returned by findSemanticDuplicates. */
export interface NearDuplicate {
  /** The existing memory that the query embedding is near-duplicate of. */
  existing: MemoryItem;
  /** Cosine similarity score in [0.0, 1.0]. */
  similarity: number;
}

/**
 * Scan a set of candidate embeddings for near-duplicates of the query
 * embedding.  Returns matches sorted by similarity descending so the
 * caller can pick the best (highest-similarity) merge target.
 *
 * Candidates whose embedding dimension doesn't match the query are
 * silently skipped (different embedding model → not comparable).
 */
export function findSemanticDuplicates(
  queryEmbedding: Float32Array,
  candidates: Array<{ item: MemoryItem; embedding: Float32Array }>,
  threshold: number = SEMANTIC_DEDUP_THRESHOLD,
): NearDuplicate[] {
  // Low-dimension guard: skip semantic dedup for embeddings too small
  // to produce reliable cosine-similarity comparisons (see constant doc).
  if (queryEmbedding.length < SEMANTIC_DEDUP_MIN_DIMENSION) {
    return [];
  }

  const results: NearDuplicate[] = [];
  for (const c of candidates) {
    if (c.embedding.length !== queryEmbedding.length) {
      continue;
    }
    const sim = cosineSimilarity(queryEmbedding, c.embedding);
    if (sim >= threshold) {
      results.push({ existing: c.item, similarity: sim });
    }
  }
  return results.sort((a, b) => b.similarity - a.similarity);
}
