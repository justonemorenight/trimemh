import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MemoryItem } from "../src/domain/schema";
import { closeDb, getDb, runMigrations } from "../src/persistence/db";
import { applyFeedback } from "../src/retrieval/feedback";
import { scoreRecall } from "../src/retrieval/scoring";
import { shouldAutoApproveMemory } from "../src/service/auto-approval";
import { suggestCodeLinksFromText } from "../src/service/code-link-suggest";
import { resolveMemoryId } from "../src/service/id-resolution";
import { mcpPropose } from "../src/service/mcp-service";
import { extractFilePaths, looksLikeToolingMemory } from "../src/service/path-extract";
import {
  findSimilarPendingProposal,
  formatProposalBatchHints,
} from "../src/service/proposal-dedup";
import { propose } from "../src/service/proposal-service";

const ROOT = "/tmp/trimemh-dx-tests";
const PROJECT = "dx-test-project";
let counter = 0;

function fixture(): string {
  const dir = join(ROOT, `case-${counter++}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".memh.toml"), `project_id = "${PROJECT}"\n`);
  return dir;
}

function seedItem(partial: Partial<MemoryItem> & Pick<MemoryItem, "id" | "text">): MemoryItem {
  const now = new Date().toISOString();
  return {
    id: partial.id,
    project_id: PROJECT,
    kind: partial.kind ?? "fact",
    text: partial.text,
    status: partial.status ?? "active",
    visibility: "private",
    confidence: 0.8,
    source: "test",
    content_hash: partial.id,
    evidence_json: "[]",
    metadata_json: partial.metadata_json ?? "{}",
    embedding: null,
    created_at: now,
    updated_at: now,
    expires_at: null,
  };
}

afterEach(() => {
  closeDb();
  rmSync(ROOT, { recursive: true, force: true });
});

describe("auto-approve policy", () => {
  it("auto-approves medium-risk MCP proposals by default", () => {
    const decision = shouldAutoApproveMemory({
      kind: "session_summary",
      source: "mcp:agent",
      confidence: 0.7,
    });
    expect(decision.autoApprove).toBe(true);
  });

  it("honors require_review over auto-approve defaults", () => {
    const decision = shouldAutoApproveMemory({
      kind: "fact",
      source: "mcp:agent",
      requireReview: true,
    });
    expect(decision.autoApprove).toBe(false);
  });

  it("honors auto_approve=true for low-risk kinds", () => {
    const decision = shouldAutoApproveMemory({
      kind: "tooling",
      source: "mcp:agent",
      autoApprove: true,
    });
    expect(decision.autoApprove).toBe(true);
  });
});

describe("id resolution", () => {
  it("resolves memory id prefixes within a project", () => {
    const dir = fixture();
    const db = getDb(join(dir, ".trimemh", "memory.db"));
    runMigrations(db);
    const fullId = "abc12345-1111-2222-3333-444455556666";
    db.run(
      `INSERT INTO memory_items (
        id, project_id, kind, text, status, visibility, confidence,
        source, content_hash, evidence_json, metadata_json, embedding,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, 'fact', 'hello', 'active', 'private', 0.8, 'test', 'hash', '[]', '{}', NULL, datetime('now'), datetime('now'), NULL);`,
      [fullId, PROJECT],
    );

    const resolved = resolveMemoryId(db, PROJECT, "abc12345");
    expect(resolved.id).toBe(fullId);
  });
});

describe("proposal dedup", () => {
  it("finds similar pending session summaries", () => {
    const dir = fixture();
    const db = getDb(join(dir, ".trimemh", "memory.db"));
    runMigrations(db);
    propose(db, {
      kind: "session_summary",
      text: "Session summary setup Tailwind CSS and Biome formatter in frontend",
      projectId: PROJECT,
      proposedBy: "mcp:agent",
    });

    const similar = findSimilarPendingProposal(
      db,
      PROJECT,
      "session_summary",
      "Session summary configured Tailwind CSS and Biome in frontend app",
    );
    expect(similar).not.toBeNull();
  });

  it("suggests batch hints when many pending proposals share a kind", () => {
    const proposals = Array.from({ length: 4 }, (_, index) => ({
      id: `p-${index}`,
      project_id: PROJECT,
      action: "create" as const,
      target_memory_id: null,
      proposed_kind: "session_summary" as const,
      proposed_text: `summary ${index}`,
      proposed_by: "mcp:agent",
      risk_level: "medium" as const,
      status: "pending" as const,
      rationale: null,
      evidence_json: "[]",
      created_at: new Date().toISOString(),
      decided_at: null,
      decided_by: null,
      decision_note: null,
    }));

    const hints = formatProposalBatchHints(proposals);
    expect(hints.some((line) => line.includes("Batch hint"))).toBe(true);
  });
});

describe("tooling kind and path extract", () => {
  it("extracts file paths from memory text", () => {
    const paths = extractFilePaths(
      "Configured Biome in frontend/biome.json and frontend/package.json",
    );
    expect(paths).toContain("frontend/biome.json");
    expect(paths).toContain("frontend/package.json");
  });

  it("suggests code links from extracted paths", () => {
    const links = suggestCodeLinksFromText("Setup Tailwind in frontend/tailwind.config.ts");
    expect(links[0]?.path).toBe("frontend/tailwind.config.ts");
  });

  it("detects tooling-like summaries", () => {
    expect(looksLikeToolingMemory("Configured Biome and Tailwind for frontend")).toBe(true);
  });

  it("creates tooling proposals through MCP", () => {
    const dir = fixture();
    const db = getDb(join(dir, ".trimemh", "memory.db"));
    runMigrations(db);
    const result = mcpPropose(db, {
      kind: "tooling",
      text: "Installed ky HTTP client in frontend/package.json",
      projectId: PROJECT,
      proposedBy: "mcp:agent",
      autoApprove: true,
    });
    expect(result.status).toBe("approved");
    expect(result.suggested_code_links?.some((link) => link.path.includes("package.json"))).toBe(
      true,
    );
  });
});

describe("specificity scoring", () => {
  it("penalizes bootstrap/generic memories for task-specific queries", () => {
    const generic = seedItem({
      id: "generic-1",
      kind: "fact",
      text: "triMemh attached to project",
      metadata_json: JSON.stringify({ specificity: "bootstrap" }),
    });
    const specific = seedItem({
      id: "specific-1",
      kind: "decision",
      text: "Frontend uses ky client with SSE streaming for run events in src/api/runs.ts",
    });

    const genericScore = scoreRecall({
      similarity: 0.8,
      ftsRank: 1,
      item: generic,
      accessCount: 1,
      feedbackScore: 0,
      graphDegree: 0,
      isCodePathMatch: false,
      isOperationalContext: false,
      query: "implement SSE run events in frontend/src/api/runs.ts",
    }).compositeScore;

    const specificScore = scoreRecall({
      similarity: 0.8,
      ftsRank: 1,
      item: specific,
      accessCount: 1,
      feedbackScore: 0,
      graphDegree: 0,
      isCodePathMatch: false,
      isOperationalContext: false,
      query: "implement SSE run events in frontend/src/api/runs.ts",
    }).compositeScore;

    expect(specificScore).toBeGreaterThan(genericScore);
  });
});

describe("feedback prefix ids", () => {
  it("accepts short memory id prefixes", () => {
    const dir = fixture();
    const db = getDb(join(dir, ".trimemh", "memory.db"));
    runMigrations(db);
    const fullId = "feed1234-aaaa-bbbb-cccc-dddddddddddd";
    db.run(
      `INSERT INTO memory_items (
        id, project_id, kind, text, status, visibility, confidence,
        source, content_hash, evidence_json, metadata_json, embedding,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, 'fact', 'useful memory', 'active', 'private', 0.8, 'test', 'hash2', '[]', '{}', NULL, datetime('now'), datetime('now'), NULL);`,
      [fullId, PROJECT],
    );

    const result = applyFeedback(db, {
      memoryId: "feed1234",
      useful: true,
      actor: "mcp:agent",
      projectId: PROJECT,
    });
    expect(result.memoryId).toBe(fullId);
  });
});
