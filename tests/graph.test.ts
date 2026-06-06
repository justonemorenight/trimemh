import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";

import { closeDb, getDb, runMigrations } from "../src/persistence/db";
import {
  approveMemoryLinkProposal,
  createMemoryCodeLink,
  createMemoryEdge,
  createOrGetCodeEntity,
  getCodeImpact,
  getMemoriesForCode,
  getRelatedMemories,
  proposeMemoryCodeLink,
  proposeMemoryEdge,
  rejectMemoryLinkProposal,
  remember,
} from "../src/service";

const TEST_DB = "/tmp/memh-test-graph.sqlite";
const PROJECT = "graph-test-project";
const OTHER_PROJECT = "graph-other-project";

let db: Database;
let memoryA: string;
let memoryB: string;
let memoryC: string;

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

  memoryA = remember(db, {
    kind: "decision",
    text: "Graph test: choose Bun as runtime",
    projectId: PROJECT,
    source: "cli:user:explicit",
  }).id;
  memoryB = remember(db, {
    kind: "fact",
    text: "Graph test: Bun has built-in SQLite",
    projectId: PROJECT,
    source: "cli:user:explicit",
  }).id;
  memoryC = remember(db, {
    kind: "procedure",
    text: "Graph test: run migrations before tests",
    projectId: PROJECT,
    source: "cli:user:explicit",
  }).id;
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

