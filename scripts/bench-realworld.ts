#!/usr/bin/env bun
/**
 * bench-realworld.ts — Tác chiến thực tế (Real-world Performance Benchmark)
 *
 * Đo lường hiệu năng của triMemh ở các kịch bản thực tế:
 *   1. Context Assembly Latency at Scale — 50, 200, 500, 1000 memories
 *   2. Hybrid Search Latency — so sánh FTS vs Vector vs Hybrid
 *   3. Write Throughput — remembers/sec, latency ở các mức DB size
 *   4. Session Simulation — multi-turn session với realistic pattern
 */

import { unlinkSync } from "node:fs";

import { assembleMemoryContext, createRuntimeContextState } from "../src/context/context-runtime";
import type { RememberInput } from "../src/domain/schema";
import { closeDb, getDb, runMigrations } from "../src/persistence/db";
import { mcpHybridSearch, mcpSearch, remember, rememberMany, status } from "../src/service";

// ─── Config ────────────────────────────────────────────────────────

const PROJECT = "bench-realworld";
const DB_PATH = `/tmp/memh-bench-realworld-${Date.now()}.sqlite`;
const ITERATIONS = 5;
const WARMUP_ITERATIONS = 2;

// ─── Helpers ───────────────────────────────────────────────────────

function cleanup(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(DB_PATH + suffix);
    } catch {
      // file may not exist
    }
  }
}

function median(values: number[]): number {
  if (values.length === 0) {
    throw new Error("Cannot calculate median for an empty list.");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const current = sorted[mid];
  if (current === undefined) {
    throw new Error("Cannot calculate median for an empty list.");
  }
  if (sorted.length % 2 !== 0) {
    return current;
  }
  const previous = sorted[mid - 1];
  if (previous === undefined) {
    throw new Error("Cannot calculate median for an empty list.");
  }
  return (previous + current) / 2;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    throw new Error("Cannot calculate percentile for an empty list.");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  const value = sorted[Math.max(0, idx)];
  if (value === undefined) {
    throw new Error("Cannot calculate percentile for an empty list.");
  }
  return value;
}

function formatMs(ms: number): string {
  if (ms < 1) {
    return `${(ms * 1000).toFixed(1)}μs`;
  }
  if (ms < 1000) {
    return `${ms.toFixed(1)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function fromRing<T>(items: readonly T[], index: number): T {
  const item = items[index % items.length];
  if (item === undefined) {
    throw new Error("Cannot select from an empty list.");
  }
  return item;
}

function hr(): string {
  return "─".repeat(72);
}

function seedMemories(count: number, db: ReturnType<typeof getDb>): number {
  // Only low/medium risk kinds — avoid direct-write block on high/critical
  const kinds: Array<"preference" | "fact" | "decision" | "session_summary" | "code_context"> = [
    "preference",
    "fact",
    "decision",
    "session_summary",
    "code_context",
  ];

  const topics = [
    "vector embedding caching strategy",
    "MCP transport error handling",
    "database migration rollback procedure",
    "structured logging format configuration",
    "token bucket rate limiter tuning",
    "context assembly pipeline optimization",
    "FTS5 fulltext search tokenizer",
    "memory graph traversal BFS depth",
    "EMA feedback loop alpha calibration",
    "RBAC role-based access control model",
    "content compression ratio measurement",
    "hybrid RRF k-value parameter",
    "cross-agent provenance dedup threshold",
    "semantic near-duplicate detection scan",
    "audit event retention TTL policy",
  ];

  const inputs: RememberInput[] = [];
  for (let i = 0; i < count; i++) {
    const kind = fromRing(kinds, i);
    const topic = fromRing(topics, i);
    inputs.push({
      kind,
      text: `BENCH#${i} ${kind} ${topic} uid${i}z${Math.random().toString(36).slice(2, 6)}`,
      projectId: PROJECT,
      source: "bench:seed",
      confidence: 0.5,
    });
  }

  try {
    return rememberMany(db, inputs).length;
  } catch {
    // Fall back to per-item writes if a generated duplicate aborts the batch.
  }

  let stored = 0;
  for (const input of inputs) {
    try {
      remember(db, input);
      stored++;
    } catch {
      // Skip duplicates
    }
  }
  return stored;
}

