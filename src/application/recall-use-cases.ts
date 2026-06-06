import type { Database } from "bun:sqlite";

import { CONFIG } from "../config";
import { classifyTaskContext, detectsOperationalContext } from "../context/compiler";
import type { CodeMemoryResult, RecallExplanation, RecallResult } from "../domain/schema";
import { getMemoriesForCodeRows, searchMemoryFts } from "../persistence/repository";
import type { HybridQueryResult } from "../retrieval/hybrid";
import { hybridRetrieve } from "../retrieval/hybrid";
import { expandQuery, expandQueryForEmbedding } from "../retrieval/query-expansion";
import { rerankCandidates } from "../retrieval/reranker";
import type { RecallScoreInput, RecallScoreResult } from "../retrieval/scoring";
import { rankRecallResults, selectWeights } from "../retrieval/scoring";
import { embeddingForText } from "./service-helpers";

export interface RecallOptions {
  /** Expand query with synonyms before search (P1). */
  expandQuery?: boolean;
  /** Rerank results with cross-encoder (P1). */
  rerank?: boolean;
  /** Open file paths for query expansion. */
  openPaths?: string[];
}

function stageOneLimit(finalLimit: number): number {
  return Math.max(finalLimit * 4, 40);
}

function expandedQuery(query: string, opts?: RecallOptions): string {
  return opts?.expandQuery !== false
    ? expandQuery(query, { openPaths: opts?.openPaths }).expandedQuery
    : query;
}

function embeddingQuery(query: string, opts?: RecallOptions): string {
  return opts?.expandQuery !== false
    ? expandQueryForEmbedding(query, { openPaths: opts?.openPaths })
    : query;
}

function applyRerank(
  query: string,
  results: RecallResult[],
  finalLimit: number,
  enabled: boolean,
  _currentFilePath?: string | null,
): RecallResult[] {
  if (enabled && query.trim() && results.length > finalLimit) {
    const candidates = results.map((r) => ({
      item: r.item,
      rrfScore: 1.0 / (1 + r.rank),
    }));
    const reranked = rerankCandidates(query, candidates, {
      stageOneLimit: Math.max(finalLimit * 4, 20),
      stageTwoLimit: finalLimit,
    });
    return reranked.map((r, i) => ({
      item: r.item,
      rank: i + 1,
      snippet: r.item.text.slice(0, CONFIG.service.snippetLength),
    }));
  }

  return results.length > finalLimit ? results.slice(0, finalLimit) : results;
}

function graphDegreesForResults(
  db: Database,
  projectId: string,
  results: RecallResult[],
): Map<string, number> {
  if (results.length === 0) {
    return new Map();
  }
  const ids = results.map((r) => r.item.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .query(
      `
      SELECT memory_id, COUNT(*) AS degree FROM (
        SELECT source_memory_id AS memory_id
        FROM memory_edges
        WHERE project_id = ? AND source_memory_id IN (${placeholders})
        UNION ALL
        SELECT target_memory_id AS memory_id
        FROM memory_edges
        WHERE project_id = ? AND target_memory_id IN (${placeholders})
      )
      GROUP BY memory_id;
      `,
    )
    .all(projectId, ...ids, projectId, ...ids) as Array<{ memory_id: string; degree: number }>;
  return new Map(rows.map((row) => [row.memory_id, row.degree]));
}

function topFactorLabels(factors: RecallScoreResult["factors"]): string[] {
  return Object.entries(factors)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key]) => key);
}

function explainRecallResult(
  input: RecallScoreInput,
  scored: RecallScoreResult,
  opts: {
    taskType: string;
    mode: "fts" | "vector" | "hybrid";
    originalRank: number;
  },
): RecallExplanation {
  const why: string[] = [];
  const top = topFactorLabels(scored.factors);
  if (top.length > 0) {
    why.push(`Top signals: ${top.join(", ")}.`);
  }
  if (input.ftsRank > 0) {
    why.push(`Lexical match ranked #${input.ftsRank}.`);
  }
  if (input.graphDegree > 0) {
    why.push(`Connected to ${input.graphDegree} memory graph edge(s).`);
  }
  if (input.isCodePathMatch) {
    why.push("Linked to the active code path.");
  }
  if (input.feedbackScore !== 0) {
    why.push(`Feedback score ${input.feedbackScore.toFixed(2)} influenced ranking.`);
  }
  if (why.length === 0) {
    why.push("Selected by baseline similarity, recency, and confidence signals.");
  }

  return {
    why_selected: why,
    composite_score: scored.compositeScore,
    factors: scored.factors,
    signals: {
      task_type: opts.taskType,
      retrieval_mode: opts.mode,
      original_rank: opts.originalRank,
      fts_rank: input.ftsRank,
      graph_degree: input.graphDegree,
      feedback_score: input.feedbackScore,
      access_count: input.accessCount,
      code_path_match: input.isCodePathMatch,
      operational_context: input.isOperationalContext,
    },
  };
}

/**
 * Apply multi-factor scoring (P2 — Intelligence Upgrade) to rank results.
 * This layers on top of RRF + cross-encoder reranking with:
 *   recency, confidence, access frequency, feedback score, risk boost,
 *   graph degree, code path matching.
 */
