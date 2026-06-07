import type { Database, SQLQueryBindings } from "bun:sqlite";

export type LifecycleState =
  | "observed"
  | "proposed"
  | "needs_review"
  | "approved"
  | "rejected"
  | "merged"
  | "superseded"
  | "expired";

export type LifecycleEntityType = "memory_event" | "memory_proposal" | "memory_item" | "session";

export interface MemoryLifecycleEvent {
  id: string;
  project_id: string;
  entity_type: LifecycleEntityType;
  entity_id: string;
  state: LifecycleState;
  actor: string;
  payload_hash: string | null;
  payload_json: string;
  created_at: string;
}

export interface MemorySessionRecord {
  id: string;
  project_id: string;
  session_id: string;
  agent_id: string;
  parent_session_id: string | null;
  summary: string;
  handoff_notes: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

function rowToLifecycleEvent(row: Record<string, unknown>): MemoryLifecycleEvent {
  return {
    id: row.id as string,
    project_id: row.project_id as string,
    entity_type: row.entity_type as LifecycleEntityType,
    entity_id: row.entity_id as string,
    state: row.state as LifecycleState,
    actor: row.actor as string,
    payload_hash: (row.payload_hash as string | null) ?? null,
    payload_json: row.payload_json as string,
    created_at: row.created_at as string,
  };
}

function rowToMemorySession(row: Record<string, unknown>): MemorySessionRecord {
  return {
    id: row.id as string,
    project_id: row.project_id as string,
    session_id: row.session_id as string,
    agent_id: row.agent_id as string,
    parent_session_id: (row.parent_session_id as string | null) ?? null,
    summary: row.summary as string,
    handoff_notes: (row.handoff_notes as string | null) ?? null,
    metadata_json: row.metadata_json as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function insertLifecycleEvent(
  db: Database,
  event: MemoryLifecycleEvent,
): MemoryLifecycleEvent {
  db.run(
    `INSERT INTO memory_lifecycle_events (
      id, project_id, entity_type, entity_id, state, actor,
      payload_hash, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      event.id,
      event.project_id,
      event.entity_type,
      event.entity_id,
      event.state,
      event.actor,
      event.payload_hash,
      event.payload_json,
      event.created_at,
    ],
  );
  return event;
}

export function listLifecycleEvents(
  db: Database,
  projectId: string,
  opts?: {
    entityType?: LifecycleEntityType;
    entityId?: string;
    state?: LifecycleState;
    limit?: number;
  },
): MemoryLifecycleEvent[] {
  let sql = "SELECT * FROM memory_lifecycle_events WHERE project_id = ?";
  const params: SQLQueryBindings[] = [projectId];

  if (opts?.entityType) {
    sql += " AND entity_type = ?";
    params.push(opts.entityType);
  }
  if (opts?.entityId) {
    sql += " AND entity_id = ?";
    params.push(opts.entityId);
  }
  if (opts?.state) {
    sql += " AND state = ?";
    params.push(opts.state);
  }

  sql += " ORDER BY created_at DESC";
  if (opts?.limit) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }

  const rows = db.query(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToLifecycleEvent);
}

export function latestLifecycleState(
  db: Database,
  projectId: string,
  entityType: LifecycleEntityType,
  entityId: string,
): MemoryLifecycleEvent | null {
  const row = db
    .query(
      `SELECT * FROM memory_lifecycle_events
       WHERE project_id = ? AND entity_type = ? AND entity_id = ?
       ORDER BY created_at DESC
       LIMIT 1;`,
    )
    .get(projectId, entityType, entityId) as Record<string, unknown> | undefined;
  return row ? rowToLifecycleEvent(row) : null;
}

export function upsertMemorySession(
  db: Database,
  session: MemorySessionRecord,
): MemorySessionRecord {
  db.run(
    `INSERT INTO memory_sessions (
      id, project_id, session_id, agent_id, parent_session_id,
      summary, handoff_notes, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, session_id, agent_id) DO UPDATE SET
      parent_session_id = excluded.parent_session_id,
      summary = excluded.summary,
      handoff_notes = excluded.handoff_notes,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at;`,
    [
      session.id,
      session.project_id,
      session.session_id,
      session.agent_id,
      session.parent_session_id,
      session.summary,
      session.handoff_notes,
      session.metadata_json,
      session.created_at,
      session.updated_at,
    ],
  );

  return getMemorySession(db, session.project_id, session.agent_id, session.session_id) ?? session;
}

export function getMemorySession(
  db: Database,
  projectId: string,
  agentId: string,
  sessionId: string,
): MemorySessionRecord | null {
  const row = db
    .query(
      `SELECT * FROM memory_sessions
       WHERE project_id = ? AND agent_id = ? AND session_id = ?;`,
    )
    .get(projectId, agentId, sessionId) as Record<string, unknown> | undefined;
  return row ? rowToMemorySession(row) : null;
}

export function listMemorySessions(
  db: Database,
  projectId: string,
  opts?: {
    agentId?: string;
    sessionId?: string;
    parentSessionId?: string;
    limit?: number;
  },
): MemorySessionRecord[] {
  let sql = "SELECT * FROM memory_sessions WHERE project_id = ?";
  const params: SQLQueryBindings[] = [projectId];

  if (opts?.agentId) {
    sql += " AND agent_id = ?";
    params.push(opts.agentId);
  }
  if (opts?.sessionId) {
    sql += " AND session_id = ?";
    params.push(opts.sessionId);
  }
  if (opts?.parentSessionId) {
    sql += " AND parent_session_id = ?";
    params.push(opts.parentSessionId);
  }

  sql += " ORDER BY updated_at DESC";
  if (opts?.limit) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }

  const rows = db.query(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToMemorySession);
}
