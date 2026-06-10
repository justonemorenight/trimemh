import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";

import { assembleMemoryContext, createRuntimeContextState } from "../src/context/context-runtime";
import { closeDb, getDb, runMigrations } from "../src/persistence/db";
import { createMemoryCodeLink, mcpRetrieveFull, remember } from "../src/service";

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
  it("reports adaptive budget diagnostics for classified and overridden task types", () => {
    const planning = assembleMemoryContext({
      db,
      projectId: PROJECT,
      query: "plan architecture roadmap for memory context",
      modelContextTokens: 10_000,
      state: createRuntimeContextState(),
    });

    expect(planning.taskType).toBe("planning");
    expect(planning.budgetRatio).toBe(0.2);
    expect(planning.budgetTokens).toBe(2_000);
    expect(planning.estimatedPromptTokens).toBeGreaterThan(0);

    const overridden = assembleMemoryContext({
      db,
      projectId: PROJECT,
      query: "chat about preferences",
      taskType: "debugging",
      memoryContextBudgetRatio: 0.18,
      modelContextTokens: 10_000,
      state: createRuntimeContextState(),
    });

    expect(overridden.taskType).toBe("debugging");
    expect(overridden.budgetRatio).toBe(0.18);
    expect(overridden.budgetTokens).toBe(1_800);
  });

  it("renders evidence-first context and stores structured metadata for new memories", () => {
    const memory = remember(db, {
      kind: "decision",
      text: "Decision: keep evidence-first context before memory details so relevant proof is visible under tight budgets.",
      projectId: PROJECT,
      source: "cli:user:explicit",
    });
    createMemoryCodeLink(db, {
      projectId: PROJECT,
      memoryId: memory.id,
      path: "src/evidence-target.ts",
      entityType: "file",
      relation: "documents",
      source: "test",
    });

    const storedMeta = JSON.parse(memory.metadata_json) as Record<string, unknown>;
    expect(storedMeta.structured_context_v1).toBeTruthy();

    const assembled = assembleMemoryContext({
      db,
      projectId: PROJECT,
      query: "plan evidence-first context proof",
      openPaths: ["src/evidence-target.ts"],
      modelContextTokens: 4_000,
      memoryContextBudgetRatio: 0.5,
      state: createRuntimeContextState(),
    });

    expect(assembled.evidenceSpanCount).toBeGreaterThan(0);
    expect(assembled.evidenceMemoryIds).toContain(memory.id);
    expect(assembled.retrievalRounds).toBe(2);
    expect(assembled.compressionPolicyId).toBe("evidence-v1");
    expect(assembled.contextAccuracySignals.evidenceEnabled).toBe(true);
    expect(assembled.xml.indexOf("<memory_evidence")).toBeLessThan(
      assembled.xml.indexOf("<memory_details"),
    );
    expect(assembled.xml).toContain("evidence-first context");
  });

  it("honors evidence and retrieval overrides", () => {
    remember(db, {
      kind: "decision",
      text: "Decision: retrieval override marker retrievaloverridealpha should be found.",
      projectId: PROJECT,
      source: "cli:user:explicit",
    });

    const assembled = assembleMemoryContext({
      db,
      projectId: PROJECT,
      query: "plan retrievaloverridealpha context",
      evidenceMode: "off",
      retrievalRounds: 1,
      modelContextTokens: 4_000,
      memoryContextBudgetRatio: 0.5,
      state: createRuntimeContextState(),
    });

    expect(assembled.evidenceSpanCount).toBe(0);
    expect(assembled.retrievalRounds).toBe(1);
    expect(assembled.xml).toContain('<memory_evidence count="0" />');
  });

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

  it("injects query-relevant chunks from the middle of long prose memories", () => {
    const longText = Array.from({ length: 36 }, (_, index) => {
      if (index === 18) {
        return "Runtime chunk accuracy marker runtimechunkneedle belongs in the middle chunk and must be shown when the query asks for it.";
      }
      return `Runtime chunk filler sentence ${index} has enough planning context words to make this memory long and force chunking behavior.`;
    }).join(" ");

    const memory = remember(db, {
      kind: "session_summary",
      text: longText,
      projectId: PROJECT,
      source: "cli:user:explicit",
    });
    createMemoryCodeLink(db, {
      projectId: PROJECT,
      memoryId: memory.id,
      path: "src/chunk-target.ts",
      entityType: "file",
      relation: "documents",
      source: "test",
    });

    const assembled = assembleMemoryContext({
      db,
      projectId: PROJECT,
      query: "plan runtimechunkneedle accuracy context",
      openPaths: ["src/chunk-target.ts"],
      modelContextTokens: 4_000,
      memoryContextBudgetRatio: 0.5,
      state: createRuntimeContextState(),
    });

    expect(assembled.selectedDetailIds).toContain(memory.id);
    expect(assembled.xml).toContain("[chunked memory:");
    expect(assembled.xml).toContain("runtimechunkneedle");
    expect(
      assembled.state.activeDetails.find((detail) => detail.item.id === memory.id)?.item.text,
    ).toBe(longText);

    const retrieved = mcpRetrieveFull(db, PROJECT, memory.id);
    expect(retrieved?.retrieval_context).toContain("runtimechunkneedle");
    expect(retrieved?.retrieval_context).toContain("--- FULL TEXT");
  });
});
