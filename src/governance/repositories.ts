import type { Database } from "bun:sqlite";

import { v4 as uuidv4 } from "uuid";

import type { ReviewerVote, UserRole, UserRoleEntry } from "./types";

/** Ensure governance tables exist (idempotent). */
export function ensureGovernanceTables(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_roles (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('viewer', 'proposer', 'approver', 'admin')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_roles_project ON memory_roles(project_id);

    CREATE TABLE IF NOT EXISTS proposal_reviewers (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'abstain')),
      note TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(proposal_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_reviewers_proposal ON proposal_reviewers(proposal_id);
  `);
}

/** Assign a role to a user in a project. */
export function assignRole(
  db: Database,
  projectId: string,
  userId: string,
  role: UserRole,
): UserRoleEntry {
  const existing = db
    .query("SELECT id FROM memory_roles WHERE project_id = ? AND user_id = ?")
    .get(projectId, userId) as { id: string } | undefined;

  const now = new Date().toISOString();

  if (existing) {
    db.run("UPDATE memory_roles SET role = ?, updated_at = ? WHERE id = ?", [
      role,
      now,
      existing.id,
    ]);
  } else {
    db.run(
      "INSERT INTO memory_roles (id, project_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [uuidv4(), projectId, userId, role, now, now],
    );
  }

  const entry = getUserRole(db, projectId, userId);
  if (!entry) {
    throw new Error(`Failed to assign role to user ${userId} on project ${projectId}`);
  }
  return entry;
}

/** Get a user's role in a project. */
export function getUserRole(db: Database, projectId: string, userId: string): UserRoleEntry | null {
  const row = db
    .query(
      "SELECT id, project_id, user_id, role, created_at, updated_at FROM memory_roles WHERE project_id = ? AND user_id = ?",
    )
    .get(projectId, userId) as Record<string, unknown> | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id as string,
    projectId: row.project_id as string,
    userId: row.user_id as string,
    role: row.role as UserRole,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** List all users with roles in a project. */
export function listRoles(db: Database, projectId: string): UserRoleEntry[] {
  const rows = db
    .query(
      "SELECT id, project_id, user_id, role, created_at, updated_at FROM memory_roles WHERE project_id = ? ORDER BY role, user_id",
    )
    .all(projectId) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: r.id as string,
    projectId: r.project_id as string,
    userId: r.user_id as string,
    role: r.role as UserRole,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }));
}

/** Remove a user's role. */
export function removeRole(db: Database, projectId: string, userId: string): boolean {
  const result = db.run("DELETE FROM memory_roles WHERE project_id = ? AND user_id = ?", [
    projectId,
    userId,
  ]);
  return result.changes > 0;
}

/** Record a reviewer vote on a proposal. */
export function castVote(
  db: Database,
  proposalId: string,
  userId: string,
  decision: "approved" | "rejected" | "abstain",
  note?: string,
): ReviewerVote {
  const existing = db
    .query("SELECT id FROM proposal_reviewers WHERE proposal_id = ? AND user_id = ?")
    .get(proposalId, userId) as { id: string } | undefined;

  const now = new Date().toISOString();

  if (existing) {
    db.run("UPDATE proposal_reviewers SET decision = ?, note = ?, created_at = ? WHERE id = ?", [
      decision,
      note ?? null,
      now,
      existing.id,
    ]);
  } else {
    db.run(
      "INSERT INTO proposal_reviewers (id, proposal_id, user_id, decision, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [uuidv4(), proposalId, userId, decision, note ?? null, now],
    );
  }

  return {
    id: existing?.id ?? uuidv4(),
    proposalId,
    userId,
    decision,
    note: note ?? null,
    createdAt: now,
  };
}

/** Get all reviewer votes for a proposal. */
export function getVotes(db: Database, proposalId: string): ReviewerVote[] {
  const rows = db
    .query(
      "SELECT id, proposal_id, user_id, decision, note, created_at FROM proposal_reviewers WHERE proposal_id = ? ORDER BY created_at",
    )
    .all(proposalId) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: r.id as string,
    proposalId: r.proposal_id as string,
    userId: r.user_id as string,
    decision: r.decision as ReviewerVote["decision"],
    note: r.note as string | null,
    createdAt: r.created_at as string,
  }));
}
