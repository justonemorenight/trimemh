import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseFile } from "../src/code-intel/code-parser";
import { closeDb, getDb, runMigrations } from "../src/persistence/db";
import { createMemoryCodeLink, remember } from "../src/service";
import { detectStaleMemories } from "../src/service/lifecycle-service";

const DEMO_ROOT = "/tmp/trimemh-stale-memory-demo";
const DB_PATH = join(DEMO_ROOT, "memory.db");
const PROJECT_ID = "stale-memory-demo";
const AUTH_PATH = join(DEMO_ROOT, "src", "auth.ts");

function cleanDemo(): void {
  closeDb();
  rmSync(DEMO_ROOT, { recursive: true, force: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${DB_PATH}${suffix}`);
    } catch {}
  }
}

function writeAuthSource(source: string): void {
  mkdirSync(join(DEMO_ROOT, "src"), { recursive: true });
  writeFileSync(AUTH_PATH, source);
}

function fingerprintFor(symbol: string): string {
  const parsed = parseFile(AUTH_PATH, readFileSync(AUTH_PATH, "utf8"));
  const entity = parsed.entities.find(
    (entry) => entry.entityType === "function" && entry.symbol === symbol,
  );
  if (!entity) {
    throw new Error(`Cannot find symbol ${symbol} in demo auth source.`);
  }
  return entity.fingerprint;
}

function printReport(staleReport: ReturnType<typeof detectStaleMemories>): void {
  console.log("\nStale memory report");
  console.log("───────────────────");
  console.log(
    `${staleReport.summary.flagged_memory_count}/${staleReport.summary.checked_memory_count} flagged ` +
      `(high=${staleReport.summary.high_count}, medium=${staleReport.summary.medium_count}, low=${staleReport.summary.low_count})`,
  );

  for (const result of staleReport.results) {
    console.log(`\n[${result.severity}] ${result.memory.kind} action=${result.suggested_action}`);
    console.log(`memory: ${result.memory.text}`);
    for (const reason of result.reasons) {
      console.log(`- ${reason.reason}: ${reason.description}`);
    }
  }
}

cleanDemo();

writeAuthSource(`export function validateSession(cookie: string) {
  return cookie.startsWith("session=");
}
`);

const db = getDb(DB_PATH);
runMigrations(db);

const memory = remember(db, {
  kind: "code_context",
  text: "auth.ts#validateSession validates cookie-based sessions; use it before touching auth middleware.",
  projectId: PROJECT_ID,
  source: "demo:stale-memory",
  confidence: 0.9,
});

createMemoryCodeLink(db, {
  projectId: PROJECT_ID,
  memoryId: memory.id,
  entityType: "function",
  path: AUTH_PATH,
  symbol: "validateSession",
  relation: "documents",
  rationale: "Demo memory documents the original auth validation function.",
  fingerprint: fingerprintFor("validateSession"),
});

console.log("Created a memory linked to auth.ts#validateSession.");
console.log("Now simulating a refactor from cookie sessions to bearer tokens...");

writeAuthSource(`export function validateBearerToken(authHeader: string) {
  return authHeader.startsWith("Bearer ");
}
`);

const report = detectStaleMemories(db, {
  projectId: PROJECT_ID,
  path: AUTH_PATH,
  includeConflicts: false,
});

printReport(report);

console.log(
  "\nTakeaway: stale memory is a correctness bug. triMemh flags it before an agent trusts it.",
);
closeDb();
