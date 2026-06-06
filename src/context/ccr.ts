/**
 * CCR — Context Compression with Retrieval (P0 — Token Reduction)
 *
 * Inspired by headroom's reversible compression: compress context that goes
 * into the LLM prompt, but keep originals accessible via an MCP tool. When
 * the LLM needs full detail, it calls `memory_retrieve` to fetch the original.
 *
 * Strategy (per content length):
 *   Short  (< 300 words)  → full text, no compression
 *   Medium (300-1000 w)   → first 2 + last 2 sentences, "[compressed N tokens]"
 *   Long   (> 1000 words) → first sentence + key entities + last sentence
 *
 * Each compressed detail receives a `retrieval_key` that the LLM can use
 * with the `memory_retrieve` MCP tool to fetch the original on demand.
 */

import { CONFIG } from "../config";
import type { MemoryItem } from "../domain/schema";
import { guardXmlPayload } from "../infrastructure/guardrail";
import { truncateWords } from "../infrastructure/sanitize";

// ─── Types ──────────────────────────────────────────────────────────

export interface DeferredDetail {
  /** Memory ID for retrieval */
  memoryId: string;
  /** Full original text (stored server-side, never sent to LLM) */
  fullText: string;
  /** The compressed summary that WAS sent to the LLM */
  summary: string;
  /** Estimated tokens saved by compressing this detail */
  tokenSaved: number;
  /** MCP retrieval key: "trimemh:<memoryId>" */
  retrievalKey: string;
}

export interface CompressionResult {
  /** Display text to inject into the prompt */
  display: string;
  /** Deferred detail if compression was applied, null if full text was sent */
  deferred: DeferredDetail | null;
}

export interface CcrStore {
  /** Map of retrieval key → deferred detail, keyed by "trimemh:<memoryId>" */
  deferred: Map<string, DeferredDetail>;
  /** Total tokens saved across all compressions this turn */
  totalTokensSaved: number;
  /** Number of details that were compressed (vs sent in full) */
  compressedCount: number;
  /** Number of details sent in full (no compression needed) */
  fullCount: number;
}

// ─── Sentence splitting ─────────────────────────────────────────────

const SENTENCE_RE = /(?<=[.!?。！？\n])\s+(?=[A-ZÀ-ỸĐa-zà-ỹđ0-9])/;

function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function wordCount(text: string): number {
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  return text.split(/\s+/).filter(Boolean).length;
}

// ─── Key entity extraction ──────────────────────────────────────────

/**
 * Extract key named entities and technical terms from text.
 * These are preserved in the compressed summary to maintain semantic context.
 */
function extractKeyEntities(text: string): string[] {
  const patterns = [
    // Code identifiers
    /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g, // PascalCase
    /\b([a-z]+(?:[A-Z][a-z]+)+)\b/g, // camelCase
    /\b([A-Z_]{3,})\b/g, // CONSTANTS
    // Paths and URLs
    /\b([\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|sql|yaml|yml|toml|json))\b/g,
    // Versioned identifiers
    /\b(v\d+\.\d+(?:\.\d+)?)\b/g,
  ];

  const entities = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const entity = match[1];
      if (entity && entity.length > 2 && entity.length < 64) {
        entities.add(entity);
      }
    }
  }

  return [...entities].slice(0, 10); // top 10 unique
}

// ─── Compression strategies ─────────────────────────────────────────

/**
 * Short text: no compression, return full text.
 */
function compressShort(text: string): CompressionResult {
  return {
    display: guardXmlPayload(text),
    deferred: null,
  };
}

/**
 * Medium text (300-1000 words): keep first 2 + last 2 sentences.
 * The middle is summarized with a token-saved count and retrieval key.
 */
function compressMedium(text: string, memoryId: string): CompressionResult {
  const sentences = splitSentences(text);
  const totalWords = wordCount(text);

  if (sentences.length <= 4) {
    // Not enough sentences to meaningfully compress — still send full
    return compressShort(text);
  }

  const headSentences = sentences.slice(0, 2);
  const tailSentences = sentences.slice(-2);
  const summary =
    headSentences.join(" ") +
    `\n⤷ [${totalWords - wordCount(headSentences.join(" ")) - wordCount(tailSentences.join(" "))} words compressed — retrieve with: memory_retrieve("${memoryId}")]` +
    "\n" +
    tailSentences.join(" ");

  const fullTokens = Math.ceil(text.length / 4);
  const summaryTokens = Math.ceil(summary.length / 4);
  const tokenSaved = Math.max(0, fullTokens - summaryTokens);

  return {
    display: guardXmlPayload(summary),
    deferred: {
      memoryId,
      fullText: text,
      summary,
      tokenSaved,
      retrievalKey: `trimemh:${memoryId}`,
    },
  };
}

