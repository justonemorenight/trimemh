import { CONFIG } from "../config";
/**
 * Intelligent Memory Chunking (Phase 2 — Intelligence Upgrade)
 *
 * Splits long memory text into semantic chunks for progressive disclosure.
 * Uses paragraph + sentence boundary detection to avoid mid-sentence cuts.
 *
 * Strategy:
 * 1. Split by paragraph boundaries (\n\n)
 * 2. If a paragraph exceeds maxChunkWords, sub-split by sentence boundaries
 * 3. If a sentence still exceeds maxChunkWords, hard-split at word boundary
 * 4. Each chunk receives a similarity score against the query
 * 5. Top-N chunks are loaded in Layer 2, rest deferred to Layer 3
 *
 * Design constraints:
 * - Deterministic: same input → same chunks (no random splits)
 * - Overlap: adjacent chunks share 1 sentence for context continuity
 * - Token-aware: chunks respect a configurable word budget
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface TextChunk {
  /** 0-based index within the memory. */
  index: number;
  /** The chunked text. */
  text: string;
  /** Start character offset in original text. */
  charStart: number;
  /** End character offset in original text. */
  charEnd: number;
  /** Approximate word count. */
  wordCount: number;
}

export interface ChunkResult {
  chunks: TextChunk[];
  totalChunks: number;
  originalWordCount: number;
}

export interface RankedChunk extends TextChunk {
  /** Similarity score with query (0-1). Higher = more relevant. */
  score: number;
}

// ─── Configuration ──────────────────────────────────────────────────

export interface ChunkingConfig {
  /** Max words per chunk (default 150). */
  maxChunkWords: number;
  /** Number of sentences to overlap between adjacent chunks (default 1). */
  overlapSentences: number;
  /** Min words before chunking activates (default 300). Below this, text is one chunk. */
  minWordsForChunking: number;
}

export const DEFAULT_CHUNK_CONFIG: ChunkingConfig = {
  maxChunkWords: CONFIG.chunking.maxChunkWords,
  overlapSentences: CONFIG.chunking.overlapSentences,
  minWordsForChunking: CONFIG.chunking.minWordsForChunking,
};

// ─── Sentence splitting ─────────────────────────────────────────────

const SENTENCE_BOUNDARY = /(?<=[.!?。！？\n])\s+(?=[A-ZÀ-ỸĐa-zà-ỹđ0-9])/g;

function splitSentences(text: string): string[] {
  const raw = text.split(SENTENCE_BOUNDARY);
  return raw.map((s) => s.trim()).filter((s) => s.length > 0);
}

function wordCount(text: string): number {
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  return text.split(/\s+/).filter(Boolean).length;
}

// ─── Core chunking logic ────────────────────────────────────────────

/**
 * Split text into overlapping semantic chunks.
 *
 * Algorithm:
 * 1. Split text → paragraphs (by \n\n)
 * 2. For each paragraph that exceeds maxChunkWords:
 *    a. Split paragraph → sentences
 *    b. Accumulate sentences until word count reaches maxChunkWords
 *    c. Add overlap sentences from previous chunk's end to next chunk's start
 * 3. Track character offsets for progressive disclosure
 */
export function chunkText(text: string, config: Partial<ChunkingConfig> = {}): ChunkResult {
  const cfg = { ...DEFAULT_CHUNK_CONFIG, ...config };
  const totalWords = wordCount(text);

  // Short text — single chunk
  if (totalWords < cfg.minWordsForChunking) {
    const chunk: TextChunk = {
      index: 0,
      text: text.trim(),
      charStart: 0,
      charEnd: text.length,
      wordCount: totalWords,
    };
    return { chunks: [chunk], totalChunks: 1, originalWordCount: totalWords };
  }

  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  const paragraphs = text.split(/\n\n+/);
  const chunks: TextChunk[] = [];
  let charOffset = 0;
  let currentBuffer: string[] = [];
  let currentWords = 0;
  let chunkIndex = 0;

  function flushChunk(): void {
    if (currentBuffer.length === 0) {
      return;
    }
    // biome-ignore lint/nursery/noShadow: warning suppression
    const chunkText = currentBuffer.join(" ").trim();
    if (!chunkText) {
      return;
    }
    chunks.push({
      index: chunkIndex++,
      text: chunkText,
      charStart: charOffset - chunkText.length,
      charEnd: charOffset,
      wordCount: wordCount(chunkText),
    });
    // Keep overlap sentences for next chunk
    const sentences = splitSentences(chunkText);
    const overlap = sentences.slice(-cfg.overlapSentences);
    currentBuffer = overlap;
    currentWords = wordCount(overlap.join(" "));
  }

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) {
      continue;
    }

    const paraWords = wordCount(trimmed);

    // Track char offset through original text
    const paraStart = text.indexOf(trimmed, charOffset);
    if (paraStart >= 0) {
      charOffset = paraStart;
    }

    if (currentWords + paraWords <= cfg.maxChunkWords) {
      // Paragraph fits in current chunk
      currentBuffer.push(trimmed);
      currentWords += paraWords;
      charOffset = paraStart + trimmed.length;
    } else if (paraWords <= cfg.maxChunkWords) {
      // Paragraph fits in a new chunk
      flushChunk();
      currentBuffer.push(trimmed);
      currentWords = paraWords;
      charOffset = paraStart + trimmed.length;
    } else {
      // Paragraph too large — split by sentences
      flushChunk();
      const sentences = splitSentences(trimmed);

      for (const sentence of sentences) {
        const sentWords = wordCount(sentence);
        const sentStart = text.indexOf(sentence, charOffset);
        if (sentStart >= 0) {
          charOffset = sentStart;
        }

        if (currentWords + sentWords <= cfg.maxChunkWords) {
          currentBuffer.push(sentence);
          currentWords += sentWords;
        } else {
          // Sentence would overflow — flush and start new
          flushChunk();
          currentBuffer.push(sentence);
          currentWords = sentWords;
        }
        charOffset = (sentStart >= 0 ? sentStart : charOffset) + sentence.length;
      }
    }
  }

  // Flush remaining buffer
  flushChunk();

  return {
    chunks,
    totalChunks: chunks.length,
    originalWordCount: totalWords,
  };
}