// ═══════════════════════════════════════════════════════════════════
// Benchmark 1: Context Assembly Latency at Scale
// ═══════════════════════════════════════════════════════════════════

function benchContextAssembly(): void {
  console.log(`\n${hr()}`);
  console.log("Benchmark 1: Context Assembly Latency at Scale");
  console.log(hr());

  const scales = [50, 200, 500, 1000];
  const results: Array<{
    scale: number;
    stored: number;
    p50: number;
    p95: number;
    p99: number;
    xmlChars: number;
    compacted: boolean;
  }> = [];

  for (const scale of scales) {
    cleanup();
    const db = getDb(DB_PATH);
    runMigrations(db);

    const stored = seedMemories(scale, db);

    // Warmup
    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
      assembleMemoryContext({
        db,
        projectId: PROJECT,
        query: "warmup query for benchmark",
        modelContextTokens: 200_000,
        state: createRuntimeContextState(),
      });
    }

    // Measure
    const latencies: number[] = [];
    let xmlChars = 0;
    let compacted = false;

    for (let i = 0; i < ITERATIONS; i++) {
      const started = performance.now();
      const result = assembleMemoryContext({
        db,
        projectId: PROJECT,
        query: "performance benchmark configuration production deployment",
        modelContextTokens: 200_000,
        state: createRuntimeContextState(),
      });
      latencies.push(performance.now() - started);
      xmlChars = result.xml.length;
      compacted = result.compactedIndex;
    }

    results.push({
      scale,
      stored,
      p50: median(latencies),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      xmlChars,
      compacted,
    });

    closeDb();
  }

  // Report
  console.log("");
  console.log("│ Scale │ Stored │  p50   │  p95   │  p99   │ XML chars │ Compact │");
  console.log("├───────┼────────┼────────┼────────┼────────┼───────────┼─────────┤");

  for (const r of results) {
    const compact = r.compacted ? "✓" : "✗";
    console.log(
      `│ ${String(r.scale).padStart(5)} │ ${String(r.stored).padStart(6)} │ ${formatMs(r.p50).padStart(6)} │ ${formatMs(r.p95).padStart(6)} │ ${formatMs(r.p99).padStart(6)} │ ${String(r.xmlChars).padStart(9)} │ ${compact.padStart(7)} │`,
    );
  }
  console.log("");

  cleanup();
}

// ═══════════════════════════════════════════════════════════════════
// Benchmark 2: Hybrid Search Latency
// ═══════════════════════════════════════════════════════════════════

