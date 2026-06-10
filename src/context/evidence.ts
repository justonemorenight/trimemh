import type { MemoryItem, MemoryKind } from "../domain/schema";
import type { EvidenceLabel, ResolvedCompressionPolicy } from "./compression-policy";
import { structuredContextForMemory } from "./structured-memory";

export type EvidenceMode = "auto" | "off" | "force";

export interface MemoryEvidenceInput {
  memoryId: string;
  kind: MemoryKind;
  label: EvidenceLabel;
  text: string;
  score: number;
  sourceStart?: number;
  sourceEnd?: number;
}

export interface ContextAccuracySignals {
  evidenceMode: EvidenceMode;
  evidenceEnabled: boolean;
  queryTerms: string[];
  retrievalSubqueries: string[];
  selectedEvidenceCount: number;
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "about",
  "when",
  "where",
  "what",
  "which",
  "should",
  "would",
  "could",
  "must",
  "have",
  "has",
  "had",
  "are",
  "was",
  "were",
  "can",
  "will",
  "plan",
  "debug",
  "review",
  "code",
]);
const QUERY_TERM_SPLIT_RE = /[^a-z0-9_-]+/;
const PATH_TERM_SEPARATOR_RE = /[/.]/g;

export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of query.toLowerCase().split(QUERY_TERM_SPLIT_RE)) {
    const term = raw.trim();
    if (term.length < 3 || STOP_WORDS.has(term)) {
      continue;
    }
    seen.add(term);
  }
  return [...seen].slice(0, 20);
}

function termOverlap(text: string, terms: string[]): number {
  if (terms.length === 0) {
    return 0;
  }
  const lower = text.toLowerCase();
  return terms.filter((term) => lower.includes(term)).length / terms.length;
}

export function selectMemoryEvidence(
  details: Array<{ item: MemoryItem }>,
  query: string,
  policy: ResolvedCompressionPolicy,
): MemoryEvidenceInput[] {
  const terms = queryTerms(query);
  const candidates: MemoryEvidenceInput[] = [];

  for (const detail of details) {
    const structured = structuredContextForMemory(detail.item);
    for (const span of structured.evidence_spans) {
      const overlap = termOverlap(span.text, terms);
      const labelWeight = policy.labelWeights[span.label] ?? 1;
      const tokenPenalty = Math.ceil(span.text.length / 4) * policy.tokenPenalty;
      const score = span.score * labelWeight + overlap * policy.queryTermWeight - tokenPenalty;
      if (score < policy.evidenceMinScore) {
        continue;
      }
      candidates.push({
        memoryId: detail.item.id,
        kind: detail.item.kind,
        label: span.label,
        text: span.text,
        score: Number(score.toFixed(3)),
        sourceStart: span.source_start,
        sourceEnd: span.source_end,
      });
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.memoryId.localeCompare(b.memoryId))
    .slice(0, policy.maxEvidenceSpans);
}

export function generateEvidenceSubqueries(input: {
  query: string;
  details: Array<{ item: MemoryItem }>;
  openPaths?: string[];
  policy: ResolvedCompressionPolicy;
}): string[] {
  const terms = queryTerms(input.query);
  const evidence = selectMemoryEvidence(input.details, input.query, {
    ...input.policy,
    evidenceMinScore: 0,
    maxEvidenceSpans: Math.min(4, input.policy.maxEvidenceSpans),
  });
  const subqueries = new Set<string>();

  for (const span of evidence) {
    const spanTerms = queryTerms(span.text).slice(0, 8);
    if (spanTerms.length > 0) {
      subqueries.add([...terms.slice(0, 6), ...spanTerms].join(" "));
    }
  }

  for (const path of input.openPaths ?? []) {
    const pathTerms = queryTerms(path.replace(PATH_TERM_SEPARATOR_RE, " ")).slice(0, 6);
    if (pathTerms.length > 0) {
      subqueries.add([...terms.slice(0, 6), ...pathTerms].join(" "));
    }
  }

  return [...subqueries].filter(Boolean).slice(0, 3);
}
