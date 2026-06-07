import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";

import { closeDb, getDb, runMigrations } from "../src/persistence/db";
import { formatRetrievalEvalMarkdown, runRetrievalEval } from "../src/retrieval/eval";
import { remember } from "../src/service";

const TEST_DB = "/tmp/trimemh-retrieval-eval.sqlite";
const PROJECT = "retrieval-eval-project";
let db: Database;
let expectedId = "";

beforeAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB}${suffix}`);
    } catch {}
  }
  db = getDb(TEST_DB);
  runMigrations(db);
  const item = remember(db, {
    kind: "decision",
    text: "Retrieval eval project decided to use adapter-normalized lifecycle events.",
    projectId: PROJECT,
    source: "cli:user:explicit",
  });
  expectedId = item.id;
  remember(db, {
    kind: "fact",
    text: "Unrelated memory about editor font size.",
    projectId: PROJECT,
    source: "cli:user:explicit",
  });
});

afterAll(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB}${suffix}`);
    } catch {}
  }
});

describe("retrieval eval", () => {
  test("measures recall@k and MRR for a golden dataset", () => {
    const report = runRetrievalEval(
      db,
      [
        {
          query: "adapter normalized lifecycle events",
          expected_memory_ids: [expectedId],
        },
      ],
      { projectId: PROJECT, limit: 5, mode: "hybrid" },
    );

    expect(report.summary.case_count).toBe(1);
    expect(report.summary.average_id_recall_at_k).toBeGreaterThan(0);
    expect(report.summary.average_combined_recall_at_k).toBeGreaterThan(0);
    expect(report.summary.average_recall_at_k).toBe(report.summary.average_combined_recall_at_k);
    expect(report.summary.average_mrr).toBeGreaterThan(0);
    const markdown = formatRetrievalEvalMarkdown(report);
    expect(markdown).toContain("triMemh Retrieval Eval");
    expect(markdown).toContain("id_recall@k");
  });
});
