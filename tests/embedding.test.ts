import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";

import { closeDb, getDb, runMigrations } from "../src/persistence/db";
import {
  cosineSimilarity,
  deserializeEmbedding,
  serializeEmbedding,
  validateDimensions,
} from "../src/retrieval/embedding";
import { embedText, localEmbeddingProvider } from "../src/retrieval/embedding-provider";
import { hybridRetrieve, vectorSearch } from "../src/retrieval/hybrid";
import { listAll, recall, remember } from "../src/service";

const TEST_DB = "/tmp/memh-test-embedding.sqlite";
let db: Database;
const PROJECT = "embedding-test";

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

// ─── Helpers ──────────────────────────────────────────────────

function makeEmbedding(dim: number, fill = 0.5): Float32Array {
  return new Float32Array(dim).fill(fill);
}

function makeUnitEmbedding(
  dim: number = localEmbeddingProvider.dimensions,
  index = 0,
): Float32Array {
  const emb = new Float32Array(dim);
  emb[index] = 1;
  return emb;
}

// ─── Serialization (SDD-02 §2) ───────────────────────────────

describe("embedding serialization", () => {
  it("should generate deterministic local embeddings without external providers", () => {
    const a = embedText("Local semantic memory for TypeScript strict mode");
    const b = embedText("Local semantic memory for TypeScript strict mode");

    expect(a.length).toBe(localEmbeddingProvider.dimensions);
    expect(b.length).toBe(localEmbeddingProvider.dimensions);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("should round-trip Float32Array through serialize → deserialize", () => {
    const original = new Float32Array([0.1, 0.2, 0.3, -0.5, 0.8]);
    const blob = serializeEmbedding(original);
    expect(blob).toBeInstanceOf(Uint8Array);
    expect(blob.length).toBe(original.length * 4);

    const restored = deserializeEmbedding(blob);
    expect(restored).toBeInstanceOf(Float32Array);
    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]!).toBeCloseTo(original[i]!, 5);
    }
  });

  it("should handle zero-copy when buffer is aligned", () => {
    const original = new Float32Array([1.0, 2.0, 3.0]);
    const blob = serializeEmbedding(original);
    // Serialized blob should be aligned because original buffer is aligned
    expect(blob.byteOffset % 4).toBe(0);
    const restored = deserializeEmbedding(blob);
    expect(restored.length).toBe(3);
    expect(restored[0]).toBe(1.0);
  });

  it("should handle unaligned buffer (SDD-02 §2.3 mitigation)", () => {
    // Create a buffer with unaligned Float32Array
    const raw = new Uint8Array(17); // 16 bytes + 1 padding = 4 floats + 1 byte
    const alignedFloats = new Float32Array(raw.buffer, 0, 4);
    alignedFloats[0] = 1.0;
    alignedFloats[1] = 2.0;
    alignedFloats[2] = 3.0;
    alignedFloats[3] = 4.0;

    // Now create a view at offset 1 (unaligned)
    const unaligned = new Uint8Array(raw.buffer, 1, 16);

    // This should NOT throw RangeError
    expect(() => {
      const restored = deserializeEmbedding(unaligned);
      expect(restored.length).toBe(4);
    }).not.toThrow();
  });

  it("should fail dimension validation on mismatch", () => {
    const a = new Float32Array(128);
    const b = new Float32Array(256);
    expect(() => validateDimensions(a, b)).toThrow(/dimension mismatch/i);
  });

  it("should return dimension when lengths match", () => {
    const a = new Float32Array(384);
    const b = new Float32Array(384);
    expect(validateDimensions(a, b)).toBe(384);
  });
});

// ─── Cosine Similarity (SDD-02 §3.2) ─────────────────────────

