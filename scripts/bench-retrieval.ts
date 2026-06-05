#!/usr/bin/env bun

import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";

import { closeDb, getDb, runMigrations } from "../src/persistence/db";
import { localEmbeddingProvider } from "../src/retrieval/embedding-provider";
import { sqliteVecVersion, vectorBackend } from "../src/retrieval/vector";
import { hybridRecall, remember } from "../src/service";

const PROJECT = "memh-retrieval-dogfood";
const ROOT = process.cwd();
const DB_PATH = `/tmp/memh-retrieval-bench-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`;
const INCLUDE_DIRS = ["src", "tests", "docs"];
const INCLUDE_EXTS = new Set([".ts", ".md"]);
const CHUNK_CHARS = 1_800;

const QUERIES = [
  {
    name: "sqlite-vec",
    query: "src vector ts vectorSearch memory_vectors sqliteVecVersion",
    expectPath: "src/vector.ts",
  },
  {
    name: "guardrail",
    query: "src guardrail ts sanitizeGuardedOutput enforceInputGuard",
    expectPath: "src/guardrail.ts",
  },
  {
    name: "mcp",
    query: "src mcp-server ts memory_search memory_context proposal tool",
    expectPath: "src/mcp-server.ts",
  },
  {
    name: "context",
    query: "src context-runtime ts assembleRuntimeMemoryContext lineage",
    expectPath: "src/context-runtime.ts",
  },
  {
    name: "governance",
    query: "src service ts approveProposal proposeMemory risk_level",
    expectPath: "src/service.ts",
  },
  {
    name: "fts",
    query: "src db ts memory_items_fts migration trigger runMigrations",
    expectPath: "src/db.ts",
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(path));
    } else if (INCLUDE_EXTS.has(path.slice(path.lastIndexOf(".")))) {
      out.push(path);
    }
  }
  return out;
}

function chunks(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }
  const out: string[] = [];
  for (let i = 0; i < normalized.length; i += CHUNK_CHARS) {
    out.push(normalized.slice(i, i + CHUNK_CHARS));
  }
  return out;
}

function seedCorpus(): { files: number; chunks: number; stored: number } {
  const db = getDb(DB_PATH);
  runMigrations(db);

  const files = INCLUDE_DIRS.flatMap((dir) => walk(join(ROOT, dir)));
  let chunkCount = 0;
  let stored = 0;

  for (const file of files) {
    const rel = relative(ROOT, file);
    const fileChunks = chunks(readFileSync(file, "utf-8"));
    for (let i = 0; i < fileChunks.length; i++) {
      chunkCount++;
      try {
        remember(db, {
          kind: "code_context",
          projectId: PROJECT,
          source: "bench:dogfood",
          confidence: 0.6,
          text: `Path: ${rel}\nChunk: ${i}\n\n${fileChunks[i]}`,
          metadata: { path: rel, chunk_index: i },
        });
        stored++;
      } catch {
        // Exact/semantic duplicates can merge or be skipped without invalidating the benchmark.
      }
    }
  }

  return { files: files.length, chunks: chunkCount, stored };
}

function pathForResult(item: { metadata_json: string; text: string }): string {
  try {
    const metadata = JSON.parse(item.metadata_json) as { path?: string };
    if (metadata.path) {
      return metadata.path;
    }
  } catch {}
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  const match = item.text.match(/^Path:\s*(.+)$/m);
  return match?.[1] ?? "unknown";
}

const db = getDb(DB_PATH);
try {
  const corpus = seedCorpus();
  const results = QUERIES.map((query) => {
    const started = performance.now();
    const rows = hybridRecall(db, PROJECT, query.query, null, 5);
    const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
    const top = rows[0]?.item;
    const topPath = top ? pathForResult(top) : null;
    const hit = rows.some((row) => pathForResult(row.item) === query.expectPath);

    return {
      name: query.name,
      query: query.query,
      expected_path: query.expectPath,
      elapsed_ms: elapsedMs,
      result_count: rows.length,
      hit,
      top_path: topPath,
      top_preview: top?.text.replace(/\s+/g, " ").slice(0, 160) ?? null,
    };
  });

  const report = {
    backend: vectorBackend(db),
    sqlite_vec_version: sqliteVecVersion(db),
    embedding_provider: localEmbeddingProvider.name,
    embedding_dimensions: localEmbeddingProvider.dimensions,
    corpus,
    results,
  };

  console.table(
    results.map((r) => ({
      query: r.name,
      ms: r.elapsed_ms,
      count: r.result_count,
      hit: r.hit,
      top_path: r.top_path,
    })),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(DB_PATH + suffix);
    } catch {}
  }
}
