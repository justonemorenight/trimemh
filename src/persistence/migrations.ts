import type { Database } from "bun:sqlite";

const SQLITE_VEC_DIMENSIONS = 384;

// ─── Migration infrastructure ──────────────────────────────────────

function ensureMigrationsTable(database: Database): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function recordMigration(database: Database, version: number, name: string): void {
  database.run("INSERT INTO schema_migrations (version, name) VALUES (?, ?);", [version, name]);
}

// ─── Migration definitions ────────────────────────────────────────

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial-schema",
    sql: `
      CREATE TABLE memory_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        visibility TEXT NOT NULL DEFAULT 'private',
        confidence REAL NOT NULL DEFAULT 0.5,
        source TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        embedding BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT
      );

      CREATE INDEX idx_memory_project_kind ON memory_items(project_id, kind);
      CREATE INDEX idx_memory_project_status ON memory_items(project_id, status);
      CREATE UNIQUE INDEX idx_memory_content_hash ON memory_items(project_id, content_hash);

      -- FTS5 external-content table tied to memory_items.rowid
      CREATE VIRTUAL TABLE memory_items_fts USING fts5(
        text,
        kind UNINDEXED,
        project_id UNINDEXED,
        content='memory_items',
        content_rowid='rowid'
      );

      -- FTS5 sync triggers
      CREATE TRIGGER memory_items_ai AFTER INSERT ON memory_items BEGIN
        INSERT INTO memory_items_fts(rowid, text, kind, project_id)
        VALUES (new.rowid, new.text, new.kind, new.project_id);
      END;

      CREATE TRIGGER memory_items_ad AFTER DELETE ON memory_items BEGIN
        INSERT INTO memory_items_fts(memory_items_fts, rowid, text, kind, project_id)
        VALUES('delete', old.rowid, old.text, old.kind, old.project_id);
      END;

      CREATE TRIGGER memory_items_au AFTER UPDATE ON memory_items BEGIN
        INSERT INTO memory_items_fts(memory_items_fts, rowid, text, kind, project_id)
        VALUES('delete', old.rowid, old.text, old.kind, old.project_id);
        INSERT INTO memory_items_fts(rowid, text, kind, project_id)
        VALUES (new.rowid, new.text, new.kind, new.project_id);
      END;

      CREATE TABLE memory_proposals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_memory_id TEXT,
        proposed_kind TEXT NOT NULL,
        proposed_text TEXT NOT NULL,
        proposed_by TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        rationale TEXT,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        decision_note TEXT
      );

      CREATE INDEX idx_proposals_project_status ON memory_proposals(project_id, status);

      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        event_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_audit_project ON audit_events(project_id, created_at);
      CREATE INDEX idx_audit_entity ON audit_events(entity_type, entity_id);
    `,
  },
  {
    version: 2,
    name: "memory-graph-and-code-links",
    sql: `
      CREATE TABLE memory_edges (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source_memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
        target_memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
        relation TEXT NOT NULL CHECK (relation IN ('supports', 'contradicts', 'depends_on', 'derived_from', 'supersedes', 'relates_to')),
        confidence REAL NOT NULL DEFAULT 0.5,
        source TEXT NOT NULL,
        rationale TEXT,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, source_memory_id, target_memory_id, relation),
        CHECK(source_memory_id <> target_memory_id)
      );

      CREATE INDEX idx_edges_project_source ON memory_edges(project_id, source_memory_id);
      CREATE INDEX idx_edges_project_target ON memory_edges(project_id, target_memory_id);
      CREATE INDEX idx_edges_relation ON memory_edges(project_id, relation);

      CREATE TABLE code_entities (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('file', 'function', 'class', 'module', 'section')),
        path TEXT NOT NULL,
        symbol TEXT,
        line_start INTEGER,
        line_end INTEGER,
        fingerprint TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, entity_key)
      );

      CREATE INDEX idx_code_entities_project_path ON code_entities(project_id, path);
      CREATE INDEX idx_code_entities_project_symbol ON code_entities(project_id, symbol);

      CREATE TABLE memory_code_links (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
        entity_id TEXT NOT NULL REFERENCES code_entities(id) ON DELETE CASCADE,
        relation TEXT NOT NULL CHECK (relation IN ('relates_to', 'documents', 'warns_about', 'implements', 'depends_on')),
        confidence REAL NOT NULL DEFAULT 0.5,
        source TEXT NOT NULL,
        rationale TEXT,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, memory_id, entity_id, relation)
      );

      CREATE INDEX idx_code_links_project_memory ON memory_code_links(project_id, memory_id);
      CREATE INDEX idx_code_links_project_entity ON memory_code_links(project_id, entity_id);

      CREATE TABLE memory_link_proposals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        proposal_type TEXT NOT NULL CHECK (proposal_type IN ('memory_edge', 'memory_code_link')),
        source_memory_id TEXT,
        target_memory_id TEXT,
        entity_type TEXT CHECK (entity_type IS NULL OR entity_type IN ('file', 'function', 'class', 'module', 'section')),
        path TEXT,
        symbol TEXT,
        line_start INTEGER,
        line_end INTEGER,
        fingerprint TEXT,
        relation TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        proposed_by TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        rationale TEXT,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        decision_note TEXT
      );

      CREATE INDEX idx_link_proposals_project_status ON memory_link_proposals(project_id, status);
      CREATE INDEX idx_link_proposals_project_type ON memory_link_proposals(project_id, proposal_type);
    `,
  },
  {
    version: 3,
    name: "explicit-rowid-and-foreign-keys",
    sql: `
      -- 1. Migrate memory_items to explicit rowid structure
      ALTER TABLE memory_items RENAME TO memory_items_old;

      CREATE TABLE memory_items (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        visibility TEXT NOT NULL DEFAULT 'private',
        confidence REAL NOT NULL DEFAULT 0.5,
        source TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        embedding BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        CHECK (kind IN ('preference', 'fact', 'decision', 'session_summary', 'code_context', 'procedure', 'mistake', 'trade_rule', 'security_rule')),
        CHECK (status IN ('active', 'archived', 'expired')),
        CHECK (visibility IN ('private', 'team', 'public')),
        CHECK (confidence >= 0.0 AND confidence <= 1.0)
      );

      INSERT INTO memory_items (
        rowid, id, project_id, kind, text, status, visibility, confidence,
        source, content_hash, evidence_json, metadata_json, embedding,
        created_at, updated_at, expires_at
      )
      SELECT
        rowid, id, project_id, kind, text, status, visibility, confidence,
        source, content_hash, evidence_json, metadata_json, embedding,
        created_at, updated_at, expires_at
      FROM memory_items_old;

      DROP TABLE memory_items_old;

      CREATE INDEX idx_memory_project_id ON memory_items(project_id, id);
      CREATE INDEX idx_memory_project_kind ON memory_items(project_id, kind);
      CREATE INDEX idx_memory_project_status ON memory_items(project_id, status);
      CREATE UNIQUE INDEX idx_memory_content_hash ON memory_items(project_id, content_hash);

      -- 2. Re-create FTS5 virtual table and synchronization triggers
      DROP TABLE IF EXISTS memory_items_fts;
      CREATE VIRTUAL TABLE memory_items_fts USING fts5(
        text,
        kind UNINDEXED,
        project_id UNINDEXED,
        content='memory_items',
        content_rowid='rowid'
      );

      CREATE TRIGGER memory_items_ai AFTER INSERT ON memory_items BEGIN
        INSERT INTO memory_items_fts(rowid, text, kind, project_id)
        VALUES (new.rowid, new.text, new.kind, new.project_id);
      END;

      CREATE TRIGGER memory_items_ad AFTER DELETE ON memory_items BEGIN
        INSERT INTO memory_items_fts(memory_items_fts, rowid, text, kind, project_id)
        VALUES('delete', old.rowid, old.text, old.kind, old.project_id);
      END;

      CREATE TRIGGER memory_items_au AFTER UPDATE ON memory_items BEGIN
        INSERT INTO memory_items_fts(memory_items_fts, rowid, text, kind, project_id)
        VALUES('delete', old.rowid, old.text, old.kind, old.project_id);
        INSERT INTO memory_items_fts(rowid, text, kind, project_id)
        VALUES (new.rowid, new.text, new.kind, new.project_id);
      END;

      INSERT INTO memory_items_fts(memory_items_fts) VALUES('rebuild');

      -- 3. Re-create memory_proposals to add Foreign Key constraint ON DELETE SET NULL
      ALTER TABLE memory_proposals RENAME TO memory_proposals_old;

      CREATE TABLE memory_proposals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_memory_id TEXT REFERENCES memory_items(id) ON DELETE SET NULL,
        proposed_kind TEXT NOT NULL,
        proposed_text TEXT NOT NULL,
        proposed_by TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        rationale TEXT,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        decision_note TEXT,
        CHECK (action IN ('create', 'update', 'delete')),
        CHECK (proposed_kind IN ('preference', 'fact', 'decision', 'session_summary', 'code_context', 'procedure', 'mistake', 'trade_rule', 'security_rule')),
        CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
        CHECK (status IN ('pending', 'approved', 'rejected'))
      );

      INSERT INTO memory_proposals (
        id, project_id, action, target_memory_id, proposed_kind, proposed_text,
        proposed_by, risk_level, status, rationale, evidence_json,
        created_at, decided_at, decided_by, decision_note
      )
      SELECT
        id, project_id, action, target_memory_id, proposed_kind, proposed_text,
        proposed_by, risk_level, status, rationale, evidence_json,
        created_at, decided_at, decided_by, decision_note
      FROM memory_proposals_old;

      DROP TABLE memory_proposals_old;

      CREATE INDEX idx_proposals_project_status ON memory_proposals(project_id, status);
    `,
  },
  {
    version: 4,
    name: "sqlite-vec-memory-vectors",
    sql: `
      CREATE VIRTUAL TABLE memory_vectors USING vec0(
        memory_rowid INTEGER PRIMARY KEY,
        embedding FLOAT[${SQLITE_VEC_DIMENSIONS}] distance_metric=cosine,
        project_id TEXT partition key,
        status TEXT,
        +memory_id TEXT
      );

      INSERT INTO memory_vectors(memory_rowid, embedding, project_id, status, memory_id)
      SELECT rowid, embedding, project_id, status, id
      FROM memory_items
      WHERE embedding IS NOT NULL
        AND length(embedding) = ${SQLITE_VEC_DIMENSIONS * 4};

      CREATE TRIGGER memory_vectors_ai AFTER INSERT ON memory_items
      WHEN new.embedding IS NOT NULL AND length(new.embedding) = ${SQLITE_VEC_DIMENSIONS * 4}
      BEGIN
        INSERT INTO memory_vectors(memory_rowid, embedding, project_id, status, memory_id)
        VALUES (new.rowid, new.embedding, new.project_id, new.status, new.id);
      END;

      CREATE TRIGGER memory_vectors_ad AFTER DELETE ON memory_items BEGIN
        DELETE FROM memory_vectors WHERE memory_rowid = old.rowid;
      END;

      CREATE TRIGGER memory_vectors_au AFTER UPDATE ON memory_items BEGIN
        DELETE FROM memory_vectors WHERE memory_rowid = old.rowid;
        INSERT INTO memory_vectors(memory_rowid, embedding, project_id, status, memory_id)
        SELECT new.rowid, new.embedding, new.project_id, new.status, new.id
        WHERE new.embedding IS NOT NULL
          AND length(new.embedding) = ${SQLITE_VEC_DIMENSIONS * 4};
      END;
    `,
  },
  {
    version: 5,
    name: "repair-graph-foreign-keys",
    sql: `
      ALTER TABLE memory_edges RENAME TO memory_edges_old;

      CREATE TABLE memory_edges (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source_memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
        target_memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
        relation TEXT NOT NULL CHECK (relation IN ('supports', 'contradicts', 'depends_on', 'derived_from', 'supersedes', 'relates_to')),
        confidence REAL NOT NULL DEFAULT 0.5,
        source TEXT NOT NULL,
        rationale TEXT,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, source_memory_id, target_memory_id, relation),
        CHECK(source_memory_id <> target_memory_id)
      );

      INSERT INTO memory_edges (
        id, project_id, source_memory_id, target_memory_id, relation,
        confidence, source, rationale, evidence_json, metadata_json,
        created_at, updated_at
      )
      SELECT
        id, project_id, source_memory_id, target_memory_id, relation,
        confidence, source, rationale, evidence_json, metadata_json,
        created_at, updated_at
      FROM memory_edges_old;

      DROP TABLE memory_edges_old;

      CREATE INDEX idx_edges_project_source ON memory_edges(project_id, source_memory_id);
      CREATE INDEX idx_edges_project_target ON memory_edges(project_id, target_memory_id);
      CREATE INDEX idx_edges_relation ON memory_edges(project_id, relation);

      ALTER TABLE memory_code_links RENAME TO memory_code_links_old;

      CREATE TABLE memory_code_links (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
        entity_id TEXT NOT NULL REFERENCES code_entities(id) ON DELETE CASCADE,
        relation TEXT NOT NULL CHECK (relation IN ('relates_to', 'documents', 'warns_about', 'implements', 'depends_on')),
        confidence REAL NOT NULL DEFAULT 0.5,
        source TEXT NOT NULL,
        rationale TEXT,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, memory_id, entity_id, relation)
      );

      INSERT INTO memory_code_links (
        id, project_id, memory_id, entity_id, relation, confidence,
        source, rationale, evidence_json, metadata_json, created_at, updated_at
      )
      SELECT
        id, project_id, memory_id, entity_id, relation, confidence,
        source, rationale, evidence_json, metadata_json, created_at, updated_at
      FROM memory_code_links_old;

      DROP TABLE memory_code_links_old;

      CREATE INDEX idx_code_links_project_memory ON memory_code_links(project_id, memory_id);
      CREATE INDEX idx_code_links_project_entity ON memory_code_links(project_id, entity_id);
    `,
  },
];

// ─── Run all pending migrations ──────────────────────────────────

export function runMigrations(database: Database): void {
  ensureMigrationsTable(database);

  // Disable foreign keys temporarily during migration runs to allow renaming tables
  database.run("PRAGMA foreign_keys = OFF;");

  try {
    const applied = new Set(
      database
        .query("SELECT version FROM schema_migrations;")
        .all()
        .map((r: unknown) => (r as { version: number }).version),
    );

    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) {
        continue;
      }

      database.run("BEGIN;");
      try {
        // Use exec() for multi-statement SQL — handles triggers with internal semicolons
        database.exec(m.sql);

        recordMigration(database, m.version, m.name);
        database.run("COMMIT;");
        console.log(`[triMemh] Migration ${m.version}: ${m.name} — applied`);
      } catch (err) {
        database.run("ROLLBACK;");
        // biome-ignore lint/nursery/useErrorCause: warning suppression
        throw new Error(`Migration ${m.version} "${m.name}" failed: ${err}`);
      }
    }
  } finally {
    // Re-enable foreign keys
    database.run("PRAGMA foreign_keys = ON;");
  }
}
