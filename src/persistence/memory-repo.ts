import type { Database, SQLQueryBindings } from "bun:sqlite";

import type { MemoryItem, RecallResult } from "../domain/schema";
import { deserializeEmbedding } from "../retrieval/embedding";
import {
  MEMORY_COLUMNS_WITHOUT_EMBEDDING,
  MEMORY_COLUMNS_WITH_EMBEDDING,
  rowToMemoryItem,
} from "./repository-mappers";

// ─── Memory Items CRUD ────────────────────────────────────────────

export function insertMemoryItem(db: Database, item: MemoryItem): MemoryItem {
  db.run(
    `INSERT INTO memory_items (
      id, project_id, kind, text, status, visibility, confidence,
      source, content_hash, evidence_json, metadata_json,
      embedding, created_at, updated_at, expires_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?
    );`,
    [
      item.id,
      item.project_id,
      item.kind,
      item.text,
      item.status,
      item.visibility,
      item.confidence,
      item.source,
      item.content_hash,
      item.evidence_json,
      item.metadata_json,
      item.embedding,
      item.created_at,
      item.updated_at,
      item.expires_at,
    ],
  );
  return item;
}

export function getMemoryById(
  db: Database,
  id: string,
  withEmbedding?: boolean,
): MemoryItem | null {
  const cols = withEmbedding ? MEMORY_COLUMNS_WITH_EMBEDDING : MEMORY_COLUMNS_WITHOUT_EMBEDDING;
  const row = db.query(`SELECT ${cols} FROM memory_items WHERE id = ?;`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    return null;
  }
  return rowToMemoryItem(row);
}

export function findMemoryByHash(
  db: Database,
  projectId: string,
  contentHash: string,
): MemoryItem | null {
  const row = db
    .query(
      `SELECT ${MEMORY_COLUMNS_WITHOUT_EMBEDDING}
       FROM memory_items
       WHERE project_id = ? AND content_hash = ?;`,
    )
    .get(projectId, contentHash) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return rowToMemoryItem(row);
}

export function updateMemoryItem(db: Database, item: MemoryItem): MemoryItem {
  db.run(
    `UPDATE memory_items SET
      kind = ?, text = ?, status = ?,
      visibility = ?, confidence = ?,
      source = ?, content_hash = ?,
      evidence_json = ?, metadata_json = ?, embedding = ?,
      updated_at = ?, expires_at = ?
    WHERE id = ?;`,
    [
      item.kind,
      item.text,
      item.status,
      item.visibility,
      item.confidence,
      item.source,
      item.content_hash,
      item.evidence_json,
      item.metadata_json,
      item.embedding,
      item.updated_at,
      item.expires_at,
      item.id,
    ],
  );
  return item;
}

export function deleteMemoryItem(db: Database, id: string): boolean {
  const result = db.run("DELETE FROM memory_items WHERE id = ?;", [id]);
  return result.changes > 0;
}

export function listMemoryItems(
  db: Database,
  projectId: string,
  opts?: {
    kind?: string;
    status?: string;
    limit?: number;
    offset?: number;
  },
): MemoryItem[] {
  let sql = `SELECT ${MEMORY_COLUMNS_WITHOUT_EMBEDDING} FROM memory_items WHERE project_id = ?`;
  const params: SQLQueryBindings[] = [projectId];

  if (opts?.kind) {
    sql += " AND kind = ?";
    params.push(opts.kind);
  }
  if (opts?.status) {
    sql += " AND status = ?";
    params.push(opts.status);
  }

  sql += " ORDER BY created_at DESC";

  if (opts?.limit) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }
  if (opts?.offset) {
    sql += " OFFSET ?";
    params.push(opts.offset);
  }

  const rows = db.query(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToMemoryItem);
}

// ─── Semantic dedup helpers ────────────────────────────────────────

export function getMemoriesWithEmbeddings(
  db: Database,
  projectId: string,
  excludeId?: string,
): Array<{ item: MemoryItem; embedding: Float32Array }> {
  let sql = `SELECT ${MEMORY_COLUMNS_WITH_EMBEDDING} FROM memory_items
    WHERE project_id = ? AND status = 'active'
    AND embedding IS NOT NULL AND length(embedding) > 0`;
  const params: SQLQueryBindings[] = [projectId];
  if (excludeId) {
    sql += " AND id != ?";
    params.push(excludeId);
  }

  const rows = db.query(sql).all(...params) as Record<string, unknown>[];
  const results: Array<{ item: MemoryItem; embedding: Float32Array }> = [];
  for (const r of rows) {
    const blob = r.embedding as Uint8Array | null;
    if (!blob || blob.length === 0) {
      continue;
    }
    try {
      const emb = deserializeEmbedding(blob);
      results.push({ item: rowToMemoryItem(r), embedding: emb });
    } catch {
      // Corrupt embedding — skip this candidate
    }
  }
  return results;
}

export function mergeMemoryEvidence(
  db: Database,
  existingId: string,
  newEvidenceJson: string,
  newConfidence: number,
  newSource: string,
): MemoryItem {
  const existing = getMemoryById(db, existingId, true);
  if (!existing) {
    throw new Error(`Memory "${existingId}" not found.`);
  }

  const existingEvidence: Array<{ source: string; reference: string; note?: string }> = JSON.parse(
    existing.evidence_json,
  );
  const newEvidence: Array<{ source: string; reference: string; note?: string }> =
    JSON.parse(newEvidenceJson);

  const seen = new Set(existingEvidence.map((e) => `${e.source}::${e.reference}`));
  for (const e of newEvidence) {
    const key = `${e.source}::${e.reference}`;
    if (!seen.has(key)) {
      existingEvidence.push(e);
      seen.add(key);
    }
  }

  existing.evidence_json = JSON.stringify(existingEvidence);
  existing.confidence = Math.max(existing.confidence, newConfidence);
  existing.updated_at = new Date().toISOString();

  const meta: Record<string, unknown> = JSON.parse(existing.metadata_json);
  if (!(meta.merged_sources && Array.isArray(meta.merged_sources))) {
    meta.merged_sources = [];
  }
  const mergedSources = meta.merged_sources as string[];
  if (!mergedSources.includes(newSource)) {
    mergedSources.push(newSource);
  }
  meta.merged_count = mergedSources.length;
  existing.metadata_json = JSON.stringify(meta);

  return updateMemoryItem(db, existing);
}

// ─── FTS5 search ──────────────────────────────────────────────────

export function searchMemoryFts(
  db: Database,
  projectId: string,
  query: string,
  limit = 10,
): RecallResult[] {
  const sanitized = query
    .replace(/['"]/g, "")
    .replace(/[^\w\s]/g, " ")
    .trim();

  if (!sanitized) {
    return [];
  }

  const rows = db
    .query(
      `
      SELECT
        mi.id, mi.project_id, mi.kind, mi.text, mi.status, mi.visibility,
        mi.confidence, mi.source, mi.content_hash, mi.evidence_json,
        mi.metadata_json, NULL AS embedding, mi.created_at, mi.updated_at,
        mi.expires_at,
        rank,
        snippet(memory_items_fts, 0, '<mark>', '</mark>', '…', 40) AS snippet
      FROM memory_items_fts
      JOIN memory_items mi ON mi.rowid = memory_items_fts.rowid
      WHERE memory_items_fts MATCH ? AND mi.project_id = ?
      ORDER BY rank
      LIMIT ?;
    `,
    )
    .all(sanitized, projectId, limit) as Record<string, unknown>[];

  return rows.map((r) => ({
    item: rowToMemoryItem(r),
    rank: r.rank as number,
    snippet: r.snippet as string,
  }));
}
