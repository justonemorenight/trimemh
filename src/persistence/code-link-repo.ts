import type { Database, SQLQueryBindings } from "bun:sqlite";

import type {
  CodeEntity,
  CodeMemoryResult,
  MemoryCodeLink,
  MemoryLinkProposal,
} from "../domain/schema";
import {
  rowToCodeEntity,
  rowToMemoryCodeLink,
  rowToMemoryItem,
  rowToMemoryLinkProposal,
} from "./repository-mappers";

// ─── Code Entities ───────────────────────────────────────────────

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

// ─── Memory Code Links ───────────────────────────────────────────

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
