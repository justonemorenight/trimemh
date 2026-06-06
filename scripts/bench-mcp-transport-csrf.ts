/**
 * MCP Streamable HTTP CSRF hardening benchmark.
 *
 * Measures the practical browser-facing paths:
 * - Unknown-origin preflight denied by missing CORS allow headers.
 * - Browser-simple form POST rejected before body parsing.
 * - Legitimate JSON POST burst remains fast for IDE/local clients.
 *
 * Usage:
 *   bun scripts/bench-mcp-transport-csrf.ts
 */

import { unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";

import { getLogger } from "../src/infrastructure/logging";
import { resetRateLimiter } from "../src/infrastructure/rate-limit";
import { createStreamableHTTPServer } from "../src/mcp/transport";
import { closeDb, getDb, runMigrations } from "../src/persistence/db";

const TEST_DB = "/tmp/memh-bench-mcp-transport-csrf.sqlite";
const PROJECT = "mcp-transport-csrf-bench";
const TRUSTED_ORIGIN = "https://trusted.example";

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

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const portFinder = createServer();
    portFinder.once("error", reject);
    portFinder.listen(0, "127.0.0.1", () => {
      const address = portFinder.address();
      if (!address || typeof address === "string") {
        portFinder.close(() => reject(new Error("Failed to find an available port.")));
        return;
      }
      portFinder.close(() => resolve(address.port));
    });
  });
}

function rpcBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: "bench-request",
    method: "memory_stats",
  });
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index] ?? 0;
}

function fmtMs(ms: number): string {
  return `${ms.toFixed(2)}ms`;
}

async function runScenario(
  name: string,
  iterations: number,
  makeRequest: () => Promise<Response>,
): Promise<void> {
  const latencies: number[] = [];
  const statuses = new Map<number, number>();
  const started = performance.now();

  for (let i = 0; i < iterations; i++) {
    const before = performance.now();
    // biome-ignore lint/performance/noAwaitInLoops: sequential requests measure per-request latency.
    const res = await makeRequest();
    await res.arrayBuffer();
    latencies.push(performance.now() - before);
    statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
  }

  const elapsed = performance.now() - started;
  const statusSummary = [...statuses.entries()]
    .sort(([a], [b]) => a - b)
    .map(([status, count]) => `${status}:${count}`)
    .join(" ");

  console.log(
    [
      name.padEnd(44),
      `n=${String(iterations).padStart(4)}`,
      `total=${fmtMs(elapsed).padStart(9)}`,
      `avg=${fmtMs(elapsed / iterations).padStart(8)}`,
      `p95=${fmtMs(percentile(latencies, 0.95)).padStart(8)}`,
      `statuses=${statusSummary}`,
    ].join("  "),
  );
}

async function main(): Promise<void> {
  cleanupDb();
  resetRateLimiter();
  getLogger().configure({ minLevel: "ERROR" });

  const db = getDb(TEST_DB);
  runMigrations(db);

  const port = await getAvailablePort();
  const { server, url } = createStreamableHTTPServer(db, PROJECT, {
    port,
    allowedOrigins: [TRUSTED_ORIGIN],
  });

  try {
    console.log(`MCP transport CSRF benchmark at ${url}`);
    console.log(
      "Scenario                                      n       total       avg       p95  statuses",
    );

    await runScenario("unknown-origin JSON preflight", 300, () =>
      fetch(url, {
        method: "OPTIONS",
        headers: {
          Origin: "https://attacker.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      }),
    );

    await runScenario("trusted-origin form-urlencoded POST", 300, () =>
      fetch(url, {
        method: "POST",
        headers: {
          Origin: TRUSTED_ORIGIN,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `payload=${encodeURIComponent(rpcBody())}`,
      }),
    );

    await runScenario("trusted-origin text/plain POST", 300, () =>
      fetch(url, {
        method: "POST",
        headers: {
          Origin: TRUSTED_ORIGIN,
          "Content-Type": "text/plain",
        },
        body: rpcBody(),
      }),
    );

    await runScenario("trusted-origin JSON POST burst", 25, () =>
      fetch(url, {
        method: "POST",
        headers: {
          Origin: TRUSTED_ORIGIN,
          "Content-Type": "application/json",
        },
        body: rpcBody(),
      }),
    );
  } finally {
    await server.stop(true);
    closeDb();
    cleanupDb();
  }
}

await main();