function applyScoring(
  results: RecallResult[],
  opts: {
    query: string;
    db: Database;
    projectId: string;
    mode: "fts" | "vector" | "hybrid";
    currentFilePath?: string | null;
    graphDegrees?: Map<string, number>;
  },
): RecallResult[] {
  const taskType = classifyTaskContext(opts.query);
  const weights = selectWeights(taskType);
  const isOperational = detectsOperationalContext(opts.query);
  const graphDegrees =
    opts.graphDegrees ?? graphDegreesForResults(opts.db, opts.projectId, results);

  const entries: Array<{ input: RecallScoreInput; original: RecallResult; originalRank: number }> =
    results.map((r) => {
      const item = r.item;

      // Parse metadata once for feedback score and access count
      let feedbackScore = 0;
      let accessCount = 1;
      try {
        const meta = JSON.parse(item.metadata_json);
        feedbackScore = meta.feedback_score ?? 0;
        accessCount = meta.feedback_events ?? 1;
      } catch {
        /* ignore parse errors */
      }

      const isCodePathMatch = opts.currentFilePath
        ? item.metadata_json.includes(opts.currentFilePath)
        : false;

      const input: RecallScoreInput = {
        similarity: r.rank <= 3 ? 0.9 : 1.0 / (1 + r.rank), // approximate from rank
        ftsRank: r.rank,
        item,
        accessCount,
        feedbackScore,
        graphDegree: graphDegrees.get(item.id) ?? 0,
        isCodePathMatch,
        isOperationalContext: isOperational,
      };
      return { input, original: r, originalRank: r.rank };
    });

  const ranked = rankRecallResults(
    entries.map((entry) => entry.input),
    weights,
  );
  const byId = new Map(entries.map((entry) => [entry.input.item.id, entry]));
  return ranked.map((r, i) => ({
    item: r.item,
    rank: i + 1,
    snippet:
      byId.get(r.item.id)?.original.snippet ?? r.item.text.slice(0, CONFIG.service.snippetLength),
    explanation: explainRecallResult(r, r, {
      taskType,
      mode: opts.mode,
      originalRank: byId.get(r.item.id)?.originalRank ?? i + 1,
    }),
  }));
}

function boostCurrentFileMatches(
  db: Database,
  projectId: string,
  currentFilePath: string | null | undefined,
  results: RecallResult[],
): RecallResult[] {
  if (!currentFilePath) {
    return results;
  }

  const linkedRows = db
    .query(`
    SELECT mcl.memory_id
    FROM memory_code_links mcl
    JOIN code_entities ce ON ce.id = mcl.entity_id
    WHERE mcl.project_id = ? AND ce.path = ?
  `)
    .all(projectId, currentFilePath) as { memory_id: string }[];
  const linkedMemoryIds = new Set(linkedRows.map((r) => r.memory_id));

  const boosted = results.map((res) => ({
    ...res,
    rank: linkedMemoryIds.has(res.item.id) ? res.rank - 100.0 : res.rank,
  }));
  boosted.sort((a, b) => a.rank - b.rank);
  return boosted;
}

export function recall(
  db: Database,
  projectId: string,
  query: string,
  limit?: number,
  mode: "fts" | "vector" | "hybrid" = "fts",
  embedding?: Float32Array | null,
  currentFilePath?: string | null,
  opts?: RecallOptions,
): RecallResult[] {
  const finalLimit = limit ?? 10;
  const effectiveQuery = expandedQuery(query, opts);
  const queryEmbedding =
    embedding ?? (mode === "fts" ? null : embeddingForText(embeddingQuery(query, opts)));

  let results: RecallResult[];
  if (mode === "fts" || !queryEmbedding) {
    results = searchMemoryFts(db, projectId, effectiveQuery, stageOneLimit(finalLimit)).map(
      (r, i) => ({
        item: r.item,
        rank: i + 1,
        snippet: r.snippet,
      }),
    );
  } else {
    const queryText = mode === "hybrid" ? effectiveQuery : null;
    results = hybridRetrieve(
      db,
      projectId,
      queryText,
      queryEmbedding,
      stageOneLimit(finalLimit),
    ).map((r, i) => ({
      item: r.item,
      rank: i + 1,
      snippet: r.item.text.slice(0, CONFIG.service.snippetLength),
    }));
  }

  results = applyRerank(query, results, finalLimit, opts?.rerank !== false, currentFilePath);
  // P2: Multi-factor scoring after reranking
  results = applyScoring(results, { query, db, projectId, mode, currentFilePath });
  return boostCurrentFileMatches(db, projectId, currentFilePath, results);
}

export function hybridRecall(
  db: Database,
  projectId: string,
  query: string | null,
  embedding: Float32Array | null,
  limit = 10,
): HybridQueryResult[] {
  const queryEmbedding = embedding ?? (query?.trim() ? embeddingForText(query) : null);
  return hybridRetrieve(db, projectId, query, queryEmbedding, limit);
}

export function getMemoriesForCode(
  db: Database,
  projectId: string,
  path: string,
  symbol?: string,
): CodeMemoryResult[] {
  return getMemoriesForCodeRows(db, projectId, path, symbol);
}
