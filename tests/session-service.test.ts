import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";

import { closeDb, getDb, runMigrations } from "../src/persistence/db";
import { approve, remember } from "../src/service";
import {
  buildSessionSummaryText,
  listSessionRegistry,
  sessionHistory,
  summarizeSession,
} from "../src/service/session-service";

const TEST_DB = "/tmp/trimemh-session-service.sqlite";
const PROJECT = "session-service-project";
let db: Database;

beforeAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB}${suffix}`);
    } catch {}
  }
  db = getDb(TEST_DB);
  runMigrations(db);
});

afterAll(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB}${suffix}`);
    } catch {}
  }
});

describe("session-service", () => {
  test("buildSessionSummaryText preserves session provenance and handoff notes", () => {
    const text = buildSessionSummaryText({
      projectId: "project-a",
      agentId: "codex",
      sessionId: "session-a",
      parentSessionId: "parent-a",
      summary: "Implemented hook adapter.",
      files: ["src/service/hook-service.ts"],
      handoffNotes: "Run retrieval eval next.",
      sourceEvent: "pre_compact",
    });

    expect(text).toContain("Session summary for codex/session-a.");
    expect(text).toContain("project_id=project-a");
    expect(text).toContain("parent_session_id=parent-a");
    expect(text).toContain("files=src/service/hook-service.ts");
    expect(text).toContain("handoff=Run retrieval eval next.");
  });

  test("sessionHistory over-fetches before filtering by agent/session", () => {
    for (let i = 0; i < 8; i++) {
      remember(db, {
        kind: "fact",
        text: `Session noise memory ${i} about handoff alpha`,
        projectId: PROJECT,
        source: "cli:user:explicit",
      });
    }
    const proposed = summarizeSession(db, {
      projectId: PROJECT,
      agentId: "codex",
      sessionId: "session-overfetch",
      summary: "handoff alpha important session summary",
    });
    if (proposed.status === "pending" && proposed.proposalId) {
      approve(db, PROJECT, proposed.proposalId, "test");
    } else {
      expect(proposed.status).toBe("approved");
    }

    const results = sessionHistory(db, {
      projectId: PROJECT,
      agentId: "codex",
      sessionId: "session-overfetch",
      limit: 1,
    });

    expect(results.length).toBe(1);
    expect(results[0]?.text).toContain("session-overfetch");
  });

  test("summarizeSession upserts a first-class session registry record", () => {
    summarizeSession(db, {
      projectId: PROJECT,
      agentId: "claude-code",
      sessionId: "session-registry",
      parentSessionId: "parent-registry",
      summary: "Captured registry-backed handoff.",
      files: ["src/service/session-service.ts"],
      handoffNotes: "Continue lifecycle tests.",
      sourceEvent: "stop",
    });

    const sessions = listSessionRegistry(db, {
      projectId: PROJECT,
      agentId: "claude-code",
      sessionId: "session-registry",
    });

    expect(sessions.length).toBe(1);
    expect(sessions[0]?.parent_session_id).toBe("parent-registry");
    expect(sessions[0]?.summary).toContain("registry-backed handoff");
  });
});