// ─── Query-aware chunk ranking ──────────────────────────────────────

/**
 * Score chunks against a query using simple lexical overlap (BM25-inspired).
 * For production, replace with embedding-based similarity.
 *
 * Scoring factors:
 * - Term frequency in chunk (TF component)
 * - Inverse chunk frequency (IDF-like: rare terms across chunks score higher)
 * - Word count penalty (shorter chunks have higher density)
 */
export function rankChunks(chunks: TextChunk[], query: string): RankedChunk[] {
  if (!query.trim()) {
    // No query — return chunks in original order with uniform score
    return chunks.map((chunk) => ({ ...chunk, score: 0.5 }));
  }

  const queryTerms = query
    .toLowerCase()
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    .split(/\s+/)
    .filter((t) => t.length > 1);

  if (queryTerms.length === 0) {
    return chunks.map((chunk) => ({ ...chunk, score: 0.5 }));
  }

  // Compute term frequency per chunk
  const chunkTFs: Map<string, number>[] = chunks.map((chunk) => {
    const tf = new Map<string, number>();
    const lower = chunk.text.toLowerCase();
    for (const term of queryTerms) {
      const count = (lower.match(new RegExp(escapeRegex(term), "g")) || []).length;
      if (count > 0) {
        tf.set(term, count);
      }
    }
    return tf;
  });

  // Compute IDF per term
  const totalChunks = chunks.length;
  const idf = new Map<string, number>();
  for (const term of queryTerms) {
    const docCount = chunkTFs.filter((tf) => tf.has(term)).length;
    idf.set(term, Math.log(1 + (totalChunks - docCount + 0.5) / (docCount + 0.5)));
  }

  // Score each chunk
  const k1 = CONFIG.chunking.bm25K1; // BM25 term saturation
  const b = CONFIG.chunking.bm25B; // length normalization
  const avgLen = chunks.reduce((sum, c) => sum + c.wordCount, 0) / Math.max(1, totalChunks);

  const ranked: RankedChunk[] = chunks.map((chunk, i) => {
    const tf = chunkTFs[i] ?? new Map();
    let score = 0;
    for (const [term, freq] of tf) {
      const idfVal = idf.get(term) ?? 0;
      const tfNorm = (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (chunk.wordCount / avgLen)));
      score += idfVal * tfNorm;
    }
    return { ...chunk, score };
  });

  // Normalize scores to [0, 1]
  const maxScore = Math.max(...ranked.map((r) => r.score), 0.01);
  for (const r of ranked) {
    r.score = Math.round((r.score / maxScore) * 1000) / 1000;
  }

  // biome-ignore lint/nursery/noShadow: warning suppression
  return ranked.sort((a, b) => b.score - a.score);
}

/**
 * Select top-N chunks based on score, keeping total words under budget.
 */
export function selectTopChunks(
  ranked: RankedChunk[],
  maxChunks = CONFIG.chunking.maxDetailChunks,
  wordBudget = CONFIG.chunking.detailWordBudget,
): RankedChunk[] {
  const selected: RankedChunk[] = [];
  let wordTotal = 0;

  for (const chunk of ranked) {
    if (selected.length >= maxChunks) {
      break;
    }
    if (wordTotal + chunk.wordCount > wordBudget && selected.length > 0) {
      break;
    }
    selected.push(chunk);
    wordTotal += chunk.wordCount;
  }

  // Restore original order
  return selected.sort((a, b) => a.index - b.index);
}

// ─── Helpers ────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── High-level API ─────────────────────────────────────────────────

export interface ChunkedMemory {
  memoryId: string;
  fullText: string;
  chunks: TextChunk[];
  totalChunks: number;
}

/**
 * Prepare a memory for progressive disclosure:
 * 1. Chunk the full text
 * 2. Rank chunks against query
 * 3. Return top chunks for Layer 2, remainder reference for Layer 3
 */
export function prepareChunkedDisclosure(
  _memoryId: string,
  text: string,
  query: string,
  opts: {
    maxChunkWords?: number;
    maxDetailChunks?: number;
    detailWordBudget?: number;
  } = {},
): {
  layer2Chunks: RankedChunk[];
  layer3Chunks: TextChunk[];
  chunked: boolean;
} {
  const { chunks } = chunkText(text, {
    maxChunkWords: opts.maxChunkWords ?? 150,
  });

  if (chunks.length <= 1) {
    return {
      layer2Chunks: chunks.map((c) => ({ ...c, score: 1.0 })),
      layer3Chunks: [],
      chunked: false,
    };
  }

  const ranked = rankChunks(chunks, query);
  const selected = selectTopChunks(ranked, opts.maxDetailChunks ?? 3, opts.detailWordBudget ?? 500);

  const selectedIndices = new Set(selected.map((c) => c.index));
  const deferred = ranked
    .filter((c) => !selectedIndices.has(c.index))
    .sort((a, b) => a.index - b.index);

  return {
    layer2Chunks: selected,
    layer3Chunks: deferred,
    chunked: true,
  };
}
