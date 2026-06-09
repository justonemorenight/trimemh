import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";

import { closeDb, getDb, runMigrations } from "../src/persistence/db";
import { serializeEmbedding } from "../src/retrieval/embedding";
import { sqliteVecVersion, vectorBackend } from "../src/retrieval/vector";

const TEST_DB = "/tmp/memh-test-db.sqlite";

let db: Database;

beforeAll(() => {
  // Clean up from previous runs
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

describe("Database", () => {
  it("should create memory_items table", () => {
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_items';")
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.name).toBe("memory_items");
  });

  it("should create memory_proposals table", () => {
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_proposals';")
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
  });

  it("should create audit_events table", () => {
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_events';")
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
  });

  it("should create graph and code link tables", () => {
    for (const table of [
      "memory_edges",
      "code_entities",
      "memory_code_links",
      "memory_link_proposals",
    ]) {
      const row = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?;")
        .get(table) as { name: string } | undefined;
      expect(row).toBeDefined();
    }
  });

  it("should create lifecycle and session registry tables", () => {
    for (const table of ["memory_lifecycle_events", "memory_sessions"]) {
      const row = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?;")
        .get(table) as { name: string } | undefined;
      expect(row).toBeDefined();
    }
  });

  it("should create FTS5 virtual table", () => {
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_items_fts';")
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
  });

  it("should load sqlite-vec as the hard vector backend", () => {
    expect(vectorBackend(db)).toBe("sqlite-vec");
    expect(sqliteVecVersion(db)).toMatch(/^v?\d+\.\d+\.\d+/);
    const row = db.query("SELECT vec_version() AS version;").get() as { version: string };
    expect(row.version).toBe(sqliteVecVersion(db));
  });

  it("should create sqlite-vec memory vector table and sync triggers", () => {
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_vectors';")
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();

    const triggers = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'memory_vectors_a%';",
      )
      .all() as { name: string }[];
    const names = triggers.map((t) => t.name).sort();
    expect(names).toEqual(["memory_vectors_ad", "memory_vectors_ai", "memory_vectors_au"]);
  });

  it("should create FTS5 sync triggers", () => {
    const triggers = db
      .query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'memory_items_a%';")
      .all() as { name: string }[];
    expect(triggers.length).toBe(3);
    const names = triggers.map((t) => t.name).sort();
    expect(names).toContain("memory_items_ai");
    expect(names).toContain("memory_items_ad");
    expect(names).toContain("memory_items_au");
  });

  it("should run migrations idempotently", () => {
    // Running migrations again should not error
    expect(() => runMigrations(db)).not.toThrow();

    const rows = db.query("SELECT COUNT(*) as cnt FROM schema_migrations;").get() as {
      cnt: number;
    };
    // Should still have just the known migrations
    expect(rows.cnt).toBe(7);
  });

  it("should have WAL mode enabled", () => {
    const row = db.query("PRAGMA journal_mode;").get() as { journal_mode: string };
    expect(row.journal_mode).toBe("wal");
  });

  it("should apply write-throughput SQLite pragmas", () => {
    const synchronous = db.query("PRAGMA synchronous;").get() as { synchronous: number };
    const walAutoCheckpoint = db.query("PRAGMA wal_autocheckpoint;").get() as {
      wal_autocheckpoint: number;
    };
    const journalSizeLimit = db.query("PRAGMA journal_size_limit;").get() as {
      journal_size_limit: number;
    };
    const tempStore = db.query("PRAGMA temp_store;").get() as { temp_store: number };

    expect(synchronous.synchronous).toBe(1);
    expect(walAutoCheckpoint.wal_autocheckpoint).toBe(1000);
    expect(journalSizeLimit.journal_size_limit).toBe(67108864);
    expect(tempStore.temp_store).toBe(2);
  });

  it("should enforce unique content_hash per project", () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO memory_items (id, project_id, kind, text, status, visibility, confidence, source, content_hash, evidence_json, metadata_json, embedding, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        "test1",
        "proj-1",
        "fact",
        "hello",
        "active",
        "private",
        0.5,
        "test",
        "abc123",
        "[]",
        "{}",
        null,
        now,
        now,
        null,
      ],
    );

    expect(() =>
      db.run(
        `INSERT INTO memory_items (id, project_id, kind, text, status, visibility, confidence, source, content_hash, evidence_json, metadata_json, embedding, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          "test2",
          "proj-1",
          "fact",
          "hello again",
          "active",
          "private",
          0.5,
          "test",
          "abc123",
          "[]",
          "{}",
          null,
          now,
          now,
          null,
        ],
      ),
    ).toThrow();

    // Cleanup
    db.run("DELETE FROM memory_items WHERE id IN ('test1', 'test2');");
  });

  it("should sync 384d embeddings into memory_vectors on insert/update/delete", () => {
    const now = new Date().toISOString();
    const embedding = serializeEmbedding(new Float32Array(384).fill(0.1));
    db.run(
      `INSERT INTO memory_items (id, project_id, kind, text, status, visibility, confidence, source, content_hash, evidence_json, metadata_json, embedding, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        "vec-sync-1",
        "proj-vec",
        "fact",
        "vector sync insert",
        "active",
        "private",
        0.5,
        "test",
        "vec-sync-hash-1",
        "[]",
        "{}",
        embedding,
        now,
        now,
        null,
      ],
    );

    let vectorRow = db
      .query("SELECT memory_id, status FROM memory_vectors WHERE project_id = ? AND memory_id = ?;")
      .get("proj-vec", "vec-sync-1") as { memory_id: string; status: string } | undefined;
    expect(vectorRow).toEqual({ memory_id: "vec-sync-1", status: "active" });

    db.run("UPDATE memory_items SET status = 'archived', updated_at = ? WHERE id = ?;", [
      now,
      "vec-sync-1",
    ]);
    vectorRow = db
      .query("SELECT memory_id, status FROM memory_vectors WHERE project_id = ? AND memory_id = ?;")
      .get("proj-vec", "vec-sync-1") as { memory_id: string; status: string } | undefined;
    expect(vectorRow).toEqual({ memory_id: "vec-sync-1", status: "archived" });

    db.run("DELETE FROM memory_items WHERE id = ?;", ["vec-sync-1"]);
    vectorRow = db
      .query("SELECT memory_id, status FROM memory_vectors WHERE project_id = ? AND memory_id = ?;")
      .get("proj-vec", "vec-sync-1") as { memory_id: string; status: string } | undefined;
    expect(vectorRow).toBeNull();
  });

  it("should not index non-384d legacy embeddings into memory_vectors", () => {
    const now = new Date().toISOString();
    const embedding = serializeEmbedding(new Float32Array(4).fill(0.1));
    db.run(
      `INSERT INTO memory_items (id, project_id, kind, text, status, visibility, confidence, source, content_hash, evidence_json, metadata_json, embedding, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        "vec-legacy-1",
        "proj-vec",
        "fact",
        "legacy vector insert",
        "active",
        "private",
        0.5,
        "test",
        "vec-legacy-hash-1",
        "[]",
        "{}",
        embedding,
        now,
        now,
        null,
      ],
    );

    const vectorRow = db
      .query("SELECT memory_id FROM memory_vectors WHERE project_id = ? AND memory_id = ?;")
      .get("proj-vec", "vec-legacy-1") as { memory_id: string } | undefined;
    expect(vectorRow).toBeNull();

    db.run("DELETE FROM memory_items WHERE id = ?;", ["vec-legacy-1"]);
  });
});