/**
 * Long text (> 1000 words): first sentence + key entities + last sentence.
 * Maximum compression — preserves only the semantic gist.
 */
function compressLong(text: string, memoryId: string): CompressionResult {
  const sentences = splitSentences(text);
  const totalWords = wordCount(text);
  const entities = extractKeyEntities(text);

  const firstSentence = sentences[0] ?? "";
  const lastSentence = sentences[sentences.length - 1] ?? "";

  const entityLine = entities.length > 0 ? `\n⤷ entities: ${entities.join(", ")}` : "";

  const summary =
    truncateWords(firstSentence, CONFIG.ccr.longDisplayWords) +
    `\n⤷ [${totalWords} words compressed — retrieve with: memory_retrieve("${memoryId}")]` +
    entityLine +
    "\n" +
    truncateWords(lastSentence, CONFIG.ccr.longDisplayWords);

  const fullTokens = Math.ceil(text.length / 4);
  const summaryTokens = Math.ceil(summary.length / 4);
  const tokenSaved = Math.max(0, fullTokens - summaryTokens);

  return {
    display: guardXmlPayload(summary),
    deferred: {
      memoryId,
      fullText: text,
      summary,
      tokenSaved,
      retrievalKey: `trimemh:${memoryId}`,
    },
  };
}

// ─── Main compression API ───────────────────────────────────────────

/**
 * Compress a memory detail for prompt injection.
 *
 * Decision tree:
 *   words < 300   → full text (no compression)
 *   300 ≤ words ≤ 1000 → medium (head+tail sentences)
 *   words > 1000  → long (first sentence + entities + last sentence)
 *
 * Returns the display text AND an optional DeferredDetail for CCR retrieval.
 */
export function compressDetail(
  item: MemoryItem,
  opts: {
    /** Override short threshold */
    shortThreshold?: number;
    /** Override medium threshold */
    mediumThreshold?: number;
  } = {},
): CompressionResult {
  const text = item.text;
  const words = wordCount(text);
  const shortThreshold = opts.shortThreshold ?? CONFIG.ccr.shortThresholdWords;
  const mediumThreshold = opts.mediumThreshold ?? CONFIG.ccr.mediumThresholdWords;

  if (words < shortThreshold) {
    return compressShort(text);
  }

  if (words <= mediumThreshold) {
    return compressMedium(text, item.id);
  }

  return compressLong(text, item.id);
}

// ─── CCR Store (per-turn tracking) ──────────────────────────────────

/**
 * Create a fresh CCR store for a new turn.
 */
export function createCcrStore(): CcrStore {
  return {
    deferred: new Map(),
    totalTokensSaved: 0,
    compressedCount: 0,
    fullCount: 0,
  };
}

/**
 * Register a deferred detail in the store.
 * Called after compressing a detail that produced a DeferredDetail.
 */
export function registerDeferred(store: CcrStore, deferred: DeferredDetail): void {
  store.deferred.set(deferred.retrievalKey, deferred);
  store.totalTokensSaved += deferred.tokenSaved;
  store.compressedCount++;
}

/**
 * Track a full-text (non-compressed) detail for stats.
 */
export function trackFullText(store: CcrStore): void {
  store.fullCount++;
}

/**
 * Retrieve a deferred detail by its retrieval key.
 * Returns null if the key is not found or has expired (turn ended).
 */
export function retrieveDeferred(store: CcrStore, retrievalKey: string): DeferredDetail | null {
  return store.deferred.get(retrievalKey) ?? null;
}

/**
 * Clear all deferred details at turn end.
 * CCR data is turn-isolated (like Layer 3 lineage).
 */
export function clearCcrStore(store: CcrStore): void {
  store.deferred.clear();
  store.totalTokensSaved = 0;
  store.compressedCount = 0;
  store.fullCount = 0;
}

// ─── Serialization for MCP response ─────────────────────────────────

/**
 * Format the deferred keys list for the prompt metadata comment.
 * The LLM sees this and knows which memories are retrievable.
 */
export function formatDeferredKeys(store: CcrStore): string {
  if (store.deferred.size === 0) {
    return "none";
  }
  return [...store.deferred.keys()].join(",");
}

/**
 * Format CCR stats for the prompt metadata.
 */
export function formatCcrStats(store: CcrStore): string {
  return [
    `ccr_compressed=${store.compressedCount}`,
    `ccr_full=${store.fullCount}`,
    `ccr_tokens_saved=${store.totalTokensSaved}`,
    `ccr_retrievable=${store.deferred.size}`,
  ].join("\n");
}
