/**
 * Vector Embedding and Retrieval Engine (SDD-02)
 *
 * Implements binary serialization, sqlite-vec KNN retrieval, SQLite UDF
 * cosine_similarity registration for compatibility, and Reciprocal Rank Fusion
 * (RRF) hybrid retrieval.
 */

import type { Database } from "bun:sqlite";

import { CONFIG } from "../config";
import type { MemoryItem } from "../domain/schema";
import { searchMemoryFts } from "../persistence/repository";
import {
  cosineSimilarity,
  deserializeEmbedding as decEmbedding,
  serializeEmbedding as encEmbedding,
} from "./embedding";
import { DEFAULT_EMBEDDING_DIMENSIONS } from "./embedding-provider";

export { decEmbedding as deserializeEmbedding, encEmbedding as serializeEmbedding };

export interface VectorSearchResult {
  item: MemoryItem;
  similarity: number;
}

export interface HybridQueryResult {
  item: MemoryItem;
  lexicalRank: number | null;
  semanticRank: number | null;
  rrfScore: number;
}

/**
 * Registers the custom UDF 'cosine_similarity' with the given SQLite database,
 * if supported by the Bun SQLite driver version.
 * SDD-02 §3
 */
export function registerUdfCosineSimilarity(db: {
  function?: (name: string, fn: (a: unknown, b: unknown) => unknown) => void;
  register?: (name: string, fn: (a: unknown, b: unknown) => unknown) => void;
}): void {
  if (typeof db.function === "function") {
    db.function("cosine_similarity", (blobA: unknown, blobB: unknown): number | null => {
      if (!(blobA instanceof Uint8Array && blobB instanceof Uint8Array)) {
        return null;
      }
      try {
        const vecA = decEmbedding(blobA);
        const vecB = decEmbedding(blobB);
        if (vecA.length === 0 || vecA.length !== vecB.length) {
          return null;
        }
        return cosineSimilarity(vecA, vecB);
      } catch {
        return null;
      }
    });
  } else if (typeof db.register === "function") {
    db.register("cosine_similarity", (blobA: unknown, blobB: unknown): number | null => {
      if (!(blobA instanceof Uint8Array && blobB instanceof Uint8Array)) {
        return null;
      }
      try {
        const vecA = decEmbedding(blobA);
        const vecB = decEmbedding(blobB);
        if (vecA.length === 0 || vecA.length !== vecB.length) {
          return null;
        }
        return cosineSimilarity(vecA, vecB);
      } catch {
        return null;
      }
    });
  }
}

/**
 * Parses a database row into a structured MemoryItem.
 */
function rowToMemoryItem(r: Record<string, unknown>): MemoryItem {
  return {
    id: r.id as string,
    project_id: r.project_id as string,
    kind: r.kind as MemoryItem["kind"],
    text: r.text as string,
    status: r.status as MemoryItem["status"],
    visibility: r.visibility as MemoryItem["visibility"],
    confidence: r.confidence as number,
    source: r.source as string,
    content_hash: r.content_hash as string,
    evidence_json: r.evidence_json as string,
    metadata_json: r.metadata_json as string,
    embedding: r.embedding as Uint8Array | null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    expires_at: r.expires_at as string | null,
  };
}

export function vectorBackend(db: Database): "sqlite-vec" {
  if (!(db as Database & { sqliteVecLoaded?: boolean }).sqliteVecLoaded) {
    throw new Error("sqlite-vec is required for vector search but is not loaded.");
  }
  return "sqlite-vec";
}

export function sqliteVecVersion(db: Database): string {
  vectorBackend(db);
  return String((db as Database & { sqliteVecVersion?: string }).sqliteVecVersion ?? "unknown");
}

/**
 * Run a pure vector similarity search.
 * SDD-02 §3
 */
