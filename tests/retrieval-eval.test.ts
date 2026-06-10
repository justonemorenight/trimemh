import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";

import { closeDb, getDb, runMigrations } from "../src/persistence/db";
import {
  formatContextAccuracyEvalMarkdown,
  formatRetrievalEvalMarkdown,
  runContextAccuracyEval,
  runRetrievalEval,
} from "../src/retrieval/eval";
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
          expected_text: ["adapter-normalized", "lifecycle events"],
        },
      ],
      { projectId: PROJECT, limit: 5, mode: "hybrid" },
    );

    expect(report.summary.case_count).toBe(1);
    expect(report.summary.average_id_recall_at_k).toBeGreaterThan(0);
    expect(report.summary.average_combined_recall_at_k).toBeGreaterThan(0);
    expect(report.summary.average_recall_at_k).toBe(report.summary.average_combined_recall_at_k);
    expect(report.summary.average_text_recall_at_k).toBe(1);
    expect(report.cases[0]?.text_hits).toEqual(["adapter-normalized", "lifecycle events"]);
    expect(report.summary.average_mrr).toBeGreaterThan(0);
    const markdown = formatRetrievalEvalMarkdown(report);
    expect(markdown).toContain("triMemh Retrieval Eval");
    expect(markdown).toContain("id_recall@k");
    expect(markdown).toContain("text_recall@k");
  });

  test("measures context accuracy and evidence text recall", () => {
    const report = runContextAccuracyEval(
      db,
      [
        {
          id: "ctx-1",
          query: "plan adapter lifecycle evidence",
          expected_memory_ids: [expectedId],
          expected_text: ["adapter-normalized"],
          task_type: "planning",
          memory_context_budget_ratio: 0.5,
          evidence_mode: "force",
        },
      ],
      { projectId: PROJECT, budgets: [4_000] },
    );

    expect(report.summary.case_count).toBe(1);
    expect(report.summary.average_selected_id_recall).toBeGreaterThan(0);
    expect(report.summary.average_xml_text_recall).toBe(1);
    expect(report.summary.average_evidence_text_recall).toBe(1);
    expect(report.cases[0]?.evidence_span_count).toBeGreaterThan(0);
    expect(report.cases[0]?.compression_policy_id).toBe("evidence-v1");
    const markdown = formatContextAccuracyEvalMarkdown(report);
    expect(markdown).toContain("triMemh Context Accuracy Eval");
    expect(markdown).toContain("evidence_text_recall");
  });
});
