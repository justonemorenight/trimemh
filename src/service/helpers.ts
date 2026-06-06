import type { Database } from "bun:sqlite";

import type { MemoryItem } from "../domain/schema";
import { CONFIG } from "../config";
import { audit, embeddingForText, guardedPayload, json, now } from "../application/service-helpers";
import { getMemoriesWithEmbeddings } from "../persistence/repository";
import {
  SEMANTIC_DEDUP_THRESHOLD,
  dedupThresholdForKind,
  findSemanticDuplicates,
} from "../retrieval/dedup";
import { mergeMemoryEvidence } from "../persistence/repository";

// ─── Validation helpers ──────────────────────────────────────────

export function requireRationaleForRelation(relation: string, rationale?: string | null): void {
  if (["contradicts", "supersedes", "depends_on"].includes(relation) && !rationale?.trim()) {
    throw new Error(`Relation "${relation}" requires a non-empty rationale.`);
  }
}

export function assertMemoryInProject(
  item: MemoryItem | null,
  projectId: string,
  id: string,
): MemoryItem {
  if (!item) {
    throw new Error(`Memory "${id}" not found.`);
  }
  if (item.project_id !== projectId) {
    throw new Error(`Memory "${id}" belongs to a different project.`);
  }
  return item;
}

export function normalizeDepth(depth = 1): number {
  return Math.max(1, Math.min(depth, CONFIG.service.maxGraphDepth));
}

// ─── Code entity key ─────────────────────────────────────────────

export function codeEntityKey(input: {
  path: string;
  entityType: string;
  symbol?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
}): string {
  return [
    input.path,
    input.entityType,
    input.symbol ?? "",
    input.lineStart ?? "",
    input.lineEnd ?? "",
  ].join("#");
}

// ─── Batch dedup helpers ─────────────────────────────────────────

export function candidatesForProject(
  db: Database,
  candidatesByProject: Map<string, Array<{ item: MemoryItem; embedding: Float32Array }>>,
  projectId: string,
): Array<{ item: MemoryItem; embedding: Float32Array }> {
  let candidates = candidatesByProject.get(projectId);
  if (!candidates) {
    candidates = getMemoriesWithEmbeddings(db, projectId);
    candidatesByProject.set(projectId, candidates);
  }
  return candidates;
}

export function dedupCheckAndMergeBatch(
  db: Database,
  projectId: string,
  embedding: Float32Array,
  batchState: {
    semanticCandidatesByProject: Map<string, Array<{ item: MemoryItem; embedding: Float32Array }>>;
  },
  newData: {
    text: string;
    kind: string;
    source: string;
    confidence: number;
    evidenceJson: string;
  },
): MemoryItem | null {
  const candidates = candidatesForProject(db, batchState.semanticCandidatesByProject, projectId);
  if (candidates.length === 0) {
    return null;
  }

  const dups = findSemanticDuplicates(embedding, candidates, 0.85);
  const best = dups.find((d) => d.similarity >= dedupThresholdForKind(d.existing.kind));
  if (!best) {
    return null;
  }

  const kindThreshold = dedupThresholdForKind(best.existing.kind);
  const merged = mergeMemoryEvidence(
    db,
    best.existing.id,
    newData.evidenceJson,
    newData.confidence,
    newData.source,
  );
  audit(db, projectId, newData.source, "memory_merged", "memory_item", best.existing.id, {
    similarity: best.similarity,
    threshold_used: kindThreshold,
    default_threshold: SEMANTIC_DEDUP_THRESHOLD,
    merged_text_preview: newData.text.slice(0, 100),
    merged_kind: newData.kind,
    existing_kind: best.existing.kind,
  });

  const candidate = candidates.find((c) => c.item.id === merged.id);
  if (candidate) {
    candidate.item = merged;
  }

  return merged;
}

// Re-export commonly needed helpers from service-helpers
export { audit, embeddingForText, guardedPayload, json, now };