export function vectorSearch(
  db: Database,
  projectId: string,
  queryEmbedding: Float32Array,
  limit = 10,
): VectorSearchResult[] {
  vectorBackend(db);
  if (queryEmbedding.length !== DEFAULT_EMBEDDING_DIMENSIONS) {
    return [];
  }

  const queryBlob = encEmbedding(queryEmbedding);
  const rows = db
    .query(
      `
      SELECT
        mi.id, mi.project_id, mi.kind, mi.text, mi.status, mi.visibility,
        mi.confidence, mi.source, mi.content_hash, mi.evidence_json,
        mi.metadata_json, NULL AS embedding, mi.created_at, mi.updated_at,
        mi.expires_at,
        (1.0 - mv.distance) AS similarity
      FROM memory_vectors mv
      JOIN memory_items mi ON mi.rowid = mv.memory_rowid
      WHERE mv.embedding MATCH ?
        AND k = ?
        AND mv.project_id = ?
        AND mv.status = 'active'
        AND mi.project_id = ?
        AND mi.status = 'active'
      ORDER BY mv.distance ASC;
      `,
    )
    .all(queryBlob, limit, projectId, projectId) as Record<string, unknown>[];

  return rows.map((r) => ({
    item: rowToMemoryItem(r),
    similarity: r.similarity as number,
  }));
}

/**
 * Runs a hybrid query combining FTS5 lexical match and cosine similarity semantic match.
 * Fuses the results using Reciprocal Rank Fusion (RRF, k=60).
 * SDD-02 §4
 */
export function hybridRetrieve(
  db: Database,
  projectId: string,
  queryText: string | null,
  queryEmbedding: Float32Array | null,
  limit = 10,
  k = CONFIG.retrieval.rrfK,
): HybridQueryResult[] {
  if (!(queryText || queryEmbedding)) {
    return [];
  }

  const candidateLimit = Math.max(50, limit * 2);

  // 1. Run Lexical Search via FTS5
  const lexicalRows: { item: MemoryItem; rank: number }[] = [];
  if (queryText?.trim()) {
    const ftsResults = searchMemoryFts(db, projectId, queryText, candidateLimit);
    for (let i = 0; i < ftsResults.length; i++) {
      const fr = ftsResults[i];
      if (fr) {
        lexicalRows.push({ item: fr.item, rank: i + 1 });
      }
    }
  }

  // 2. Run Semantic Search via cosine similarity
  const semanticRows: { item: MemoryItem; similarity: number; rank: number }[] = [];
  if (queryEmbedding) {
    const vecResults = vectorSearch(db, projectId, queryEmbedding, candidateLimit);
    for (let i = 0; i < vecResults.length; i++) {
      const vr = vecResults[i];
      if (vr) {
        semanticRows.push({ ...vr, rank: i + 1 });
      }
    }
  }

  // Map to store combined candidate items and their rankings
  const candidateMap = new Map<
    string,
    {
      item: MemoryItem;
      lexicalRank: number | null;
      semanticRank: number | null;
    }
  >();

  // 3. Record Lexical Rank positions (1-based index)
  for (const lr of lexicalRows) {
    candidateMap.set(lr.item.id, {
      item: lr.item,
      lexicalRank: lr.rank,
      semanticRank: null,
    });
  }

  // 4. Record Semantic Rank positions (1-based index)
  for (const sr of semanticRows) {
    const id = sr.item.id;
    const existing = candidateMap.get(id);

    if (existing) {
      existing.semanticRank = sr.rank;
    } else {
      candidateMap.set(id, {
        item: sr.item,
        lexicalRank: null,
        semanticRank: sr.rank,
      });
    }
  }

  // 5. Apply Reciprocal Rank Fusion formula to all candidate entries
  const results: HybridQueryResult[] = [];

  for (const [, entry] of candidateMap.entries()) {
    let rrfScore = 0.0;

    if (entry.lexicalRank !== null) {
      rrfScore += 1.0 / (k + entry.lexicalRank);
    }
    if (entry.semanticRank !== null) {
      rrfScore += 1.0 / (k + entry.semanticRank);
    }

    results.push({
      item: entry.item,
      lexicalRank: entry.lexicalRank,
      semanticRank: entry.semanticRank,
      rrfScore: rrfScore,
    });
  }

  // 6. Sort by RRF score descending and apply requested limit
  return results.sort((a, b) => b.rrfScore - a.rrfScore).slice(0, limit);
}
