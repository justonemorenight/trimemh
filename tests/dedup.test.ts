import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";

import { v4 as uuidv4 } from "uuid";

import type { MemoryItem } from "../src/domain/schema";
import { closeDb, getDb, runMigrations } from "../src/persistence/db";
import { deleteMemoryItem, insertMemoryItem } from "../src/persistence/repository";
import { contentHash, findSemanticDuplicates } from "../src/retrieval/dedup";
import { cosineSimilarity, serializeEmbedding } from "../src/retrieval/embedding";
import { dedupMerge, dedupScan, forget, listAll, remember } from "../src/service";

const TEST_DB = "/tmp/memh-test-dedup.sqlite";
let db: Database;
const PROJECT = "dedup-test";

// Use at-least-128-dim embeddings so the SEMANTIC_DEDUP_MIN_DIMENSION
// guard doesn't skip our tests.  Real embedding models produce ≥ 384.
const DIM = 128;

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

beforeEach(() => {
  db.run("DELETE FROM memory_edges;");
  db.run("DELETE FROM code_entities;");
  db.run("DELETE FROM memory_code_links;");
  db.run("DELETE FROM memory_proposals;");
  db.run("DELETE FROM audit_events;");
  db.run("DELETE FROM memory_items;");
  db.run("DELETE FROM memory_items_fts;");
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

// ─── Helpers ──────────────────────────────────────────────────

function makeEmbedding(dim: number, fill = 0.5): Float32Array {
  return new Float32Array(dim).fill(fill);
}

function _makeEmbeddingAt(values: number[]): Float32Array {
  return new Float32Array(values);
}

/** Create a DIM-dimensional embedding with a signature value at index 0. */
function emb(signature: number): Float32Array {
  const v = new Float32Array(DIM);
  v[0] = signature;
  v[1] = Math.sqrt(Math.max(0, 1 - signature * signature));
  return v;
}

/** Insert a memory directly, bypassing service-layer governance & dedup. */
function insertRaw(opts: {
  text: string;
  kind?: string;
  embedding?: Float32Array | null;
  confidence?: number;
  evidenceJson?: string;
}): MemoryItem {
  const item: MemoryItem = {
    id: uuidv4(),
    project_id: PROJECT,
    kind: (opts.kind ?? "fact") as MemoryItem["kind"],
    text: opts.text,
    status: "active",
    visibility: "private",
    confidence: opts.confidence ?? 0.5,
    source: "test:raw",
    content_hash: contentHash(opts.text),
    evidence_json: opts.evidenceJson ?? "[]",
    metadata_json: "{}",
    embedding: opts.embedding ? serializeEmbedding(opts.embedding) : null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    expires_at: null,
  };
  return insertMemoryItem(db, item);
}

// ─── dedupScan ────────────────────────────────────────────────

describe("dedupScan", () => {
  it("should return 0 pairs for an empty project", () => {
    const report = dedupScan(db, "dedup-scan-empty");
    expect(report.totalMemoriesWithEmbeddings).toBe(0);
    expect(report.pairs).toEqual([]);
  });

  it("should return 0 pairs when memories have no embeddings", () => {
    insertRaw({ text: "Dedup test: memory without embedding A" });
    insertRaw({ text: "Dedup test: memory without embedding B — similar meaning" });

    const report = dedupScan(db, PROJECT);
    const projectPairs = report.pairs.filter(
      (p) => p.memoryA.text.includes("Dedup test:") || p.memoryB.text.includes("Dedup test:"),
    );
    expect(projectPairs.length).toBe(0);
  });

  it("should detect nearly-identical high-dim embeddings as near-duplicates", () => {
    // Use insertRaw to bypass semantic merge-on-create — we want two
    // separate memories with similar embeddings in the DB.
    insertRaw({ text: "Bun is a fast JavaScript runtime for the project", embedding: emb(0.9) });
    insertRaw({ text: "Project uses Bun as the primary runtime", embedding: emb(0.91) });

    const report = dedupScan(db, PROJECT);
    const bunPairs = report.pairs.filter(
      (p) => p.memoryA.text.includes("Bun") && p.memoryB.text.includes("Bun"),
    );
    expect(bunPairs.length).toBeGreaterThanOrEqual(1);
    expect(bunPairs[0]?.similarity).toBeGreaterThan(0.95);
  });

  it("should return 0 pairs for very different topics", () => {
    // High-dim vectors with different signatures → low cosine similarity
    insertRaw({ text: "Different topic A: frontend deployment", embedding: emb(0.95) });
    insertRaw({ text: "Different topic B: database migration strategy", embedding: emb(-0.8) });

    const report = dedupScan(db, PROJECT);
    const diffPairs = report.pairs.filter(
      (p) =>
        p.memoryA.text.includes("Different topic") && p.memoryB.text.includes("Different topic"),
    );
    expect(diffPairs.length).toBe(0);
  });

  it("should respect the threshold parameter", () => {
    const embA = emb(0.7);
    const embB = emb(0.3);

    const itemA = insertRaw({ text: "Threshold test A: moderately similar", embedding: embA });
    const itemB = insertRaw({
      text: "Threshold test B: related topic different angle",
      embedding: embB,
    });

    const sim = cosineSimilarity(embA, embB);

    // At very strict threshold (0.999), should not match
    const reportStrict = dedupScan(db, PROJECT, 0.999);
    const strictPairs = reportStrict.pairs.filter(
      (p) =>
        (p.memoryA.id === itemA.id && p.memoryB.id === itemB.id) ||
        (p.memoryA.id === itemB.id && p.memoryB.id === itemA.id),
    );
    expect(strictPairs.length).toBe(0);

    // At threshold just below actual similarity, should match
    const reportLoose = dedupScan(db, PROJECT, Math.max(0, sim - 0.01));
    const loosePairs = reportLoose.pairs.filter(
      (p) =>
        (p.memoryA.id === itemA.id && p.memoryB.id === itemB.id) ||
        (p.memoryA.id === itemB.id && p.memoryB.id === itemA.id),
    );
    expect(loosePairs.length).toBe(1);
  });
});

// ─── remember with semantic merge ──────────────────────────────

describe("remember with semantic dedup", () => {
  it("should merge into existing memory when near-duplicate embedding detected", () => {
    // Use insertRaw for the first one to ensure it's in the DB
    const first = insertRaw({
      text: "The project uses React for frontend components",
      embedding: emb(0.85),
      confidence: 0.5,
    });
    expect(first.id).toBeDefined();

    // Nearly identical embedding through remember() — should merge
    const embNear = emb(0.855);
    const beforeCount = listAll(db, PROJECT).length;

    const second = remember(db, {
      kind: "fact",
      text: "React is the UI framework for this project",
      projectId: PROJECT,
      source: "mcp:agent",
      confidence: 0.8,
      evidence: [{ source: "agent", reference: "session-42" }],
      embedding: embNear,
    });

    // Should have merged into `first`, not created a new record
    expect(second.id).toBe(first.id);
    expect(second.confidence).toBe(0.8); // upgraded from 0.5 to 0.8
    expect(listAll(db, PROJECT).length).toBe(beforeCount); // no new memory

    // Evidence should be merged
    const evidenceArr = JSON.parse(second.evidence_json);
    expect(evidenceArr.length).toBeGreaterThanOrEqual(1);
    // biome-ignore lint/suspicious/noExplicitAny: warning suppression
    expect(evidenceArr.some((e: any) => e.reference === "session-42")).toBe(true);

    // Metadata should track merged sources
    const meta = JSON.parse(second.metadata_json);
    expect(meta.merged_sources).toContain("mcp:agent");
  });

  it("should create new memory when embedding is far from existing ones", () => {
    // Use a completely different fill pattern so cosine similarity is low
    const embFar = new Float32Array(DIM).fill(-0.9);
    embFar[0] = 0.0;
    const beforeCount = listAll(db, PROJECT).length;

    const item = remember(db, {
      kind: "fact",
      text: "Completely unrelated memory about deployment strategy",
      projectId: PROJECT,
      source: "cli:user:explicit",
      embedding: embFar,
    });

    expect(item.id).toBeDefined();
    expect(listAll(db, PROJECT).length).toBe(beforeCount + 1);

    // Should not have merged sources (new unique memory)
    const meta = JSON.parse(item.metadata_json);
    expect(meta.merged_sources).toBeUndefined();
  });

  it("should skip semantic dedup for low-dimension embeddings", () => {
    const lowDim = new Float32Array(4).fill(0.5);
    const beforeCount = listAll(db, PROJECT).length;

    const item = remember(db, {
      kind: "fact",
      text: "Low-dimension memory that should skip dedup",
      projectId: PROJECT,
      source: "cli:user:explicit",
      embedding: lowDim,
    });

    expect(item.id).toBeDefined();
    // Should create new memory (not merge) because 4 < 128 min dimension
    expect(listAll(db, PROJECT).length).toBe(beforeCount + 1);
  });

  it("should still work normally when embedding is not provided", () => {
    const beforeCount = listAll(db, PROJECT).length;

    const item = remember(db, {
      kind: "fact",
      text: "Memory without explicit embedding — CLI manual unique entry",
      projectId: PROJECT,
      source: "cli:user:explicit",
    });

    expect(item.id).toBeDefined();
    expect(listAll(db, PROJECT).length).toBe(beforeCount + 1);
  });
});

// ─── Exact hash still blocks (regression) ─────────────────────

describe("exact hash dedup regression", () => {
  it("should still block exact duplicate text even when embeddings differ", () => {
    const exactText = "Exact dedup regression: must be blocked by hash";

    // First write: insert directly to avoid any semantic merge
    insertRaw({ text: exactText, embedding: emb(0.5) });

    // Second write via remember() with different embedding — hash should block
    expect(() =>
      remember(db, {
        kind: "fact",
        text: exactText,
        projectId: PROJECT,
        source: "mcp:agent",
        embedding: emb(0.9),
      }),
    ).toThrow(/Duplicate/);
  });
});

// ─── dedupMerge ────────────────────────────────────────────────

describe("dedupMerge", () => {
  it("should merge source into target and delete source", () => {
    const target = insertRaw({
      text: "Dedup merge target — database uses PostgreSQL",
      embedding: emb(0.6),
      confidence: 0.6,
      evidenceJson: JSON.stringify([{ source: "docs", reference: "db-choice.md" }]),
    });
    const source = insertRaw({
      text: "Dedup merge source — project DB is Postgres",
      embedding: emb(0.6),
      confidence: 0.9,
      evidenceJson: JSON.stringify([{ source: "agent", reference: "session-99" }]),
    });

    const merged = dedupMerge(db, PROJECT, source.id, target.id);

    // Should have returned target with merged properties
    expect(merged.id).toBe(target.id);
    expect(merged.confidence).toBe(0.9); // upgraded

    // Evidence from source should now be on merged
    const evidenceArr = JSON.parse(merged.evidence_json);
    expect(evidenceArr.length).toBe(2);

    // Source should be deleted
    expect(() => forget(db, PROJECT, source.id)).toThrow(/not found/);

    // Target should still exist
    const stillThere = listAll(db, PROJECT).find((m) => m.id === target.id);
    expect(stillThere).toBeDefined();
  });

  it("should refuse to merge memories from different projects", () => {
    const otherProject = "dedup-other-project";
    const itemA = insertRaw({
      text: "Same project memory A for cross-project test",
      embedding: emb(0.5),
    });

    // Insert a memory in a different project directly
    const otherItem: MemoryItem = {
      id: uuidv4(),
      project_id: otherProject,
      kind: "fact",
      text: "Memory in other project",
      status: "active",
      visibility: "private",
      confidence: 0.5,
      source: "test",
      content_hash: contentHash("Memory in other project"),
      evidence_json: "[]",
      metadata_json: "{}",
      embedding: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      expires_at: null,
    };
    insertMemoryItem(db, otherItem);

    expect(() => dedupMerge(db, PROJECT, otherItem.id, itemA.id)).toThrow(
      /belongs to a different project/,
    );

    // Cleanup
    deleteMemoryItem(db, otherItem.id);
  });
});

// ─── findSemanticDuplicates (unit) ─────────────────────────────

describe("findSemanticDuplicates", () => {
  it("should return empty array when no candidates", () => {
    const query = makeEmbedding(DIM, 0.5);
    const results = findSemanticDuplicates(query, []);
    expect(results).toEqual([]);
  });

  it("should skip candidates with dimension mismatch", () => {
    const query = makeEmbedding(DIM, 0.5);
    const candidate = {
      // biome-ignore lint/suspicious/noExplicitAny: warning suppression
      item: { id: "x", kind: "fact" as const, text: "test" } as any,
      embedding: makeEmbedding(DIM * 2, 0.5),
    };
    const results = findSemanticDuplicates(query, [candidate]);
    expect(results).toEqual([]);
  });

  it("should skip when query embedding is below minimum dimension", () => {
    const query = makeEmbedding(4, 0.5); // 4 < 128
    const candidate = {
      // biome-ignore lint/suspicious/noExplicitAny: warning suppression
      item: { id: "c1", kind: "fact" as const, text: "c1" } as any,
      embedding: makeEmbedding(4, 0.5),
    };
    const results = findSemanticDuplicates(query, [candidate], 0.0);
    expect(results).toEqual([]);
  });

  it("should return results sorted by similarity descending", () => {
    const query = emb(0.8);
    const candidates = [
      {
        // biome-ignore lint/suspicious/noExplicitAny: warning suppression
        item: { id: "c1", kind: "fact" as const, text: "c1" } as any,
        embedding: emb(0.8),
      },
      {
        // biome-ignore lint/suspicious/noExplicitAny: warning suppression
        item: { id: "c2", kind: "fact" as const, text: "c2" } as any,
        embedding: emb(0.75),
      },
    ];
    const results = findSemanticDuplicates(query, candidates, 0.0);
    expect(results.length).toBe(2);
    expect(results[0]?.similarity).toBeGreaterThanOrEqual(results[1]?.similarity);
  });
});
