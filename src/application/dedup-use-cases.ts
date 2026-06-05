import type { Database } from "bun:sqlite";

import type { MemoryItem } from "../domain/schema";
import {
  deleteMemoryItem,
  getMemoriesWithEmbeddings,
  getMemoryById,
  mergeMemoryEvidence,
} from "../persistence/repository";
import {
  SEMANTIC_DEDUP_MIN_DIMENSION,
  SEMANTIC_DEDUP_THRESHOLD,
  contentHash,
  dedupThresholdForKind,
  findSemanticDuplicates,
} from "../retrieval/dedup";
import { cosineSimilarity } from "../retrieval/embedding";
import { audit } from "./service-helpers";

export interface DedupReport {
  projectId: string;
  threshold: number;
  pairs: Array<{
    memoryA: { id: string; kind: string; text: string };
    memoryB: { id: string; kind: string; text: string };
    similarity: number;
  }>;
  totalMemoriesWithEmbeddings: number;
}

function assertMemoryInProject(item: MemoryItem | null, projectId: string, id: string): MemoryItem {
  if (!item) {
    throw new Error(`Memory "${id}" not found.`);
  }
  if (item.project_id !== projectId) {
    throw new Error(`Memory "${id}" belongs to a different project.`);
  }
  return item;
}

export function exactContentHash(text: string): string {
  return contentHash(text);
}

/**
 * Check whether a new memory embedding is a near-duplicate of an active memory.
 * If so, merge evidence into the existing memory and return that memory.
 */
export function dedupCheckAndMerge(
  db: Database,
  projectId: string,
  embedding: Float32Array,
  newData: {
    text: string;
    kind: string;
    source: string;
    confidence: number;
    evidenceJson: string;
  },
): MemoryItem | null {
  if (embedding.length < SEMANTIC_DEDUP_MIN_DIMENSION) {
    return null;
  }

  const candidates = getMemoriesWithEmbeddings(db, projectId);
  if (candidates.length === 0) {
    return null;
  }

  const scanThreshold = 0.85;
  const dups = findSemanticDuplicates(embedding, candidates, scanThreshold);
  const kindFiltered = dups.filter((d) => {
    const kindThreshold = dedupThresholdForKind(d.existing.kind);
    return d.similarity >= kindThreshold;
  });
  if (kindFiltered.length === 0) {
    return null;
  }

  const best = kindFiltered[0];
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

  return merged;
}

/**
 * Scan all active memories with embeddings in a project and report duplicate pairs.
 */
export function dedupScan(
  db: Database,
  projectId: string,
  threshold: number = SEMANTIC_DEDUP_THRESHOLD,
): DedupReport {
  const candidates = getMemoriesWithEmbeddings(db, projectId);
  const pairs: DedupReport["pairs"] = [];
  const seen = new Set<string>();

  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i];
    if (!a) {
      continue;
    }
    for (let j = i + 1; j < candidates.length; j++) {
      const b = candidates[j];
      if (!b) {
        continue;
      }
      if (a.embedding.length !== b.embedding.length) {
        continue;
      }

      const sim = cosineSimilarity(a.embedding, b.embedding);
      if (sim >= threshold) {
        const key = [a.item.id, b.item.id].sort().join("::");
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        pairs.push({
          memoryA: {
            id: a.item.id,
            kind: a.item.kind,
            text: a.item.text.slice(0, 120),
          },
          memoryB: {
            id: b.item.id,
            kind: b.item.kind,
            text: b.item.text.slice(0, 120),
          },
          similarity: Math.round(sim * 10_000) / 10_000,
        });
      }
    }
  }

  return {
    projectId,
    threshold,
    pairs: pairs.sort((a, b) => b.similarity - a.similarity),
    totalMemoriesWithEmbeddings: candidates.length,
  };
}

/**
 * Merge a source memory into a target memory by transferring evidence,
 * then delete the source memory.
 */
export function dedupMerge(
  db: Database,
  projectId: string,
  sourceId: string,
  targetId: string,
): MemoryItem {
  const source = assertMemoryInProject(getMemoryById(db, sourceId), projectId, sourceId);
  assertMemoryInProject(getMemoryById(db, targetId), projectId, targetId);

  const merged = mergeMemoryEvidence(
    db,
    targetId,
    source.evidence_json,
    source.confidence,
    "dedup:merge",
  );

  deleteMemoryItem(db, sourceId);

  audit(db, projectId, "dedup:merge", "memory_dedup_merged", "memory_item", targetId, {
    deleted_source_id: sourceId,
    deleted_text_preview: source.text.slice(0, 100),
  });

  return merged;
}