describe("cosineSimilarity", () => {
  it("should return 1.0 for identical vectors", () => {
    const v = new Float32Array([1.0, 2.0, 3.0]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("should return 0.0 for orthogonal vectors", () => {
    const a = new Float32Array([1.0, 0.0]);
    const b = new Float32Array([0.0, 1.0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it("should return -1.0 for opposite vectors", () => {
    const a = new Float32Array([1.0, 1.0]);
    const b = new Float32Array([-1.0, -1.0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("should return 0.0 for zero-vector (division-by-zero prevention)", () => {
    const a = new Float32Array([0.0, 0.0, 0.0]);
    const b = new Float32Array([1.0, 2.0, 3.0]);
    expect(cosineSimilarity(a, b)).toBe(0.0);
  });

  it("should return 0.0 for empty vectors", () => {
    const a = new Float32Array(0);
    const b = new Float32Array(0);
    expect(cosineSimilarity(a, b)).toBe(0.0);
  });

  it("should clamp overshooting values to [-1.0, 1.0]", () => {
    // collinear vectors may produce slightly above 1.0 due to float precision
    const v = new Float32Array(1000).fill(0.001);
    const result = cosineSimilarity(v, v);
    expect(result).toBeLessThanOrEqual(1.0);
    expect(result).toBeGreaterThanOrEqual(-1.0);
  });

  it("should throw on dimension mismatch", () => {
    const a = new Float32Array(128);
    const b = new Float32Array(256);
    expect(() => cosineSimilarity(a, b)).toThrow(/dimension mismatch/i);
  });
});

// ─── Vector Search (SDD-02 §3) ────────────────────────────────

describe("vectorSearch", () => {
  it("should return empty array when no embeddings exist", () => {
    const results = vectorSearch(db, PROJECT, makeEmbedding(4));
    expect(results).toEqual([]);
  });

  it("should find memories by embedding similarity", () => {
    // Seed: one production 384d memory and one legacy low-dimensional memory
    const emb = makeUnitEmbedding(384, 0);
    remember(db, {
      kind: "fact",
      text: "Vector search test: TypeScript is the project language",
      projectId: PROJECT,
      source: "cli:user:explicit",
      embedding: emb,
    });
    remember(db, {
      kind: "fact",
      text: "Vector search test: legacy low-dimensional embedding",
      projectId: PROJECT,
      source: "cli:user:explicit",
      embedding: makeEmbedding(4, 0.1),
    });

    // Search with a slightly different embedding
    const queryEmb = makeUnitEmbedding(384, 0);
    const results = vectorSearch(db, PROJECT, queryEmb, 5);

    const found = results.find((r) => r.item.text.includes("TypeScript"));
    expect(found).toBeDefined();
    expect(found?.similarity).toBeGreaterThan(0.99); // nearly identical
  });

  it("should respect limit parameter", () => {
    // Seed multiple embeddings
    for (let i = 0; i < 5; i++) {
      const emb = makeUnitEmbedding(384, 20 + i);
      remember(db, {
        kind: "fact",
        text: `Vector limit test ${i}`,
        projectId: PROJECT,
        source: "cli:user:explicit",
        embedding: emb,
      });
    }

    const queryEmb = makeUnitEmbedding(384, 22);
    const results = vectorSearch(db, PROJECT, queryEmb, 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("should skip embeddings with dimension mismatch", () => {
    const emb = makeEmbedding(8, 0.3); // 8-dim, different from query's 4-dim
    remember(db, {
      kind: "fact",
      text: "Vector dim mismatch test",
      projectId: PROJECT,
      source: "cli:user:explicit",
      embedding: emb,
    });

    const queryEmb = makeEmbedding(4, 0.5); // 4-dim query
    const results = vectorSearch(db, PROJECT, queryEmb);
    // The 8-dim memory should be skipped
    const mismatched = results.filter((r) => r.item.text.includes("dim mismatch"));
    expect(mismatched.length).toBe(0);
  });
});

// ─── Hybrid RRF Retrieval (SDD-02 §4) ─────────────────────────

describe("hybridRetrieve", () => {
  it("should return empty array when no query and no embedding", () => {
    const results = hybridRetrieve(db, PROJECT, null, null);
    expect(results).toEqual([]);
  });

  it("should return FTS5-only results when no embedding provided", () => {
    // Seed FTS5-searchable memory
    remember(db, {
      kind: "fact",
      text: "Hybrid test: unique keyword xylophone for RRF testing",
      projectId: PROJECT,
      source: "cli:user:explicit",
    });

    const results = hybridRetrieve(db, PROJECT, "xylophone", null, 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.rrfScore).toBeGreaterThan(0);
    // Only lexical rank available, no semantic
    expect(results[0]?.semanticRank).toBeNull();
  });

  it("should return vector-only results when no query text", () => {
    const emb = makeUnitEmbedding(384, 40);
    remember(db, {
      kind: "fact",
      text: "Hybrid vector-only test",
      projectId: PROJECT,
      source: "cli:user:explicit",
      embedding: emb,
    });

    const queryEmb = makeUnitEmbedding(384, 40);
    const results = hybridRetrieve(db, PROJECT, null, queryEmb, 5);
    expect(results.length).toBeGreaterThan(0);
    // Only semantic rank, no lexical
    expect(results[0]?.lexicalRank).toBeNull();
  });

  it("should fuse FTS5 and vector results with RRF (k=60)", () => {
    // Verify RRF formula: Document appearing in both should score higher
    const emb = makeUnitEmbedding(384, 60);
    remember(db, {
      kind: "fact",
      text: "RRF fusion test: TypeScript strict mode configuration",
      projectId: PROJECT,
      source: "cli:user:explicit",
      embedding: emb,
    });

    const queryEmb = makeUnitEmbedding(384, 60);
    const results = hybridRetrieve(db, PROJECT, "TypeScript strict", queryEmb, 5);

    expect(results.length).toBeGreaterThan(0);
    // Results should be sorted by rrfScore descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]?.rrfScore).toBeGreaterThanOrEqual(results[i]?.rrfScore);
    }
    // RRF scores should be non-negative
    for (const r of results) {
      expect(r.rrfScore).toBeGreaterThanOrEqual(0);
    }
  });

  it("should respect limit parameter", () => {
    const queryEmb = makeEmbedding(4, 0.5);
    const results = hybridRetrieve(db, PROJECT, "test", queryEmb, 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

// ─── Embedding storage round-trip ─────────────────────────────

describe("embedding storage round-trip", () => {
  it("should auto-generate embeddings when remembering text without an explicit vector", () => {
    const item = remember(db, {
      kind: "fact",
      text: "Local provider auto embedding unique autosemantic needle",
      projectId: PROJECT,
      source: "cli:user:explicit",
    });

    expect(item.embedding).toBeInstanceOf(Uint8Array);
    expect(item.embedding?.length).toBe(localEmbeddingProvider.dimensions * 4);

    const results = vectorSearch(db, PROJECT, embedText("autosemantic needle"), 5);
    expect(results.some((r) => r.item.id === item.id)).toBe(true);
  });

  it("should auto-embed query text for service hybrid recall", () => {
    const item = remember(db, {
      kind: "fact",
      text: "Hybrid local query embedding unique servicehybrid marker",
      projectId: PROJECT,
      source: "cli:user:explicit",
    });

    const results = recall(db, PROJECT, "servicehybrid marker", 5, "hybrid");
    expect(results.some((r) => r.item.id === item.id)).toBe(true);
  });

  it("should store and retrieve embeddings via remember + search", () => {
    const emb = makeUnitEmbedding(384, 80);
    const item = remember(db, {
      kind: "fact",
      text: "Round-trip embedding test",
      projectId: PROJECT,
      source: "cli:user:explicit",
      embedding: emb,
    });

    expect(item.id).toBeDefined();

    // Vector search should find it
    const results = vectorSearch(db, PROJECT, emb, 5);
    const found = results.filter((r) => r.item.id === item.id);
    expect(found.length).toBe(1);
    expect(found[0]?.similarity).toBeCloseTo(1.0, 4);
  });

  it("should not hydrate embedding blobs for FTS/list read paths", () => {
    const emb = new Float32Array([0.9, 0.8, 0.7, 0.6]);
    remember(db, {
      kind: "fact",
      text: "Projection optimization test keyword hydratecheck",
      projectId: PROJECT,
      source: "cli:user:explicit",
      embedding: emb,
    });

    const listItem = listAll(db, PROJECT).find((item) => item.text.includes("hydratecheck"));
    expect(listItem).toBeDefined();
    expect(listItem?.embedding).toBeNull();

    const recallItem = recall(db, PROJECT, "hydratecheck", 1)[0]?.item;
    expect(recallItem.embedding).toBeNull();
  });
});