describe("Memory graph + code links", () => {
  it("should let a user create a memory edge directly", () => {
    const edge = createMemoryEdge(db, {
      projectId: PROJECT,
      sourceMemoryId: memoryB,
      targetMemoryId: memoryA,
      relation: "supports",
      source: "cli:user:explicit",
      rationale: "Bun SQLite support was part of the runtime decision",
    });
    expect(edge.id).toBeDefined();
    expect(edge.relation).toBe("supports");
  });

  it("should reject self-edges and duplicate edges", () => {
    expect(() =>
      createMemoryEdge(db, {
        projectId: PROJECT,
        sourceMemoryId: memoryA,
        targetMemoryId: memoryA,
        relation: "relates_to",
        source: "cli:user:explicit",
      }),
    ).toThrow(/itself/);

    expect(() =>
      createMemoryEdge(db, {
        projectId: PROJECT,
        sourceMemoryId: memoryB,
        targetMemoryId: memoryA,
        relation: "supports",
        source: "cli:user:explicit",
        rationale: "Duplicate",
      }),
    ).toThrow(/Duplicate/);
  });

  it("should reject cross-project memory edges", () => {
    const other = remember(db, {
      kind: "fact",
      text: "Graph test: other project memory",
      projectId: OTHER_PROJECT,
      source: "cli:user:explicit",
    });

    expect(() =>
      createMemoryEdge(db, {
        projectId: PROJECT,
        sourceMemoryId: memoryA,
        targetMemoryId: other.id,
        relation: "relates_to",
        source: "cli:user:explicit",
      }),
    ).toThrow(/different project/);
  });

  it("should require rationale for contradicts, supersedes, and depends_on", () => {
    expect(() =>
      createMemoryEdge(db, {
        projectId: PROJECT,
        sourceMemoryId: memoryA,
        targetMemoryId: memoryB,
        relation: "depends_on",
        source: "cli:user:explicit",
      }),
    ).toThrow(/rationale/);
  });

  it("should create pending memory edge proposals and approve them", () => {
    const proposal = proposeMemoryEdge(db, {
      projectId: PROJECT,
      sourceMemoryId: memoryA,
      targetMemoryId: memoryC,
      relation: "depends_on",
      proposedBy: "mcp:agent",
      rationale: "Runtime decisions depend on reliable migration flow",
    });

    expect(proposal.status).toBe("pending");
    expect(proposal.proposal_type).toBe("memory_edge");

    const created = approveMemoryLinkProposal(db, PROJECT, proposal.id, "user");
    expect(created.id).toBeDefined();
    expect(created.relation).toBe("depends_on");
  });

  it("should reject link proposals without creating edges", () => {
    const before = db.query("SELECT COUNT(*) as cnt FROM memory_edges;").get() as { cnt: number };

    const proposal = proposeMemoryEdge(db, {
      projectId: PROJECT,
      sourceMemoryId: memoryC,
      targetMemoryId: memoryB,
      relation: "derived_from",
      proposedBy: "mcp:agent",
      rationale: "Temporary proposal for rejection",
    });

    const rejected = rejectMemoryLinkProposal(db, PROJECT, proposal.id, "Not useful", "user");
    expect(rejected.status).toBe("rejected");
    expect(rejected.decision_note).toBe("Not useful");

    const after = db.query("SELECT COUNT(*) as cnt FROM memory_edges;").get() as { cnt: number };
    expect(after.cnt).toBe(before.cnt);
  });

  it("should return 1-hop and 2-hop related memories", () => {
    const oneHop = getRelatedMemories(db, PROJECT, memoryB, 1);
    expect(oneHop.some((r) => r.item.id === memoryA)).toBe(true);
    expect(oneHop.some((r) => r.item.id === memoryC)).toBe(false);

    const twoHop = getRelatedMemories(db, PROJECT, memoryB, 2);
    expect(twoHop.some((r) => r.item.id === memoryC)).toBe(true);
  });

  it("should reuse code entities with the same entity_key", () => {
    const a = createOrGetCodeEntity(db, {
      projectId: PROJECT,
      entityType: "function",
      path: "src/config.ts",
      symbol: "loadConfig",
      lineStart: 20,
      lineEnd: 60,
    });
    const b = createOrGetCodeEntity(db, {
      projectId: PROJECT,
      entityType: "function",
      path: "src/config.ts",
      symbol: "loadConfig",
      lineStart: 20,
      lineEnd: 60,
    });
    expect(b.id).toBe(a.id);
  });

  it("should create code links and find memories for path/symbol", () => {
    const link = createMemoryCodeLink(db, {
      projectId: PROJECT,
      memoryId: memoryA,
      entityType: "function",
      path: "src/config.ts",
      symbol: "loadConfig",
      lineStart: 20,
      lineEnd: 60,
      relation: "documents",
      source: "cli:user:explicit",
      rationale: "Decision mentions config behavior",
    });
    expect(link.id).toBeDefined();

    const results = getMemoriesForCode(db, PROJECT, "src/config.ts", "loadConfig");
    expect(results.some((r) => r.item.id === memoryA)).toBe(true);
  });

  it("should explain code impact for a path and symbol", () => {
    const impact = getCodeImpact(db, {
      projectId: PROJECT,
      path: "src/config.ts",
      symbol: "loadConfig",
      depth: 2,
    });

    expect(impact.summary.entity_count).toBeGreaterThan(0);
    expect(impact.linked_memories.some((entry) => entry.item.id === memoryA)).toBe(true);
    expect(impact.related_memories.some((entry) => entry.item.id === memoryB)).toBe(true);
    expect(
      impact.affected_paths.some(
        (entry) => entry.entity.path === "src/config.ts" && entry.entity.symbol === "loadConfig",
      ),
    ).toBe(true);
  });

  it("should create pending code link proposals and approve them", () => {
    const proposal = proposeMemoryCodeLink(db, {
      projectId: PROJECT,
      memoryId: memoryC,
      entityType: "file",
      path: "src/db.ts",
      relation: "warns_about",
      proposedBy: "mcp:agent",
      rationale: "Migration-related procedure applies to db.ts",
    });

    expect(proposal.status).toBe("pending");
    expect(proposal.proposal_type).toBe("memory_code_link");

    const created = approveMemoryLinkProposal(db, PROJECT, proposal.id, "user");
    expect(created.id).toBeDefined();
    expect(created.relation).toBe("warns_about");
  });

  it("should cascade edges and code links when memory is deleted", () => {
    const temp = remember(db, {
      kind: "fact",
      text: "Graph cascade test memory",
      projectId: PROJECT,
      source: "cli:user:explicit",
    });

    createMemoryEdge(db, {
      projectId: PROJECT,
      sourceMemoryId: temp.id,
      targetMemoryId: memoryA,
      relation: "relates_to",
      source: "cli:user:explicit",
    });
    createMemoryCodeLink(db, {
      projectId: PROJECT,
      memoryId: temp.id,
      entityType: "file",
      path: "src/schema.ts",
      relation: "relates_to",
      source: "cli:user:explicit",
    });

    db.run("DELETE FROM memory_items WHERE id = ?;", [temp.id]);

    const edgeCount = db
      .query(
        "SELECT COUNT(*) as cnt FROM memory_edges WHERE source_memory_id = ? OR target_memory_id = ?;",
      )
      .get(temp.id, temp.id) as { cnt: number };
    const linkCount = db
      .query("SELECT COUNT(*) as cnt FROM memory_code_links WHERE memory_id = ?;")
      .get(temp.id) as { cnt: number };

    expect(edgeCount.cnt).toBe(0);
    expect(linkCount.cnt).toBe(0);
  });
});
