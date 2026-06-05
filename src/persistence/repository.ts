import type { Database, SQLQueryBindings } from "bun:sqlite";

import type {
  AuditEvent,
  CodeEntity,
  CodeMemoryResult,
  MemoryCodeLink,
  MemoryEdge,
  MemoryItem,
  MemoryLinkProposal,
  MemoryProposal,
  MemoryStats,
  RecallResult,
  RelatedMemoryResult,
} from "../domain/schema";
import { deserializeEmbedding } from "../retrieval/embedding";
import {
  MEMORY_COLUMNS_WITHOUT_EMBEDDING,
  MEMORY_COLUMNS_WITH_EMBEDDING,
  rowToAuditEvent,
  rowToCodeEntity,
  rowToMemoryCodeLink,
  rowToMemoryEdge,
  rowToMemoryItem,
  rowToMemoryLinkProposal,
  rowToProposal,
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

// ─── Semantic dedup helpers (SDD-06) ──────────────────────────────

/**
 * Fetch all active memories that have non-null embeddings for a project.
 * Used by semantic dedup to find near-duplicate candidates.
 */
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

/**
 * Merge evidence from a new/source memory into an existing target memory.
 * - Appends unique evidence entries (deduped by source+reference key)
 * - Upgrades confidence to the max of existing and new
 * - Records the merge source in metadata.merged_sources
 * - Bumps updated_at
 *
 * The caller is responsible for audit-logging the merge event.
 */
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

  // Merge unique evidence by source::reference compound key
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

  // Track which sources have been merged into this memory
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
  // Sanitize the FTS5 query string: escape special chars, wrap phrases in quotes
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

// ─── Memory Proposals CRUD ────────────────────────────────────────

export function insertProposal(db: Database, proposal: MemoryProposal): MemoryProposal {
  db.run(
    `INSERT INTO memory_proposals (
      id, project_id, action, target_memory_id, proposed_kind,
      proposed_text, proposed_by, risk_level, status, rationale,
      evidence_json, created_at, decided_at, decided_by, decision_note
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    );`,
    [
      proposal.id,
      proposal.project_id,
      proposal.action,
      proposal.target_memory_id,
      proposal.proposed_kind,
      proposal.proposed_text,
      proposal.proposed_by,
      proposal.risk_level,
      proposal.status,
      proposal.rationale,
      proposal.evidence_json,
      proposal.created_at,
      proposal.decided_at,
      proposal.decided_by,
      proposal.decision_note,
    ],
  );
  return proposal;
}

export function getProposalById(db: Database, id: string): MemoryProposal | null {
  const row = db.query("SELECT * FROM memory_proposals WHERE id = ?;").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    return null;
  }
  return rowToProposal(row);
}

export function updateProposal(db: Database, proposal: MemoryProposal): MemoryProposal {
  db.run(
    `UPDATE memory_proposals SET
      status = ?, decided_at = ?,
      decided_by = ?, decision_note = ?
    WHERE id = ?;`,
    [
      proposal.status,
      proposal.decided_at,
      proposal.decided_by,
      proposal.decision_note,
      proposal.id,
    ],
  );
  return proposal;
}

export function listPendingProposals(db: Database, projectId: string): MemoryProposal[] {
  const rows = db
    .query(
      "SELECT * FROM memory_proposals WHERE project_id = ? AND status = 'pending' ORDER BY created_at DESC;",
    )
    .all(projectId) as Record<string, unknown>[];
  return rows.map(rowToProposal);
}

export function listProposals(
  db: Database,
  projectId: string,
  opts?: {
    status?: string;
    limit?: number;
  },
): MemoryProposal[] {
  let sql = "SELECT * FROM memory_proposals WHERE project_id = ?";
  const params: SQLQueryBindings[] = [projectId];

  if (opts?.status) {
    sql += " AND status = ?";
    params.push(opts.status);
  }

  sql += " ORDER BY created_at DESC";

  if (opts?.limit) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }

  const rows = db.query(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToProposal);
}

// ─── Audit Events ─────────────────────────────────────────────────

