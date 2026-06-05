/**
 * Embedding Quality Benchmark (Phase 2 — Intelligence Upgrade)
 *
 * Evaluates retrieval quality for different embedding providers using
 * standard IR metrics: Precision@K, Recall@K, MRR, NDCG@K.
 *
 * Usage: bun run scripts/bench-embedding.ts
 *   MEMH_BENCH_SIZE=100 bun run scripts/bench-embedding.ts
 */

import { cosineSimilarity } from "../src/retrieval/embedding";
import { LocalHashProvider } from "../src/retrieval/embedding-provider";

// ─── Types ──────────────────────────────────────────────────────────

interface BenchmarkQuery {
  query: string;
  relevantIds: string[];
  description: string;
}

interface BenchmarkDocument {
  id: string;
  text: string;
  kind: string;
}

interface ProviderResult {
  provider: string;
  queries: QueryMetrics[];
  aggregate: AggregateMetrics;
}

interface QueryMetrics {
  query: string;
  precisionAt1: number;
  precisionAt3: number;
  precisionAt5: number;
  recallAt5: number;
  mrr: number;
  ndcgAt5: number;
}

interface AggregateMetrics {
  meanPrecisionAt1: number;
  meanPrecisionAt3: number;
  meanPrecisionAt5: number;
  meanRecallAt5: number;
  meanMRR: number;
  meanNDCGAt5: number;
}

// ─── Benchmark dataset ──────────────────────────────────────────────

/**
 * Synthetic benchmark dataset covering common codebase memory scenarios.
 * Each query has ground-truth relevant document IDs.
 */
const BENCHMARK_DOCS: BenchmarkDocument[] = [
  {
    id: "d1",
    text: "Always use TypeScript strict mode for new projects. Set strict: true in tsconfig.json.",
    kind: "preference",
  },
  {
    id: "d2",
    text: "Error handling must use Result<T, E> pattern instead of throwing exceptions. All API endpoints must return structured errors.",
    kind: "procedure",
  },
  {
    id: "d3",
    text: "Database migrations must be backward compatible. Never drop columns in a migration without a deprecation cycle.",
    kind: "procedure",
  },
  {
    id: "d4",
    text: "Use Bun as the primary JavaScript runtime. All scripts and tests must run with `bun test`.",
    kind: "preference",
  },
  {
    id: "d5",
    text: "API rate limiting is implemented via token bucket algorithm with 30 req/min per tool for MCP endpoints.",
    kind: "fact",
  },
  {
    id: "d6",
    text: "SQLite database must use WAL journal mode. PRAGMA journal_mode = WAL and PRAGMA foreign_keys = ON.",
    kind: "fact",
  },
  {
    id: "d7",
    text: "We decided to use sqlite-vec for vector search instead of external Chroma/Pinecone. Decision made 2026-06-01.",
    kind: "decision",
  },
  {
    id: "d8",
    text: "The embedding dimension mismatch bug caused search failures in production on 2026-05-15. Root cause: ONNX model upgrade from 384 to 768 dims without migration.",
    kind: "mistake",
  },
  {
    id: "d9",
    text: "CRITICAL: Never commit API keys to the repository. Use .env files and Bun's automatic .env loading. Check secrets patterns before commit.",
    kind: "security_rule",
  },
  {
    id: "d10",
    text: "Trading rules: Position size must not exceed 2% of portfolio per trade. Stop-loss at 1%. Max 3 concurrent positions.",
    kind: "trade_rule",
  },
  {
    id: "d11",
    text: "Memory harness uses three-layer progressive disclosure: Layer 1 Index (global), Layer 2 Detail (context-scoped), Layer 3 Lineage (audit).",
    kind: "fact",
  },
  {
    id: "d12",
    text: "Project code names: tri-memory is the repository name, memh is the binary/package name, Memory Harness is the product name.",
    kind: "fact",
  },
  {
    id: "d13",
    text: "React components should use functional components with hooks. Avoid class components. Use TypeScript interfaces for props.",
    kind: "preference",
  },
  {
    id: "d14",
    text: "The CI pipeline runs on GitHub Actions. Build takes ~3 minutes. Tests must pass before merge. Use `bun test` locally.",
    kind: "fact",
  },
  {
    id: "d15",
    text: "When deploying to production, always run database migrations first, then deploy application code. Rollback plan must be documented.",
    kind: "procedure",
  },
  {
    id: "d16",
    text: "Logging format: JSON Lines with keys: level, message, timestamp, module, traceId. Structured logging for observability.",
    kind: "preference",
  },
  {
    id: "d17",
    text: "We migrated from pgvector to sqlite-vec for local-first architecture on 2026-04-20. Migration script in scripts/migrate-vectors.ts.",
    kind: "decision",
  },
  {
    id: "d18",
    text: "Do not use `any` type in TypeScript. Prefer `unknown` and type narrowing. Exception: third-party library interop with documented justification.",
    kind: "preference",
  },
  {
    id: "d19",
    text: "The vector search returns empty results when embedding dimension doesn't match the stored vectors. Added dimension validation on 2026-05-20.",
    kind: "mistake",
  },
  {
    id: "d20",
    text: "SECURITY: Input validation must happen at the boundary (API/MCP/CLI), not in service layer. Guard strings before service calls.",
    kind: "security_rule",
  },
];

