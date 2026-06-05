/**
 * Team Governance — Multi-Reviewer Approval + RBAC (Phase 4 — Team & Scale)
 *
 * Multi-Reviewer Approval:
 * - Configurable approval policies per risk level
 * - Quorum-based decisions (minReviewers, quorumPercent)
 * - Required role constraints
 * - Reviewer vote tracking
 *
 * RBAC System:
 * - Four role tiers: viewer, proposer, approver, admin
 * - Per-project user-role assignments
 * - Permission checks at service boundaries
 *
 * Database tables:
 *   memory_roles       — user → role mapping per project
 *   proposal_reviewers  — reviewer votes per proposal
 */

import type { Database } from "bun:sqlite";

import { v4 as uuidv4 } from "uuid";

import type { RiskLevel } from "../domain/schema";

// ─── Types ──────────────────────────────────────────────────────────

export type UserRole = "viewer" | "proposer" | "approver" | "admin";

export interface ApprovalPolicy {
  /** Minimum number of reviewers required. */
  minReviewers: number;
  /** Required roles that must be represented among reviewers. */
  requiredRoles: UserRole[];
  /** Percentage of reviewers that must approve (0-100). */
  quorumPercent: number;
  /** Whether auto-approve is allowed below this risk level. */
  autoApproveBelow: RiskLevel;
}

export interface ReviewerVote {
  id: string;
  proposalId: string;
  userId: string;
  decision: "approved" | "rejected" | "abstain";
  note: string | null;
  createdAt: string;
}

export interface UserRoleEntry {
  id: string;
  projectId: string;
  userId: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalStatus {
  canApprove: boolean;
  votesReceived: number;
  votesRequired: number;
  approvals: number;
  rejections: number;
  missingRoles: UserRole[];
  message: string;
}

// ─── Default policies ───────────────────────────────────────────────

export const DEFAULT_APPROVAL_POLICIES: Record<RiskLevel, ApprovalPolicy> = {
  low: {
    minReviewers: 0,
    requiredRoles: [],
    quorumPercent: 0,
    autoApproveBelow: "low",
  },
  medium: {
    minReviewers: 1,
    requiredRoles: [],
    quorumPercent: 0,
    autoApproveBelow: "low",
  },
  high: {
    minReviewers: 1,
    requiredRoles: ["approver"],
    quorumPercent: 0,
    autoApproveBelow: "medium",
  },
  critical: {
    minReviewers: 2,
    requiredRoles: ["approver", "admin"],
    quorumPercent: 100,
    autoApproveBelow: "medium",
  },
};

// ─── RBAC: Role check helpers ───────────────────────────────────────

const PERMISSIONS: Record<UserRole, string[]> = {
  viewer: ["memory:read", "memory:search"],
  proposer: ["memory:read", "memory:search", "memory:propose"],
  approver: ["memory:read", "memory:search", "memory:propose", "memory:approve", "memory:reject"],
  admin: [
    "memory:read",
    "memory:search",
    "memory:propose",
    "memory:approve",
    "memory:reject",
    "memory:delete",
    "role:manage",
  ],
};

/**
 * Check if a role has a specific permission.
 */
export function hasPermission(role: UserRole, permission: string): boolean {
  return PERMISSIONS[role]?.includes(permission) ?? false;
}

/**
 * Check if the user can perform a direct write (bypass proposal).
 * Only cli:user:explicit actor or admin role.
 */
export function canDirectWrite(role: UserRole | null, risk: RiskLevel): boolean {
  if (risk === "low") {
    return true; // anyone can propose low-risk
  }
  if (role === "admin") {
    return true;
  }
  if (role === "approver" && (risk === "medium" || risk === "high")) {
    return true;
  }
  return false;
}

// ─── Policy evaluation ──────────────────────────────────────────────

/**
 * Evaluate whether a proposal has sufficient approvals.
 */
export function evaluateApproval(
  risk: RiskLevel,
  votes: ReviewerVote[],
  availableReviewers: UserRoleEntry[],
  policy?: ApprovalPolicy,
): ApprovalStatus {
  const pol = policy ?? DEFAULT_APPROVAL_POLICIES[risk];
  const approvals = votes.filter((v) => v.decision === "approved").length;
  const rejections = votes.filter((v) => v.decision === "rejected").length;
  const votesReceived = approvals + rejections;

  // Check required roles are represented among approvers
  const approverRoles = new Set(
    votes
      .filter((v) => v.decision === "approved")
      .map((v) => availableReviewers.find((r) => r.userId === v.userId)?.role)
      .filter(Boolean) as UserRole[],
  );

  const missingRoles = pol.requiredRoles.filter((r) => !approverRoles.has(r));

  // Quorum check
  const totalVotes = votes.filter((v) => v.decision !== "abstain").length;
  const quorumMet = totalVotes >= pol.minReviewers;

  // Percentage check
  const totalDecisive = approvals + rejections;
  const approvePercent = totalDecisive > 0 ? (approvals / totalDecisive) * 100 : 0;
  const percentMet = approvePercent >= pol.quorumPercent;

  const canApprove =
    quorumMet &&
    percentMet &&
    missingRoles.length === 0 &&
    (totalDecisive === 0 || approvals > rejections);

  let message: string;
  if (canApprove) {
    message =
      `Approval met: ${approvals}/${totalDecisive} approved (${Math.round(approvePercent)}%), ` +
      `${pol.minReviewers} reviewers required.`;
  } else {
    const reasons: string[] = [];
    if (!quorumMet) {
      reasons.push(`need ${pol.minReviewers} reviewers, have ${totalVotes}`);
    }
    if (!percentMet) {
      reasons.push(`need ${pol.quorumPercent}% approval, have ${Math.round(approvePercent)}%`);
    }
    if (missingRoles.length > 0) {
      reasons.push(`missing roles: ${missingRoles.join(", ")}`);
    }
    message = `Approval not met: ${reasons.join("; ")}.`;
  }

  return {
    canApprove,
    votesReceived,
    votesRequired: pol.minReviewers,
    approvals,
    rejections,
    missingRoles,
    message,
  };
}

// ─── Database operations ────────────────────────────────────────────

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
