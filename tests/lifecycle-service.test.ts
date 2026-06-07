import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";

import { closeDb, getDb, runMigrations } from "../src/persistence/db";
import { listLifecycleEvents } from "../src/persistence/repository";
import { approve, propose, remember } from "../src/service";
import {
  detectMemoryConflicts,
  expireMemories,
  supersedeMemory,
} from "../src/service/lifecycle-service";

const TEST_DB = "/tmp/trimemh-lifecycle-service.sqlite";
const PROJECT = "lifecycle-service-project";
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

describe("lifecycle-service", () => {
  test("proposal approve records proposal and merged memory lifecycle events", () => {
    const proposal = propose(db, {
      kind: "decision",
      text: "Use lifecycle events as the source of truth for proposal state.",
      projectId: PROJECT,
      proposedBy: "test",
      requireReview: true,
    });

    const item = approve(db, PROJECT, proposal.id, "reviewer");
    expect(item).toBeTruthy();

    const proposalEvents = listLifecycleEvents(db, PROJECT, {
      entityType: "memory_proposal",
      entityId: proposal.id,
    });
    expect(proposalEvents.map((event) => event.state)).toContain("needs_review");
    expect(proposalEvents.map((event) => event.state)).toContain("approved");

    const itemEvents = listLifecycleEvents(db, PROJECT, {
      entityType: "memory_item",
      entityId: item?.id,
    });
    expect(itemEvents.map((event) => event.state)).toContain("merged");
  });

  test("expireMemories supports dry-run and persisted expiry", () => {
    const item = remember(db, {
      kind: "fact",
      text: "Temporary memory that should expire during lifecycle tests.",
      projectId: PROJECT,
      source: "test:expire",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });

    const dryRun = expireMemories(db, {
      projectId: PROJECT,
      before: "2021-01-01T00:00:00.000Z",
      sourcePrefix: "test:expire",
      dryRun: true,
    });
    expect(dryRun.status).toBe("dry_run");
    expect(dryRun.expired.map((entry) => entry.id)).toContain(item.id);

    const persisted = expireMemories(db, {
      projectId: PROJECT,
      before: "2021-01-01T00:00:00.000Z",
      sourcePrefix: "test:expire",
    });
    expect(persisted.status).toBe("expired");

    const events = listLifecycleEvents(db, PROJECT, {
      entityType: "memory_item",
      entityId: item.id,
      state: "expired",
    });
    expect(events.length).toBe(1);
  });

  test("supersedeMemory archives old memory and records lifecycle", () => {
    const oldMemory = remember(db, {
      kind: "fact",
      text: "Old install command uses trimemh install --target claude.",
      projectId: PROJECT,
      source: "test:supersede",
    });
    const newMemory = remember(db, {
      kind: "fact",
      text: "New install command uses trimemh install --target claude-code.",
      projectId: PROJECT,
      source: "test:supersede",
    });

    const result = supersedeMemory(db, {
      projectId: PROJECT,
      oldMemoryId: oldMemory.id,
      newMemoryId: newMemory.id,
      actor: "reviewer",
    });

    expect(result.status).toBe("superseded");
    expect(result.oldMemory.status).toBe("archived");
    expect(JSON.parse(result.oldMemory.metadata_json).superseded_by).toBe(newMemory.id);

    const events = listLifecycleEvents(db, PROJECT, {
      entityType: "memory_item",
      entityId: oldMemory.id,
      state: "superseded",
    });
    expect(events.length).toBe(1);
  });

  test("detectMemoryConflicts ranks related active memories", () => {
    remember(db, {
      kind: "decision",
      text: "Do not auto-approve raw hook tool output.",
      projectId: PROJECT,
      source: "test:conflict",
    });

    const candidates = detectMemoryConflicts(db, {
      projectId: PROJECT,
      kind: "decision",
      text: "Auto-approve hook tool output without review.",
      limit: 3,
    });

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.memory.text).toContain("tool output");
  });
});