const BENCHMARK_QUERIES: BenchmarkQuery[] = [
  {
    query: "How should I handle errors in the API?",
    relevantIds: ["d2", "d18"],
    description: "Error handling pattern search",
  },
  {
    query: "What database setup is required?",
    relevantIds: ["d6", "d3"],
    description: "Database configuration",
  },
  {
    query: "What are the security rules for the project?",
    relevantIds: ["d9", "d20"],
    description: "Security policy search",
  },
  {
    query: "How does vector search work?",
    relevantIds: ["d7", "d11", "d19"],
    description: "Vector search architecture",
  },
  {
    query: "What TypeScript conventions do we follow?",
    relevantIds: ["d1", "d13", "d18"],
    description: "Coding style preferences",
  },
  {
    query: "Tell me about trading limits",
    relevantIds: ["d10"],
    description: "Trading rules lookup",
  },
  {
    query: "How to deploy to production?",
    relevantIds: ["d15", "d14"],
    description: "Deployment procedure",
  },
  {
    query: "What mistakes have we made with embeddings?",
    relevantIds: ["d8", "d19"],
    description: "Mistake recall",
  },
  {
    query: "What is the project naming convention?",
    relevantIds: ["d12", "d11"],
    description: "Project naming",
  },
  {
    query: "How should I set up logging?",
    relevantIds: ["d16"],
    description: "Logging preferences",
  },
];

// ─── Metrics computation ────────────────────────────────────────────

function dcg(relevances: number[], k: number): number {
  let score = 0;
  for (let i = 0; i < Math.min(k, relevances.length); i++) {
    score += (relevances[i] ?? 0) / Math.log2(i + 2);
  }
  return score;
}

function idcg(relevances: number[], k: number): number {
  const sorted = [...relevances].sort((a, b) => b - a);
  return dcg(sorted, k);
}

function evaluateQuery(
  query: BenchmarkQuery,
  docs: BenchmarkDocument[],
  embeddings: Map<string, Float32Array>,
): QueryMetrics {
  const queryEmbedding = embeddings.get(`__query__${query.query}`);
  if (!queryEmbedding) {
    throw new Error(`Embedding not found for query: ${query.query}`);
  }
  const relevantSet = new Set(query.relevantIds);

  // Rank all docs by cosine similarity
  const ranked = docs
    .map((doc) => {
      const docEmb = embeddings.get(doc.id);
      if (!docEmb) {
        return { doc, similarity: 0 };
      }
      return { doc, similarity: cosineSimilarity(queryEmbedding, docEmb) };
    })
    .sort((a, b) => b.similarity - a.similarity);

  // Precision@K
  function precisionAt(k: number): number {
    const topK = ranked.slice(0, k);
    const hits = topK.filter((r) => relevantSet.has(r.doc.id)).length;
    return hits / k;
  }

  // Recall@K
  function recallAt(k: number): number {
    const topK = ranked.slice(0, k);
    const hits = topK.filter((r) => relevantSet.has(r.doc.id)).length;
    return relevantSet.size > 0 ? hits / relevantSet.size : 0;
  }

  // MRR (Mean Reciprocal Rank)
  let rr = 0;
  for (let i = 0; i < ranked.length; i++) {
    if (relevantSet.has(ranked[i]?.doc.id)) {
      rr = 1 / (i + 1);
      break;
    }
  }

  // NDCG@5
  const relevances = ranked.map((r) => (relevantSet.has(r.doc.id) ? 1 : 0));
  const ndcg5 = idcg(relevances, 5) > 0 ? dcg(relevances, 5) / idcg(relevances, 5) : 0;

  return {
    query: query.query,
    precisionAt1: Math.round(precisionAt(1) * 1000) / 1000,
    precisionAt3: Math.round(precisionAt(3) * 1000) / 1000,
    precisionAt5: Math.round(precisionAt(5) * 1000) / 1000,
    recallAt5: Math.round(recallAt(5) * 1000) / 1000,
    mrr: Math.round(rr * 1000) / 1000,
    ndcgAt5: Math.round(ndcg5 * 1000) / 1000,
  };
}