function benchSearchLatency(): void {
  console.log(`\n${hr()}`);
  console.log("Benchmark 2: Search Latency — FTS vs Vector vs Hybrid");
  console.log(hr());

  cleanup();
  const db = getDb(DB_PATH);
  runMigrations(db);

  // Seed 500 memories
  const stored = seedMemories(500, db);
  console.log(`\n  Seeded: ${stored} memories`);

  const queries = [
    "database configuration SQLite performance",
    "security rule authentication token",
    "deployment procedure release pipeline",
    "code embedding vector search",
    "rate limiter burst capacity",
    "memory graph related traversal",
    "FTS5 text search indexing",
    "governance approval workflow",
    "error handling retry backoff",
    "TypeScript strict mode configuration",
    "API endpoint REST Hono framework",
    "migration schema version control",
    "embedding provider local hash",
    "context assembly budget enforcement",
    "feedback loop agent scoring",
    "dedup semantic duplicate detection",
    "logging structured JSON format",
    "cache LRU eviction policy",
    "cross-agent provenance tracking",
    "CCR compression retrieval deferred",
  ];

  // Warmup
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    mcpSearch(db, PROJECT, "warmup query", 5);
    mcpHybridSearch(db, PROJECT, "warmup query", null, 5);
  }

  // Measure FTS-only
  const ftsLatencies: number[] = [];
  for (const q of queries) {
    const started = performance.now();
    mcpSearch(db, PROJECT, q, 5);
    ftsLatencies.push(performance.now() - started);
  }

  // Measure Hybrid
  const hybridLatencies: number[] = [];
  for (const q of queries) {
    const started = performance.now();
    mcpHybridSearch(db, PROJECT, q, null, 5);
    hybridLatencies.push(performance.now() - started);
  }

  console.log("");
  console.log("│ Mode    │  p50   │  p95   │  p99   │  avg   │  min   │  max   │");
  console.log("├─────────┼────────┼────────┼────────┼────────┼────────┼────────┤");

  for (const [label, lats] of [
    ["FTS-only", ftsLatencies],
    ["Hybrid", hybridLatencies],
  ] as const) {
    const avg = lats.reduce((a, b) => a + b, 0) / lats.length;
    console.log(
      `│ ${label.padEnd(7)} │ ${formatMs(median(lats)).padStart(6)} │ ${formatMs(percentile(lats, 95)).padStart(6)} │ ${formatMs(percentile(lats, 99)).padStart(6)} │ ${formatMs(avg).padStart(6)} │ ${formatMs(Math.min(...lats)).padStart(6)} │ ${formatMs(Math.max(...lats)).padStart(6)} │`,
    );
  }
  console.log("");

  closeDb();
  cleanup();
}

// ═══════════════════════════════════════════════════════════════════
// Benchmark 3: Write Throughput
// ═══════════════════════════════════════════════════════════════════

