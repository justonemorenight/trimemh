import type { Database } from "bun:sqlite";

import type { MemoryEdge, RelatedMemoryResult } from "../domain/schema";
import { rowToMemoryEdge, rowToMemoryItem } from "./repository-mappers";

// ─── Memory Graph Edges ──────────────────────────────────────────

export function insertMemoryEdge(db: Database, edge: MemoryEdge): MemoryEdge {
  db.run(
    `INSERT INTO memory_edges (
      id, project_id, source_memory_id, target_memory_id, relation,
      confidence, source, rationale, evidence_json, metadata_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      edge.id,
      edge.project_id,
      edge.source_memory_id,
      edge.target_memory_id,
      edge.relation,
      edge.confidence,
      edge.source,
      edge.rationale,
      edge.evidence_json,
      edge.metadata_json,
      edge.created_at,
      edge.updated_at,
    ],
  );
  return edge;
}

export function findMemoryEdge(
  db: Database,
  projectId: string,
  sourceMemoryId: string,
  targetMemoryId: string,
  relation: string,
): MemoryEdge | null {
  const row = db
    .query(
      `SELECT * FROM memory_edges
       WHERE project_id = ? AND source_memory_id = ? AND target_memory_id = ? AND relation = ?;`,
    )
    .get(projectId, sourceMemoryId, targetMemoryId, relation) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    return null;
  }
  return rowToMemoryEdge(row);
}

export function getMemoryEdgeById(db: Database, id: string): MemoryEdge | null {
  const row = db.query("SELECT * FROM memory_edges WHERE id = ?;").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    return null;
  }
  return rowToMemoryEdge(row);
}

export function getRelatedMemoryRows(
  db: Database,
  projectId: string,
  memoryId: string,
  depth: number,
): RelatedMemoryResult[] {
  const cappedDepth = Math.max(1, Math.min(depth, 2));
  const rows = db
    .query(
      `
      WITH RECURSIVE graph(memory_id, edge_id, relation, direction, depth, path) AS (
        SELECT
          e.target_memory_id,
          e.id,
          e.relation,
          'outgoing',
          1,
          ? || ',' || e.target_memory_id
        FROM memory_edges e
        WHERE e.project_id = ? AND e.source_memory_id = ?

        UNION ALL

        SELECT
          e.source_memory_id,
          e.id,
          e.relation,
          'incoming',
          1,
          ? || ',' || e.source_memory_id
        FROM memory_edges e
        WHERE e.project_id = ? AND e.target_memory_id = ?

        UNION ALL

        SELECT
          e.target_memory_id,
          e.id,
          e.relation,
          'outgoing',
          graph.depth + 1,
          graph.path || ',' || e.target_memory_id
        FROM graph
        JOIN memory_edges e
          ON e.project_id = ? AND e.source_memory_id = graph.memory_id
        WHERE graph.depth < ?
          AND instr(graph.path, e.target_memory_id) = 0

        UNION ALL

        SELECT
          e.source_memory_id,
          e.id,
          e.relation,
          'incoming',
          graph.depth + 1,
          graph.path || ',' || e.source_memory_id
        FROM graph
        JOIN memory_edges e
          ON e.project_id = ? AND e.target_memory_id = graph.memory_id
        WHERE graph.depth < ?
          AND instr(graph.path, e.source_memory_id) = 0
      )
      SELECT
        graph.depth,
        graph.direction,
        edge.id AS edge_id,
        edge.project_id AS edge_project_id,
        edge.source_memory_id,
        edge.target_memory_id,
        edge.relation AS edge_relation,
        edge.confidence AS edge_confidence,
        edge.source AS edge_source,
        edge.rationale AS edge_rationale,
        edge.evidence_json AS edge_evidence_json,
        edge.metadata_json AS edge_metadata_json,
        edge.created_at AS edge_created_at,
        edge.updated_at AS edge_updated_at,
        mi.*
      FROM graph
      JOIN memory_items mi ON mi.id = graph.memory_id
      JOIN memory_edges edge ON edge.id = graph.edge_id
      WHERE mi.project_id = ?
      ORDER BY graph.depth ASC, edge.created_at DESC;
    `,
    )
    .all(
      memoryId,
      projectId,
      memoryId,
      memoryId,
      projectId,
      memoryId,
      projectId,
      cappedDepth,
      projectId,
      cappedDepth,
      projectId,
    ) as Record<string, unknown>[];

  const seen = new Set<string>();
  const results: RelatedMemoryResult[] = [];
  for (const r of rows) {
    const dedupeKey = `${r.id as string}:${r.edge_id as string}:${r.depth as number}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    results.push({
      item: rowToMemoryItem(r),
      edge: rowToMemoryEdge({
        id: r.edge_id,
        project_id: r.edge_project_id,
        source_memory_id: r.source_memory_id,
        target_memory_id: r.target_memory_id,
        relation: r.edge_relation,
        confidence: r.edge_confidence,
        source: r.edge_source,
        rationale: r.edge_rationale,
        evidence_json: r.edge_evidence_json,
        metadata_json: r.edge_metadata_json,
        created_at: r.edge_created_at,
        updated_at: r.edge_updated_at,
      }),
      depth: r.depth as number,
      direction: r.direction as "incoming" | "outgoing",
    });
  }
  return results;
}
