import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import type { ReviewerVote, UserRoleEntry } from "../src/governance/index";
import {
  DEFAULT_APPROVAL_POLICIES,
  assignRole,
  canDirectWrite,
  castVote,
  ensureGovernanceTables,
  evaluateApproval,
  getUserRole,
  getVotes,
  hasPermission,
  listRoles,
  removeRole,
} from "../src/governance/index";

function inMemoryDb(): Database {
  return new Database(":memory:");
}

describe("Governance Tables", () => {
  test("ensureGovernanceTables is idempotent", () => {
    const db = inMemoryDb();
    ensureGovernanceTables(db);
    ensureGovernanceTables(db); // second call should not error
    const tables = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('memory_roles', 'proposal_reviewers')",
      )
      .all() as Array<{ name: string }>;
    expect(tables.length).toBe(2);
  });
});

describe("RBAC — Role Management", () => {
  let db: Database;

  beforeEach(() => {
    db = inMemoryDb();
    ensureGovernanceTables(db);
  });

  test("assignRole creates a new role entry", () => {
    const entry = assignRole(db, "project-a", "user-1", "approver");
    expect(entry.userId).toBe("user-1");
    expect(entry.role).toBe("approver");
    expect(entry.projectId).toBe("project-a");
  });

  test("assignRole updates existing role", () => {
    assignRole(db, "project-a", "user-1", "viewer");
    const updated = assignRole(db, "project-a", "user-1", "admin");
    expect(updated.role).toBe("admin");
  });

  test("getUserRole returns null for unknown user", () => {
    const entry = getUserRole(db, "project-a", "nobody");
    expect(entry).toBeNull();
  });

  test("getUserRole returns correct role", () => {
    assignRole(db, "project-a", "user-1", "approver");
    const entry = getUserRole(db, "project-a", "user-1");
    expect(entry?.role).toBe("approver");
  });

  test("listRoles returns all users in project", () => {
    assignRole(db, "project-a", "user-1", "viewer");
    assignRole(db, "project-a", "user-2", "admin");
    const roles = listRoles(db, "project-a");
    expect(roles.length).toBe(2);
  });

  test("roles are isolated per project", () => {
    assignRole(db, "project-a", "user-1", "admin");
    assignRole(db, "project-b", "user-1", "viewer");
    const roleA = getUserRole(db, "project-a", "user-1");
    const roleB = getUserRole(db, "project-b", "user-1");
    expect(roleA?.role).toBe("admin");
    expect(roleB?.role).toBe("viewer");
  });

  test("removeRole deletes entry", () => {
    assignRole(db, "project-a", "user-1", "viewer");
    const removed = removeRole(db, "project-a", "user-1");
    expect(removed).toBe(true);
    expect(getUserRole(db, "project-a", "user-1")).toBeNull();
  });

  test("removeRole returns false for non-existent", () => {
    const removed = removeRole(db, "project-a", "nobody");
    expect(removed).toBe(false);
  });
});

describe("RBAC — Permissions", () => {
  test("viewer can only read and search", () => {
    expect(hasPermission("viewer", "memory:read")).toBe(true);
    expect(hasPermission("viewer", "memory:search")).toBe(true);
    expect(hasPermission("viewer", "memory:propose")).toBe(false);
    expect(hasPermission("viewer", "memory:approve")).toBe(false);
  });

  test("admin has all permissions", () => {
    expect(hasPermission("admin", "memory:delete")).toBe(true);
    expect(hasPermission("admin", "role:manage")).toBe(true);
  });

  test("approver can approve and reject", () => {
    expect(hasPermission("approver", "memory:approve")).toBe(true);
    expect(hasPermission("approver", "memory:reject")).toBe(true);
  });

  test("canDirectWrite — admin can write high risk directly", () => {
    expect(canDirectWrite("admin", "high")).toBe(true);
    expect(canDirectWrite("admin", "critical")).toBe(true);
  });

  test("canDirectWrite — viewer cannot write high risk", () => {
    expect(canDirectWrite("viewer", "high")).toBe(false);
  });

  test("canDirectWrite — anyone can write low risk", () => {
    expect(canDirectWrite(null, "low")).toBe(true);
    expect(canDirectWrite("viewer", "low")).toBe(true);
  });
});