function aggregateMetrics(queryMetrics: QueryMetrics[]): AggregateMetrics {
  const n = queryMetrics.length;
  const sum = queryMetrics.reduce(
    (acc, m) => ({
      p1: acc.p1 + m.precisionAt1,
      p3: acc.p3 + m.precisionAt3,
      p5: acc.p5 + m.precisionAt5,
      r5: acc.r5 + m.recallAt5,
      mrr: acc.mrr + m.mrr,
      ndcg: acc.ndcg + m.ndcgAt5,
    }),
    { p1: 0, p3: 0, p5: 0, r5: 0, mrr: 0, ndcg: 0 },
  );

  return {
    meanPrecisionAt1: Math.round((sum.p1 / n) * 1000) / 1000,
    meanPrecisionAt3: Math.round((sum.p3 / n) * 1000) / 1000,
    meanPrecisionAt5: Math.round((sum.p5 / n) * 1000) / 1000,
    meanRecallAt5: Math.round((sum.r5 / n) * 1000) / 1000,
    meanMRR: Math.round((sum.mrr / n) * 1000) / 1000,
    meanNDCGAt5: Math.round((sum.ndcg / n) * 1000) / 1000,
  };
}

// ─── Runner ─────────────────────────────────────────────────────────

function runProvider(name: string, embedFn: (text: string) => Float32Array): ProviderResult {
  const embeddings = new Map<string, Float32Array>();

  // Embed all documents
  for (const doc of BENCHMARK_DOCS) {
    embeddings.set(doc.id, embedFn(doc.text));
  }

  // Embed all queries
  for (const q of BENCHMARK_QUERIES) {
    embeddings.set(`__query__${q.query}`, embedFn(q.query));
  }

  const queryResults: QueryMetrics[] = [];
  for (const q of BENCHMARK_QUERIES) {
    queryResults.push(evaluateQuery(q, BENCHMARK_DOCS, embeddings));
  }

  return {
    provider: name,
    queries: queryResults,
    aggregate: aggregateMetrics(queryResults),
  };
}

// ─── Main ───────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/useAwait: warning suppression
async function main() {
  console.log("=".repeat(70));
  console.log("Embedding Quality Benchmark — tri-memory (memh)");
  console.log("=".repeat(70));
  console.log(`Documents: ${BENCHMARK_DOCS.length}`);
  console.log(`Queries:   ${BENCHMARK_QUERIES.length}`);
  console.log("=".repeat(70));

  const providers: Array<{ name: string; embed: (text: string) => Float32Array }> = [
    {
      name: "LocalHashProvider (baseline)",
      embed: new LocalHashProvider().embed,
    },
  ];

  for (const provider of providers) {
    console.log(`\nRunning ${provider.name}...`);
    const result = runProvider(provider.name, provider.embed);

    console.log(`\n--- ${result.provider} ---`);
    console.log(`  Mean Precision@1:  ${result.aggregate.meanPrecisionAt1}`);
    console.log(`  Mean Precision@3:  ${result.aggregate.meanPrecisionAt3}`);
    console.log(`  Mean Precision@5:  ${result.aggregate.meanPrecisionAt5}`);
    console.log(`  Mean Recall@5:     ${result.aggregate.meanRecallAt5}`);
    console.log(`  Mean MRR:          ${result.aggregate.meanMRR}`);
    console.log(`  Mean NDCG@5:       ${result.aggregate.meanNDCGAt5}`);

    console.log("\n  Per-Query Breakdown:");
    for (const q of result.queries) {
      const status = q.precisionAt1 > 0 ? "✓" : "✗";
      console.log(
        `  ${status} P@1=${q.precisionAt1} P@3=${q.precisionAt3} MRR=${q.mrr} | ${q.query.slice(0, 60)}`,
      );
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log("Benchmark complete.");
  console.log("To run with a different provider, set MEMH_BENCH_PROVIDER env var.");
  console.log("Supported: local-hash (default), openai:<model>");
  console.log("=".repeat(70));
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}

// ─── Exports for programmatic use ────────────────────────────────────

export type { AggregateMetrics, BenchmarkDocument, BenchmarkQuery, ProviderResult, QueryMetrics };
export { BENCHMARK_DOCS, BENCHMARK_QUERIES, aggregateMetrics, evaluateQuery, runProvider };