export function insertAuditEvent(db: Database, event: AuditEvent): AuditEvent {
  db.run(
    `INSERT INTO audit_events (
      id, project_id, actor, event_type, entity_type, entity_id,
      payload_json, created_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?
    );`,
    [
      event.id,
      event.project_id,
      event.actor,
      event.event_type,
      event.entity_type,
      event.entity_id,
      event.payload_json,
      event.created_at,
    ],
  );
  return event;
}

export function getAuditEvents(db: Database, projectId: string, limit = 50): AuditEvent[] {
  const rows = db
    .query("SELECT * FROM audit_events WHERE project_id = ? ORDER BY created_at DESC LIMIT ?;")
    .all(projectId, limit) as Record<string, unknown>[];
  return rows.map(rowToAuditEvent);
}

// ─── Stats ────────────────────────────────────────────────────────

export function getMemoryStats(db: Database, projectId: string): MemoryStats {
  const totalRow = db
    .query("SELECT COUNT(*) as cnt FROM memory_items WHERE project_id = ? AND status = 'active';")
    .get(projectId) as { cnt: number };

  const byKind = db
    .query(
      "SELECT kind, COUNT(*) as cnt FROM memory_items WHERE project_id = ? AND status = 'active' GROUP BY kind;",
    )
    .all(projectId) as { kind: string; cnt: number }[];

  const byStatus = db
    .query("SELECT status, COUNT(*) as cnt FROM memory_items WHERE project_id = ? GROUP BY status;")
    .all(projectId) as { status: string; cnt: number }[];

  const pendingRow = db
    .query(
      "SELECT COUNT(*) as cnt FROM memory_proposals WHERE project_id = ? AND status = 'pending';",
    )
    .get(projectId) as { cnt: number };

  return {
    total: totalRow.cnt,
    byKind: Object.fromEntries(byKind.map((r) => [r.kind, r.cnt])),
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.cnt])),
    pendingProposals: pendingRow.cnt,
  };
}

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

// ─── Code Entities + Memory Code Links ───────────────────────────

export function insertCodeEntity(db: Database, entity: CodeEntity): CodeEntity {
  db.run(
    `INSERT INTO code_entities (
      id, project_id, entity_key, entity_type, path, symbol,
      line_start, line_end, fingerprint, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      entity.id,
      entity.project_id,
      entity.entity_key,
      entity.entity_type,
      entity.path,
      entity.symbol,
      entity.line_start,
      entity.line_end,
      entity.fingerprint,
      entity.metadata_json,
      entity.created_at,
      entity.updated_at,
    ],
  );
  return entity;
}

export function findCodeEntityByKey(
  db: Database,
  projectId: string,
  entityKey: string,
): CodeEntity | null {
  const row = db
    .query("SELECT * FROM code_entities WHERE project_id = ? AND entity_key = ?;")
    .get(projectId, entityKey) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return rowToCodeEntity(row);
}

export function getCodeEntityById(db: Database, id: string): CodeEntity | null {
  const row = db.query("SELECT * FROM code_entities WHERE id = ?;").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    return null;
  }
  return rowToCodeEntity(row);
}

export function insertMemoryCodeLink(db: Database, link: MemoryCodeLink): MemoryCodeLink {
  db.run(
    `INSERT INTO memory_code_links (
      id, project_id, memory_id, entity_id, relation,
      confidence, source, rationale, evidence_json, metadata_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      link.id,
      link.project_id,
      link.memory_id,
      link.entity_id,
      link.relation,
      link.confidence,
      link.source,
      link.rationale,
      link.evidence_json,
      link.metadata_json,
      link.created_at,
      link.updated_at,
    ],
  );
  return link;
}

export function findMemoryCodeLink(
  db: Database,
  projectId: string,
  memoryId: string,
  entityId: string,
  relation: string,
): MemoryCodeLink | null {
  const row = db
    .query(
      `SELECT * FROM memory_code_links
       WHERE project_id = ? AND memory_id = ? AND entity_id = ? AND relation = ?;`,
    )
    .get(projectId, memoryId, entityId, relation) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return rowToMemoryCodeLink(row);
}