describe("Multi-Reviewer Approval", () => {
  let db: Database;

  beforeEach(() => {
    db = inMemoryDb();
    ensureGovernanceTables(db);
  });

  test("castVote records a vote", () => {
    const vote = castVote(db, "proposal-1", "user-1", "approved");
    expect(vote.proposalId).toBe("proposal-1");
    expect(vote.userId).toBe("user-1");
    expect(vote.decision).toBe("approved");
  });

  test("castVote updates existing vote", () => {
    castVote(db, "proposal-1", "user-1", "approved");
    const updated = castVote(db, "proposal-1", "user-1", "rejected", "Changed mind");
    expect(updated.decision).toBe("rejected");
    expect(updated.note).toBe("Changed mind");
  });

  test("getVotes returns all votes for a proposal", () => {
    castVote(db, "proposal-1", "user-1", "approved");
    castVote(db, "proposal-1", "user-2", "rejected");
    castVote(db, "proposal-2", "user-1", "approved");
    const votes = getVotes(db, "proposal-1");
    expect(votes.length).toBe(2);
  });

  test("evaluateApproval — low risk auto-approves with no reviewers", () => {
    const result = evaluateApproval("low", [], []);
    expect(result.canApprove).toBe(true);
    expect(result.votesRequired).toBe(0);
  });

  test("evaluateApproval — critical needs 2 reviewers with approver+admin", () => {
    const reviewers: UserRoleEntry[] = [
      { id: "r1", projectId: "p1", userId: "u1", role: "approver", createdAt: "", updatedAt: "" },
      { id: "r2", projectId: "p1", userId: "u2", role: "admin", createdAt: "", updatedAt: "" },
    ];
    const votes: ReviewerVote[] = [
      { id: "v1", proposalId: "p1", userId: "u1", decision: "approved", note: null, createdAt: "" },
    ];
    const result = evaluateApproval("critical", votes, reviewers);
    expect(result.canApprove).toBe(false);
    expect(result.votesReceived).toBe(1);
    expect(result.votesRequired).toBe(2);
  });

  test("evaluateApproval — all conditions met", () => {
    const reviewers: UserRoleEntry[] = [
      { id: "r1", projectId: "p1", userId: "u1", role: "approver", createdAt: "", updatedAt: "" },
      { id: "r2", projectId: "p1", userId: "u2", role: "admin", createdAt: "", updatedAt: "" },
    ];
    const votes: ReviewerVote[] = [
      { id: "v1", proposalId: "p1", userId: "u1", decision: "approved", note: null, createdAt: "" },
      { id: "v2", proposalId: "p1", userId: "u2", decision: "approved", note: null, createdAt: "" },
    ];
    const result = evaluateApproval("critical", votes, reviewers);
    expect(result.canApprove).toBe(true);
    expect(result.approvals).toBe(2);
    expect(result.rejections).toBe(0);
  });

  test("evaluateApproval — rejection blocks approval", () => {
    const reviewers: UserRoleEntry[] = [
      { id: "r1", projectId: "p1", userId: "u1", role: "approver", createdAt: "", updatedAt: "" },
      { id: "r2", projectId: "p1", userId: "u2", role: "admin", createdAt: "", updatedAt: "" },
    ];
    const votes: ReviewerVote[] = [
      { id: "v1", proposalId: "p1", userId: "u1", decision: "approved", note: null, createdAt: "" },
      {
        id: "v2",
        proposalId: "p1",
        userId: "u2",
        decision: "rejected",
        note: "unsafe",
        createdAt: "",
      },
    ];
    const result = evaluateApproval("critical", votes, reviewers);
    expect(result.canApprove).toBe(false);
  });
});

describe("DEFAULT_APPROVAL_POLICIES", () => {
  test("all 4 risk levels have policies", () => {
    expect(DEFAULT_APPROVAL_POLICIES.low).toBeDefined();
    expect(DEFAULT_APPROVAL_POLICIES.medium).toBeDefined();
    expect(DEFAULT_APPROVAL_POLICIES.high).toBeDefined();
    expect(DEFAULT_APPROVAL_POLICIES.critical).toBeDefined();
  });

  test("critical policies are strictest", () => {
    const c = DEFAULT_APPROVAL_POLICIES.critical;
    const l = DEFAULT_APPROVAL_POLICIES.low;
    expect(c.minReviewers).toBeGreaterThan(l.minReviewers);
    expect(c.quorumPercent).toBeGreaterThan(l.quorumPercent);
  });
});
