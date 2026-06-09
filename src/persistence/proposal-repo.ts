import type { Database, SQLQueryBindings } from "bun:sqlite";

import type { AuditEvent, MemoryProposal, MemoryStats } from "../domain/schema";
import { rowToAuditEvent, rowToProposal } from "./repository-mappers";

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

export function getActiveMemoryCountsByProject(
  db: Database,
): Array<{ project_id: string; cnt: number }> {
  return db
    .query(
      "SELECT project_id, COUNT(*) as cnt FROM memory_items WHERE status = 'active' GROUP BY project_id ORDER BY cnt DESC;",
    )
    .all() as Array<{ project_id: string; cnt: number }>;
}

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
