import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";

import { createApi } from "../src/api";
import { closeDb, getDb, runMigrations } from "../src/persistence/db";
import { remember } from "../src/service";

const TEST_DB = "/tmp/memh-test-api.sqlite";
const PROJECT = "api-test-project";

let db: Database;
let app: ReturnType<typeof createApi>;

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

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  cleanupDb();
  db = getDb(TEST_DB);
  runMigrations(db);
  app = createApi({ db, projectId: PROJECT });
});

afterEach(() => {
  closeDb();
  cleanupDb();
});

describe("REST API", () => {
  it("returns status", async () => {
    const res = await app.request("/api/status");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(body.project_id).toBe(PROJECT);
  });

  it("allows low-risk direct remember and recall", async () => {
    const rememberRes = await app.request("/api/memories/remember", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "fact",
        text: "API test: REST adapter is backed by service.ts",
      }),
    });
    expect(rememberRes.status).toBe(201);

    const recallRes = await app.request("/api/memories/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "REST adapter", limit: 5 }),
    });
    expect(recallRes.status).toBe(200);
    const body = await json(recallRes);
    expect(body.success).toBe(true);
    expect(body.count).toBeGreaterThan(0);
  });

  it("supports vector and hybrid recall modes", async () => {
    // Seed some data with embedding first
    const explicitVector = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
    const emb = new Float32Array(explicitVector);
    const memory = remember(db, {
      kind: "fact",
      text: "API vector test memory content",
      projectId: PROJECT,
      source: "cli:user:explicit",
      embedding: emb,
    });
    remember(db, {
      kind: "fact",
      text: "API local auto vector provider unique apiautovector marker",
      projectId: PROJECT,
      source: "cli:user:explicit",
    });

    const getRes = await app.request(`/api/memories/${memory.id}`);
    expect(getRes.status).toBe(200);
    const getBody = await json(getRes);
    const getItem = getBody.data as Record<string, unknown>;
    expect(getItem.embedding).toBeUndefined();

    // Test vector recall
    const vectorRes = await app.request("/api/memories/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "vector",
        vector: explicitVector,
        limit: 5,
      }),
    });
    expect(vectorRes.status).toBe(200);
    const vectorBody = await json(vectorRes);
    expect(vectorBody.success).toBe(true);
    expect(vectorBody.mode).toBe("vector");
    expect(vectorBody.count).toBeGreaterThan(0);
    const vectorData = vectorBody.data as Array<{ item: Record<string, unknown> }>;
    expect(vectorData[0]?.item.embedding).toBeUndefined();

    const autoVectorRes = await app.request("/api/memories/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "vector",
        query: "apiautovector marker",
        limit: 5,
      }),
    });
    expect(autoVectorRes.status).toBe(200);
    const autoVectorBody = await json(autoVectorRes);
    expect(autoVectorBody.success).toBe(true);
    const autoVectorData = autoVectorBody.data as Array<{ item: Record<string, unknown> }>;
    expect(autoVectorData.some((r) => String(r.item.text).includes("apiautovector"))).toBe(true);

    // Test hybrid recall
    const hybridRes = await app.request("/api/memories/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "hybrid",
        query: "API vector test",
        vector: explicitVector,
        limit: 5,
      }),
    });
    expect(hybridRes.status).toBe(200);
    const hybridBody = await json(hybridRes);
    expect(hybridBody.success).toBe(true);
    expect(hybridBody.mode).toBe("hybrid");
    expect(hybridBody.count).toBeGreaterThan(0);
    const hybridData = hybridBody.data as Array<{ item: Record<string, unknown> }>;
    expect(hybridData[0]?.item.embedding).toBeUndefined();
  });

  it("blocks high and critical direct writes through the escalated write guard", async () => {
    const res = await app.request("/api/memories/remember", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "security_rule",
        text: "API test: never expose credentials in client code",
      }),
    });
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.success).toBe(false);
    expect(String(body.error)).toContain("Direct write blocked");
  });

  it("assembles runtime memory context XML", async () => {
    const memory = remember(db, {
      kind: "fact",
      text: "API runtime context unique apicontext marker",
      projectId: PROJECT,
      source: "cli:user:explicit",
    });

    const res = await app.request("/api/context/assemble", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "API runtime context unique apicontext marker",
        include_lineage_for_ids: [memory.id],
      }),
    });

    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.success).toBe(true);
    const data = body.data as {
      xml: string;
      selected_detail_ids: string[];
      lineage_ids: string[];
      state: { turn: number; active_detail_ids: string[] };
    };
    expect(data.xml).toContain("<memory_context");
    expect(data.xml).toContain('<memory_details count="1">');
    expect(data.xml).toContain("<memory_lineage");
    expect(data.selected_detail_ids).toContain(memory.id);
    expect(data.lineage_ids).toContain(memory.id);
    expect(data.state.turn).toBe(1);
    expect(data.state.active_detail_ids).toContain(memory.id);
  });

  it("creates and approves memory proposals", async () => {
    const proposalRes = await app.request("/api/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "procedure",
        text: "API test: run governance tests before release",
        rationale: "High-risk procedures must be reviewed",
      }),
    });
    expect(proposalRes.status).toBe(201);
    const proposalBody = await json(proposalRes);
    const proposal = proposalBody.data as { id: string; status: string; risk_level: string };
    expect(proposal.status).toBe("pending");
    expect(proposal.risk_level).toBe("high");

    const approveRes = await app.request(`/api/proposals/${proposal.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decided_by: "api-test-user" }),
    });
    expect(approveRes.status).toBe(200);
    const approveBody = await json(approveRes);
    expect(approveBody.success).toBe(true);
    expect(approveBody.memory_id).toBeTruthy();
  });

  it("creates and rejects memory proposals", async () => {
    const proposalRes = await app.request("/api/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "decision",
        text: "API test: temporary proposal to reject",
      }),
    });
    const proposalBody = await json(proposalRes);
    const proposal = proposalBody.data as { id: string };

    const rejectRes = await app.request(`/api/proposals/${proposal.id}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "Not durable enough" }),
    });
    expect(rejectRes.status).toBe(200);
    const rejectBody = await json(rejectRes);
    const rejected = rejectBody.data as { status: string; decision_note: string };
    expect(rejected.status).toBe("rejected");
    expect(rejected.decision_note).toBe("Not durable enough");
  });

  it("proposes and approves code links", async () => {
    const memory = remember(db, {
      kind: "fact",
      text: "API test: service.ts owns business logic",
      projectId: PROJECT,
      source: "cli:user:explicit",
    });

    const linkProposalRes = await app.request("/api/links/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposal_type: "memory_code_link",
        memory_id: memory.id,
        path: "src/service.ts",
        entity_type: "file",
        relation: "documents",
        rationale: "Memory documents the service boundary",
      }),
    });
    expect(linkProposalRes.status).toBe(201);
    const proposalBody = await json(linkProposalRes);
    const proposal = proposalBody.data as { id: string; proposal_type: string };
    expect(proposal.proposal_type).toBe("memory_code_link");

    const approveRes = await app.request(`/api/links/${proposal.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decided_by: "api-test-user" }),
    });
    expect(approveRes.status).toBe(200);
    const approveBody = await json(approveRes);
    expect(approveBody.link_id).toBeTruthy();
  });
});
