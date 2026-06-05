import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";

import { assembleMemoryContext, createRuntimeContextState } from "../src/context/context-runtime";
import { closeDb, getDb, runMigrations } from "../src/persistence/db";
import { createMemoryCodeLink, remember } from "../src/service";

const TEST_DB = "/tmp/memh-test-context-runtime.sqlite";
const PROJECT = "context-runtime-test-project";

let db: Database;

function cleanupDb(): void {
  try {
    unlinkSync(TEST_DB);
  } catch {}
  try {
    unlinkSync(`${TEST_DB}-wal`);
  } catch {}
  try {
    unlinkSync(`${TEST_DB}-shm`);
  } catch {}
}

beforeEach(() => {
  cleanupDb();
  db = getDb(TEST_DB);
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  cleanupDb();
});

describe("context-runtime.ts — runtime injection loop", () => {
  it("assembles Layer 1 and semantic Layer 2 from local auto embeddings", () => {
    const memory = remember(db, {
      kind: "fact",
      text: "Runtime semantic context unique runtimealpha marker",
      projectId: PROJECT,
      source: "cli:user:explicit",
    });

    const assembled = assembleMemoryContext({
      db,
      projectId: PROJECT,
      query: "Runtime semantic context unique runtimealpha marker",
      state: createRuntimeContextState(),
    });

    expect(assembled.xml).toContain("<memory_context");
    expect(assembled.xml).toContain("<memory_index");
    expect(assembled.xml).toContain('<memory_details count="1">');
    expect(assembled.selectedDetailIds).toContain(memory.id);
    expect(assembled.state.turn).toBe(1);
  });

  it("injects code-path details and operational critical rules", () => {
    const codeMemory = remember(db, {
      kind: "code_context",
      text: "Runtime code path context for src/runtime-target.ts",
      projectId: PROJECT,
      source: "cli:user:explicit",
    });
    createMemoryCodeLink(db, {
      projectId: PROJECT,
      memoryId: codeMemory.id,
      path: "src/runtime-target.ts",
      entityType: "file",
      relation: "documents",
      source: "test",
    });

    const critical = remember(db, {
      kind: "security_rule",
      text: "Runtime critical rule: never delete production credentials",
      projectId: PROJECT,
      source: "cli:user:explicit",
    });

    const assembled = assembleMemoryContext({
      db,
      projectId: PROJECT,
      query: "delete database operation",
      openPaths: ["src/runtime-target.ts"],
      state: createRuntimeContextState(),
    });

    expect(assembled.selectedDetailIds).toContain(codeMemory.id);
    expect(assembled.selectedDetailIds).toContain(critical.id);
    expect(assembled.xml).toContain("src/runtime-target.ts");
    expect(assembled.xml).toContain("never delete production credentials");
  });

  it("keeps Layer 3 lineage turn-isolated and evicts idle details after 3 turns", () => {
    const memory = remember(db, {
      kind: "fact",
      text: "Runtime LRU context unique runtimelru marker",
      projectId: PROJECT,
      source: "cli:user:explicit",
    });

    const first = assembleMemoryContext({
      db,
      projectId: PROJECT,
      query: "Runtime LRU context unique runtimelru marker",
      includeLineageForIds: [memory.id],
      state: createRuntimeContextState(),
    });
    expect(first.xml).toContain("<memory_lineage");
    expect(first.lineageIds).toContain(memory.id);
    expect(first.state.activeDetails.some((detail) => detail.item.id === memory.id)).toBe(true);

    const second = assembleMemoryContext({ db, projectId: PROJECT, state: first.state });
    const third = assembleMemoryContext({ db, projectId: PROJECT, state: second.state });
    const fourth = assembleMemoryContext({ db, projectId: PROJECT, state: third.state });

    expect(second.xml).toContain("<memory_lineage />");
    expect(second.xml).not.toContain("<memory_lineage target_id=");
    expect(fourth.state.activeDetails.some((detail) => detail.item.id === memory.id)).toBe(false);
    expect(
      fourth.evicted.some(
        (event) => event.id === memory.id && event.reason === "lru_or_closed_path",
      ),
    ).toBe(true);
  });
});