export function getMemoriesForCodeRows(
  db: Database,
  projectId: string,
  path: string,
  symbol?: string,
): CodeMemoryResult[] {
  let sql = `
    SELECT
      mi.*,
      ce.id AS entity_id,
      ce.project_id AS entity_project_id,
      ce.entity_key,
      ce.entity_type,
      ce.path AS entity_path,
      ce.symbol AS entity_symbol,
      ce.line_start,
      ce.line_end,
      ce.fingerprint,
      ce.metadata_json AS entity_metadata_json,
      ce.created_at AS entity_created_at,
      ce.updated_at AS entity_updated_at,
      mcl.id AS link_id,
      mcl.project_id AS link_project_id,
      mcl.memory_id AS link_memory_id,
      mcl.entity_id AS link_entity_id,
      mcl.relation AS link_relation,
      mcl.confidence AS link_confidence,
      mcl.source AS link_source,
      mcl.rationale AS link_rationale,
      mcl.evidence_json AS link_evidence_json,
      mcl.metadata_json AS link_metadata_json,
      mcl.created_at AS link_created_at,
      mcl.updated_at AS link_updated_at
    FROM memory_code_links mcl
    JOIN code_entities ce ON ce.id = mcl.entity_id
    JOIN memory_items mi ON mi.id = mcl.memory_id
    WHERE mcl.project_id = ? AND ce.path = ?
  `;
  const params: SQLQueryBindings[] = [projectId, path];
  if (symbol) {
    sql += " AND ce.symbol = ?";
    params.push(symbol);
  }
  sql += " ORDER BY mcl.created_at DESC;";

  const rows = db.query(sql).all(...params) as Record<string, unknown>[];
  return rows.map((r) => ({
    item: rowToMemoryItem(r),
    entity: rowToCodeEntity({
      id: r.entity_id,
      project_id: r.entity_project_id,
      entity_key: r.entity_key,
      entity_type: r.entity_type,
      path: r.entity_path,
      symbol: r.entity_symbol,
      line_start: r.line_start,
      line_end: r.line_end,
      fingerprint: r.fingerprint,
      metadata_json: r.entity_metadata_json,
      created_at: r.entity_created_at,
      updated_at: r.entity_updated_at,
    }),
    link: rowToMemoryCodeLink({
      id: r.link_id,
      project_id: r.link_project_id,
      memory_id: r.link_memory_id,
      entity_id: r.link_entity_id,
      relation: r.link_relation,
      confidence: r.link_confidence,
      source: r.link_source,
      rationale: r.link_rationale,
      evidence_json: r.link_evidence_json,
      metadata_json: r.link_metadata_json,
      created_at: r.link_created_at,
      updated_at: r.link_updated_at,
    }),
  }));
}

// ─── Memory Link Proposals ───────────────────────────────────────

export function insertMemoryLinkProposal(
  db: Database,
  proposal: MemoryLinkProposal,
): MemoryLinkProposal {
  db.run(
    `INSERT INTO memory_link_proposals (
      id, project_id, proposal_type, source_memory_id, target_memory_id,
      entity_type, path, symbol, line_start, line_end, fingerprint,
      relation, confidence, proposed_by, status, rationale, evidence_json,
      created_at, decided_at, decided_by, decision_note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      proposal.id,
      proposal.project_id,
      proposal.proposal_type,
      proposal.source_memory_id,
      proposal.target_memory_id,
      proposal.entity_type,
      proposal.path,
      proposal.symbol,
      proposal.line_start,
      proposal.line_end,
      proposal.fingerprint,
      proposal.relation,
      proposal.confidence,
      proposal.proposed_by,
      proposal.status,
      proposal.rationale,
      proposal.evidence_json,
      proposal.created_at,
      proposal.decided_at,
      proposal.decided_by,
      proposal.decision_note,
    ],
  );
  return proposal;
}

export function getMemoryLinkProposalById(db: Database, id: string): MemoryLinkProposal | null {
  const row = db.query("SELECT * FROM memory_link_proposals WHERE id = ?;").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    return null;
  }
  return rowToMemoryLinkProposal(row);
}

export function updateMemoryLinkProposal(
  db: Database,
  proposal: MemoryLinkProposal,
): MemoryLinkProposal {
  db.run(
    `UPDATE memory_link_proposals SET
      status = ?, decided_at = ?, decided_by = ?, decision_note = ?
    WHERE id = ?;`,
    [
      proposal.status,
      proposal.decided_at,
      proposal.decided_by,
      proposal.decision_note,
      proposal.id,
    ],
  );
  return proposal;
}