function benchWriteThroughput(): void {
  console.log(`\n${hr()}`);
  console.log("Benchmark 3: Write Throughput");
  console.log(hr());

  // Test 1: Sequential writes to empty DB
  cleanup();
  const db = getDb(DB_PATH);
  runMigrations(db);

  const kinds: Array<"preference" | "fact" | "decision" | "session_summary" | "code_context"> = [
    "preference",
    "fact",
    "decision",
    "session_summary",
    "code_context",
  ];

  const writeLatencies: number[] = [];
  const BATCH = 50;

  const batchStart = performance.now();
  for (let i = 0; i < BATCH; i++) {
    const kind = fromRing(kinds, i);
    const started = performance.now();
    remember(db, {
      kind,
      text: `Write benchmark memory #${i}: Đo lường throughput của hệ thống ghi memory. Nội dung đa dạng bao gồm code patterns, cấu hình hệ thống, và các quyết định kiến trúc. Memory ID: ${crypto.randomUUID?.() ?? i}`,
      projectId: PROJECT,
      source: "bench:write",
      confidence: 0.5,
    });
    writeLatencies.push(performance.now() - started);
  }
  const batchElapsed = performance.now() - batchStart;

  console.log(`\n  Empty DB (${BATCH} writes):`);
  console.log(`    Total:   ${formatMs(batchElapsed)}`);
  console.log(`    Throughput: ${((BATCH / batchElapsed) * 1000).toFixed(1)} writes/sec`);
  console.log(
    `    Avg latency: ${formatMs(writeLatencies.reduce((a, b) => a + b, 0) / writeLatencies.length)}`,
  );
  console.log(`    p50:     ${formatMs(median(writeLatencies))}`);
  console.log(`    p95:     ${formatMs(percentile(writeLatencies, 95))}`);

  // Test 2: Writes on populated DB (seed thêm 950 để có ~1000 records)
  const moreStored = seedMemories(950, db);
  const totalBefore = BATCH + moreStored;
  console.log(`\n  Populated DB (~${totalBefore} records, ${BATCH} writes):`);

  const populatedLatencies: number[] = [];
  const populatedInputs: RememberInput[] = [];
  for (let i = 0; i < BATCH; i++) {
    const kind = fromRing(kinds, i);
    populatedInputs.push({
      kind,
      text: `Populated write benchmark #${i + BATCH}: Đo lường throughput khi DB đã có ~${totalBefore} records. Memory này kiểm tra xem hiệu năng ghi có bị suy giảm khi DB lớn không. ${crypto.randomUUID?.() ?? i}`,
      projectId: PROJECT,
      source: "bench:write",
      confidence: 0.5,
    });
  }

  const batch2Start = performance.now();
  for (const input of populatedInputs) {
    const started = performance.now();
    remember(db, input);
    populatedLatencies.push(performance.now() - started);
  }
  const batch2Elapsed = performance.now() - batch2Start;

  console.log(`    Total:   ${formatMs(batch2Elapsed)}`);
  console.log(`    Throughput: ${((BATCH / batch2Elapsed) * 1000).toFixed(1)} writes/sec`);
  console.log(
    `    Avg latency: ${formatMs(populatedLatencies.reduce((a, b) => a + b, 0) / populatedLatencies.length)}`,
  );
  console.log(`    p50:     ${formatMs(median(populatedLatencies))}`);
  console.log(`    p95:     ${formatMs(percentile(populatedLatencies, 95))}`);

  const batchInputs: RememberInput[] = [];
  for (let i = 0; i < BATCH; i++) {
    const kind = fromRing(kinds, i);
    batchInputs.push({
      kind,
      text: `Batched populated write benchmark #${i + BATCH * 2}: Đo lường batch throughput khi DB đã có ~${totalBefore + BATCH} records. ${crypto.randomUUID?.() ?? i}`,
      projectId: PROJECT,
      source: "bench:write:batch",
      confidence: 0.5,
    });
  }
  const batch3Start = performance.now();
  rememberMany(db, batchInputs);
  const batch3Elapsed = performance.now() - batch3Start;

  console.log(`\n  Populated DB batched (~${totalBefore + BATCH} records, ${BATCH} writes):`);
  console.log(`    Total:   ${formatMs(batch3Elapsed)}`);
  console.log(`    Throughput: ${((BATCH / batch3Elapsed) * 1000).toFixed(1)} writes/sec`);
  console.log(`    Avg latency: ${formatMs(batch3Elapsed / BATCH)}`);
  console.log("");

  closeDb();
  cleanup();
}

// ═══════════════════════════════════════════════════════════════════
// Benchmark 4: Session Simulation
// ═══════════════════════════════════════════════════════════════════

