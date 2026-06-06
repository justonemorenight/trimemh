import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";

import { closeDb, getDb, runMigrations } from "../src/persistence/db";
import {
  approve,
  forget,
  listAll,
  propose,
  recall,
  reject,
  remember,
  rememberMany,
  status,
} from "../src/service";

const TEST_DB = "/tmp/memh-test-governance.sqlite";

let db: Database;

beforeAll(() => {
  try {
    unlinkSync(TEST_DB);
  } catch {}
  try {
    unlinkSync(`${TEST_DB}-wal`);
  } catch {}
  try {
    unlinkSync(`${TEST_DB}-shm`);
  } catch {}
  db = getDb(TEST_DB);
  runMigrations(db);
});

afterAll(() => {
  closeDb();
  try {
    unlinkSync(TEST_DB);
  } catch {}
  try {
    unlinkSync(`${TEST_DB}-wal`);
  } catch {}
  try {
    unlinkSync(`${TEST_DB}-shm`);
  } catch {}
});

const PROJECT = "gov-test-project";
const BATCH_PROJECT = "gov-batch-test-project";

describe("service.ts — Governance", () => {
  // ─── remember ──────────────────────────────────────────────

  describe("remember", () => {
    it("should write a low-risk memory directly", () => {
      const item = remember(db, {
        kind: "fact",
        text: "User prefers dark mode in editor",
        projectId: PROJECT,
      });
      expect(item.id).toBeDefined();
      expect(item.kind).toBe("fact");
      expect(item.status).toBe("active");
      expect(item.confidence).toBe(0.5);
      expect(item.source).toBe("cli:user");
    });

    it("should reject duplicate exact text in same project", () => {
      expect(() =>
        remember(db, {
          kind: "fact",
          text: "User prefers dark mode in editor",
          projectId: PROJECT,
        }),
      ).toThrow(/Duplicate/);
    });

    it("should write memory with custom confidence and source", () => {
      const item = remember(db, {
        kind: "preference",
        text: "Uses Pacific timezone",
        projectId: PROJECT,
        confidence: 0.9,
        source: "cli:user:explicit",
        visibility: "private",
      });
      expect(item.confidence).toBe(0.9);
      expect(item.source).toBe("cli:user:explicit");
    });

    it("should reject high-risk direct write from non-explicit source", () => {
      expect(() =>
        remember(db, {
          kind: "procedure",
          text: "Always run integration tests before deploy",
          projectId: PROJECT,
          source: "mcp:agent",
        }),
      ).toThrow(/Cannot directly write/);
    });

    it("should reject critical-risk direct write from non-explicit source", () => {
      expect(() =>
        remember(db, {
          kind: "trade_rule",
          text: "Never trade during FOMC",
          projectId: PROJECT,
          source: "mcp:agent",
        }),
      ).toThrow(/Cannot directly write/);
    });

    it("should allow high-risk with explicit user source", () => {
      const item = remember(db, {
        kind: "procedure",
        text: "Always run integration tests before deploying to production",
        projectId: PROJECT,
        source: "cli:user:explicit",
      });
      expect(item.id).toBeDefined();
      expect(item.status).toBe("active");
    });

    it("should batch write low-risk memories", () => {
      const items = rememberMany(db, [
        {
          kind: "fact",
          text: "Batch write stores related facts with one transaction",
          projectId: BATCH_PROJECT,
        },
        {
          kind: "preference",
          text: "Batch write keeps local persistence fast on populated DBs",
          projectId: BATCH_PROJECT,
        },
      ]);

      expect(items.length).toBe(2);
      expect(items.every((item) => item.status === "active")).toBe(true);
      expect(recall(db, BATCH_PROJECT, "Batch write local persistence").length).toBeGreaterThan(0);
    });

    it("should roll back a batch when one memory is rejected", () => {
      expect(() =>
        rememberMany(db, [
          {
            kind: "fact",
            text: "Batch rollback sentinel should not persist",
            projectId: BATCH_PROJECT,
          },
          {
            kind: "procedure",
            text: "Batch rollback blocked high-risk write",
            projectId: BATCH_PROJECT,
            source: "mcp:agent",
          },
        ]),
      ).toThrow(/Cannot directly write/);

      expect(
        listAll(db, BATCH_PROJECT).some(
          (item) => item.text === "Batch rollback sentinel should not persist",
        ),
      ).toBe(false);
    });
  });

  // ─── recall ────────────────────────────────────────────────

  describe("recall", () => {
    it("should find memory by FTS5 search", () => {
      const results = recall(db, PROJECT, "dark mode");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.item.text).toContain("dark mode");
    });

    it("should return empty for non-matching query", () => {
      const results = recall(db, PROJECT, "zzz_nonexistent_query_zzz");
      expect(results.length).toBe(0);
    });

    it("should respect limit parameter", () => {
      const results = recall(db, PROJECT, "user", 1);
      expect(results.length).toBeLessThanOrEqual(1);
    });
  });

  // ─── list ──────────────────────────────────────────────────

  describe("listAll", () => {
    it("should list all memories in project", () => {
      const items = listAll(db, PROJECT);
      expect(items.length).toBeGreaterThanOrEqual(3);
    });

    it("should filter by kind", () => {
      const items = listAll(db, PROJECT, "fact");
      expect(items.length).toBe(1);
      expect(items[0]?.kind).toBe("fact");
    });
  });

  // ─── forget ────────────────────────────────────────────────

  describe("forget", () => {
    it("should delete a memory", () => {
      const item = remember(db, {
        kind: "fact",
        text: "Temporary memory to be deleted",
        projectId: PROJECT,
      });
      const deleted = forget(db, PROJECT, item.id);
      expect(deleted).toBe(true);

      const results = recall(db, PROJECT, "Temporary memory to be deleted");
      // Should not find it because FTS5 trigger deletes its index too
      expect(results.length).toBe(0);
    });

    it("should throw on non-existent memory", () => {
      expect(() => forget(db, PROJECT, "nonexistent-id")).toThrow(/not found/);
    });
  });

  // ─── propose → approve → reject ───────────────────────────

  describe("proposal flow", () => {
    it("should create a pending proposal", () => {
      const p = propose(db, {
        kind: "decision",
        text: "Chose TypeScript over Python for CLI tool",
        projectId: PROJECT,
        proposedBy: "mcp:agent",
        rationale: "Team uses Bun already, reduces integration cost",
      });

      expect(p.id).toBeDefined();
      expect(p.status).toBe("pending");
      expect(p.risk_level).toBe("medium");
      expect(p.proposed_by).toBe("mcp:agent");
    });

    it("should create a high-risk proposal", () => {
      const p = propose(db, {
        kind: "procedure",
        text: "Run security audit before each release",
        projectId: PROJECT,
        proposedBy: "mcp:agent",
        rationale: "Security best practice",
      });

      expect(p.risk_level).toBe("high");
      expect(p.status).toBe("pending");
    });

    it("should create a critical-risk proposal", () => {
      const p = propose(db, {
        kind: "trade_rule",
        text: "Never expose API keys in client-side code",
        projectId: PROJECT,
        proposedBy: "mcp:agent",
        rationale: "Security requirement",
      });

      expect(p.risk_level).toBe("critical");
      expect(p.status).toBe("pending");
    });

    it("should upgrade proposal risk level to critical if it targets high/critical memory", () => {
      const criticalMemory = remember(db, {
        kind: "security_rule",
        text: "Direct write audit validation rule",
        projectId: PROJECT,
        source: "cli:user:explicit",
      });

      const originalError = console.error;
      console.error = () => {};
      try {
        const p = propose(db, {
          kind: "fact",
          text: "Updated text",
          action: "update",
          targetMemoryId: criticalMemory.id,
          projectId: PROJECT,
          proposedBy: "mcp:agent",
        });

        expect(p.risk_level).toBe("critical");
        expect(p.status).toBe("pending");
      } finally {
        console.error = originalError;
      }
    });
  });

  describe("approve", () => {
    it("should approve a pending proposal and create memory", () => {
      const p = propose(db, {
        kind: "session_summary",
        text: "Session 2026-06-05: Set up project scaffold with Bun + TypeScript",
        projectId: PROJECT,
        proposedBy: "mcp:agent",
      });

      const item = approve(db, PROJECT, p.id, "user");
      expect(item).not.toBeNull();
      expect(item?.kind).toBe("session_summary");
      expect(item?.status).toBe("active");
    });

    it("should reject approval of already-decided proposal", () => {
      const p = propose(db, {
        kind: "fact",
        text: "Another test proposal that will be already decided",
        projectId: PROJECT,
        proposedBy: "mcp:agent",
      });

      approve(db, PROJECT, p.id, "user");

      expect(() => approve(db, PROJECT, p.id, "user")).toThrow(/already/);
    });

    it("should reject approval with duplicate text", () => {
      // First, create a proposal with text that already exists
      const p = propose(db, {
        kind: "fact",
        text: "User prefers dark mode in editor", // same as first test
        projectId: PROJECT,
        proposedBy: "mcp:agent",
      });

      expect(() => approve(db, PROJECT, p.id, "user")).toThrow(/already has this exact text/);
    });
  });

  describe("reject", () => {
    it("should reject a pending proposal", () => {
      const p = propose(db, {
        kind: "code_context",
        text: "This file is very important for the build process",
        projectId: PROJECT,
        proposedBy: "mcp:agent",
      });

      const rejected = reject(db, PROJECT, p.id, "Not accurate enough", "user");
      expect(rejected.status).toBe("rejected");
      expect(rejected.decision_note).toBe("Not accurate enough");
      expect(rejected.decided_by).toBe("user");
    });
  });

  // ─── status ────────────────────────────────────────────────

  describe("status", () => {
    it("should return stats and pending proposals", () => {
      const s = status(db, PROJECT);
      expect(s.stats.total).toBeGreaterThan(0);
      expect(typeof s.stats.pendingProposals).toBe("number");
      expect(Array.isArray(s.pendingProposals)).toBe(true);
      expect(Array.isArray(s.recentAudit)).toBe(true);
    });
  });

  // ─── Audit trail ───────────────────────────────────────────

  describe("audit trail", () => {
    it("should create audit events for all write operations", () => {
      const s = status(db, PROJECT);
      expect(s.recentAudit.length).toBeGreaterThan(0);

      const eventTypes = s.recentAudit.map((e) => e.event_type);
      expect(eventTypes).toContain("memory_created");
      expect(eventTypes).toContain("proposal_created");
      expect(eventTypes).toContain("proposal_approved");
      expect(eventTypes).toContain("proposal_rejected");
    });
  });

  // ─── FTS5 index sync ──────────────────────────────────────

  describe("FTS5 sync", () => {
    it("should index new memories after insert", () => {
      const item = remember(db, {
        kind: "fact",
        text: "FTS5 sync test: Bun is the runtime",
        projectId: PROJECT,
      });

      const results = recall(db, PROJECT, "Bun runtime");
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.item.id === item.id)).toBe(true);
    });

    it("should remove from index after delete", () => {
      const item = remember(db, {
        kind: "fact",
        text: "FTS5 delete test: temporary memory",
        projectId: PROJECT,
      });

      forget(db, PROJECT, item.id);
      const results = recall(db, PROJECT, "FTS5 delete test");
      expect(results.some((r) => r.item.id === item.id)).toBe(false);
    });
  });
});
