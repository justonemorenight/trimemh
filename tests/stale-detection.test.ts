import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseFile } from "../src/code-intel/code-parser";
import { closeDb, getDb, runMigrations } from "../src/persistence/db";
import { createMemoryCodeLink, remember } from "../src/service";
import { detectStaleMemories } from "../src/service/lifecycle-service";

const TEST_DB = "/tmp/trimemh-stale-detection.sqlite";
const PROJECT = "stale-detection-project";
const TMP_DIR = "/tmp/trimemh-stale-detection";
let db: Database;

function cleanup(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB}${suffix}`);
    } catch {}
  }
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {}
}

function writeSource(name: string, source: string): string {
  mkdirSync(TMP_DIR, { recursive: true });
  const path = join(TMP_DIR, name);
  writeFileSync(path, source);
  return path;
}

function fingerprintForSync(path: string, symbol?: string): string {
  const parsed = parseFile(path, readFileSync(path, "utf8"));
  const entity = parsed.entities.find((entry) =>
    symbol ? entry.symbol === symbol : entry.entityType === "file",
  );
  if (!entity) {
    throw new Error(`Entity not found for ${path}${symbol ? `#${symbol}` : ""}`);
  }
  return entity.fingerprint;
}

beforeAll(() => {
  cleanup();
  db = getDb(TEST_DB);
  runMigrations(db);
});

afterAll(() => {
  closeDb();
  cleanup();
});

describe("detectStaleMemories", () => {
  test("flags memories linked to missing files", () => {
    const path = join(TMP_DIR, "missing.ts");
    const memory = remember(db, {
      kind: "code_context",
      text: "missing.ts documents the auth helper.",
      projectId: PROJECT,
      source: "test:stale",
    });
    createMemoryCodeLink(db, {
      projectId: PROJECT,
      memoryId: memory.id,
      entityType: "file",
      path,
      relation: "documents",
      rationale: "test link",
      fingerprint: "old",
    });

    const report = detectStaleMemories(db, {
      projectId: PROJECT,
      path,
      includeConflicts: false,
    });

    expect(report.results[0]?.memory.id).toBe(memory.id);
    expect(report.results[0]?.severity).toBe("high");
    expect(report.results[0]?.reasons.map((reason) => reason.reason)).toContain("missing_file");
  });

  test("flags memories linked to removed symbols", () => {
    const path = writeSource("removed-symbol.ts", "export function oldName() { return true; }\n");
    const memory = remember(db, {
      kind: "code_context",
      text: "oldName handles stale detection fixtures.",
      projectId: PROJECT,
      source: "test:stale",
    });
    createMemoryCodeLink(db, {
      projectId: PROJECT,
      memoryId: memory.id,
      entityType: "function",
      path,
      symbol: "oldName",
      relation: "implements",
      rationale: "test link",
      fingerprint: fingerprintForSync(path, "oldName"),
    });
    writeFileSync(path, "export function newName() { return true; }\n");

    const report = detectStaleMemories(db, {
      projectId: PROJECT,
      path,
      includeConflicts: false,
    });

    const result = report.results.find((entry) => entry.memory.id === memory.id);
    expect(result?.severity).toBe("high");
    expect(result?.reasons.map((reason) => reason.reason)).toContain("missing_symbol");
  });

  test("flags memories linked to changed fingerprints", () => {
    const path = writeSource(
      "changed-fingerprint.ts",
      "export function stableName() { return true; }\n",
    );
    const memory = remember(db, {
      kind: "code_context",
      text: "stableName returns true in the stale detection fixture.",
      projectId: PROJECT,
      source: "test:stale",
    });
    createMemoryCodeLink(db, {
      projectId: PROJECT,
      memoryId: memory.id,
      entityType: "function",
      path,
      symbol: "stableName",
      relation: "implements",
      rationale: "test link",
      fingerprint: fingerprintForSync(path, "stableName"),
    });
    writeFileSync(path, "export function stableName() { return false; }\n");

    const report = detectStaleMemories(db, {
      projectId: PROJECT,
      path,
      includeConflicts: false,
    });

    const result = report.results.find((entry) => entry.memory.id === memory.id);
    expect(result?.severity).toBe("medium");
    expect(result?.reasons.map((reason) => reason.reason)).toContain("fingerprint_mismatch");
  });

  test("flags active memory conflicts when enabled", () => {
    const first = remember(db, {
      kind: "decision",
      text: "Do not auto-approve stale memory cleanup.",
      projectId: PROJECT,
      source: "test:stale-conflict",
    });
    remember(db, {
      kind: "decision",
      text: "Auto-approve stale memory cleanup without review.",
      projectId: PROJECT,
      source: "test:stale-conflict",
    });

    const report = detectStaleMemories(db, {
      projectId: PROJECT,
      includeConflicts: true,
      limit: 20,
    });

    const result = report.results.find((entry) => entry.memory.id === first.id);
    expect(result?.reasons.map((reason) => reason.reason)).toContain("memory_conflict");
  });
});