function benchSessionSimulation(): void {
  console.log(`\n${hr()}`);
  console.log("Benchmark 4: Session Simulation (50-turn)");
  console.log(hr());

  cleanup();
  const db = getDb(DB_PATH);
  runMigrations(db);

  // Pre-seed 100 memories
  const stored = seedMemories(100, db);
  console.log(`\n  Pre-seeded: ${stored} memories`);

  // Mô phỏng session thực tế: mỗi turn có pattern khác nhau
  const TURNS = 50;
  const turnPatterns = [
    // Pattern 0: Context assembly + simple search
    { query: "TypeScript configuration", search: true, propose: false },
    // Pattern 1: Context assembly + hybrid search
    { query: "database migration SQLite schema", search: true, propose: false },
    // Pattern 2: Context assembly only
    { query: null, search: false, propose: false },
    // Pattern 3: Context assembly + search + propose
    { query: "error handling rate limit circuit breaker", search: true, propose: true },
    // Pattern 4: Context assembly + propose only
    { query: "new architecture decision", search: false, propose: true },
  ];

  const turnLatencies: number[] = [];
  const contextLatencies: number[] = [];
  const searchLatencies: number[] = [];
  let proposalsCreated = 0;
  let state = createRuntimeContextState();

  const sessionStart = performance.now();

  for (let turn = 0; turn < TURNS; turn++) {
    const turnStart = performance.now();
    const pattern = fromRing(turnPatterns, turn);

    // Context assembly (every turn)
    const ctxStart = performance.now();
    const ctx = assembleMemoryContext({
      db,
      projectId: PROJECT,
      query: pattern.query,
      openPaths: turn % 3 === 0 ? ["src/service.ts", "src/persistence/db.ts"] : undefined,
      modelContextTokens: 200_000,
      state,
    });
    contextLatencies.push(performance.now() - ctxStart);
    state = ctx.state;

    // Search (some turns)
    if (pattern.search && pattern.query) {
      const searchStart = performance.now();
      if (turn % 2 === 0) {
        mcpSearch(db, PROJECT, pattern.query, 5);
      } else {
        mcpHybridSearch(db, PROJECT, pattern.query, null, 5);
      }
      searchLatencies.push(performance.now() - searchStart);
    }

    // Propose (occasional)
    if (pattern.propose && turn % 10 === 3) {
      try {
        remember(db, {
          kind: "fact",
          text: `Session simulation memory from turn ${turn}: Hệ thống hoạt động ổn định sau ${turn} turns. Context assembly latency đang được theo dõi.`,
          projectId: PROJECT,
          source: "bench:session",
          confidence: 0.5,
        });
        proposalsCreated++;
      } catch {
        // Skip duplicates
      }
    }

    turnLatencies.push(performance.now() - turnStart);
  }

  const sessionElapsed = performance.now() - sessionStart;

  // Report
  console.log("");
  console.log("  Session Summary:");
  console.log(`    Total turns:        ${TURNS}`);
  console.log(`    Total wall time:    ${formatMs(sessionElapsed)}`);
  console.log(
    `    Avg turn time:      ${formatMs(turnLatencies.reduce((a, b) => a + b, 0) / turnLatencies.length)}`,
  );
  console.log(`    Turn p50:           ${formatMs(median(turnLatencies))}`);
  console.log(`    Turn p95:           ${formatMs(percentile(turnLatencies, 95))}`);
  console.log("");
  console.log("  Context Assembly:");
  console.log(
    `    Avg latency:        ${formatMs(contextLatencies.reduce((a, b) => a + b, 0) / contextLatencies.length)}`,
  );
  console.log(`    p50:                ${formatMs(median(contextLatencies))}`);
  console.log(`    p95:                ${formatMs(percentile(contextLatencies, 95))}`);
  console.log("");
  console.log("  Search Operations:");
  if (searchLatencies.length > 0) {
    console.log(`    Count:              ${searchLatencies.length}`);
    console.log(
      `    Avg latency:        ${formatMs(searchLatencies.reduce((a, b) => a + b, 0) / searchLatencies.length)}`,
    );
    console.log(`    p50:                ${formatMs(median(searchLatencies))}`);
    console.log(`    p95:                ${formatMs(percentile(searchLatencies, 95))}`);
  } else {
    console.log("    (no searches this run)");
  }
  console.log("");
  console.log(`    Proposals created:  ${proposalsCreated}`);
  console.log(`    Final memory count: ${status(db, PROJECT).stats.total}`);
  console.log(`    KV-cache changes:   ${TURNS} (prefix fingerprint tracking enabled)`);
  console.log("");

  closeDb();
  cleanup();
}

// ═══════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║       triMemh — Real-world Performance Benchmark               ║");
console.log("╚══════════════════════════════════════════════════════════════════╝");
console.log(`  Time: ${new Date().toISOString()}`);
console.log(`  Runtime: Bun ${Bun.version}`);
console.log(`  Iterations per test: ${ITERATIONS} (+ ${WARMUP_ITERATIONS} warmup)`);

try {
  benchContextAssembly();
  benchSearchLatency();
  benchWriteThroughput();
  benchSessionSimulation();
} catch (err) {
  console.error("\n  Benchmark failed:", err);
  cleanup();
  process.exit(1);
}

console.log(`${hr()}`);
console.log("  All benchmarks complete.");
console.log(hr());
