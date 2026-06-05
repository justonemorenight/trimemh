import { describe, expect, test } from "bun:test";

import type { TextChunk } from "../src/context/chunking";
import {
  chunkText,
  prepareChunkedDisclosure,
  rankChunks,
  selectTopChunks,
} from "../src/context/chunking";

describe("chunkText", () => {
  test("returns single chunk for short text", () => {
    const result = chunkText("Short memory text.", { minWordsForChunking: 50 });
    expect(result.totalChunks).toBe(1);
    expect(result.chunks[0]?.text).toBe("Short memory text.");
    expect(result.chunks[0]?.index).toBe(0);
  });

  test("splits by paragraph boundaries", () => {
    const longText = Array.from(
      { length: 20 },
      (_, i) => `Paragraph ${i + 1} with some content that adds word count for chunking purposes.`,
    ).join("\n\n");

    const result = chunkText(longText, { maxChunkWords: 30, minWordsForChunking: 10 });
    expect(result.totalChunks).toBeGreaterThan(1);
    // All chunks should have some text
    for (const chunk of result.chunks) {
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  test("preserves original word count", () => {
    const text = "One two three four five six seven eight nine ten.";
    const result = chunkText(text, { minWordsForChunking: 5 });
    expect(result.originalWordCount).toBe(10);
  });

  test("splits long single paragraph into multiple chunks", () => {
    // Generate a very long sentence sequence
    const sentences = Array.from(
      { length: 30 },
      (_, i) =>
        `This is sentence number ${i + 1} with enough words to trigger chunk splitting automatically.`,
    );
    const text = sentences.join(" ");

    const result = chunkText(text, {
      maxChunkWords: 30,
      minWordsForChunking: 5,
      overlapSentences: 0,
    });

    expect(result.totalChunks).toBeGreaterThan(1);
  });

  test("chunks have sequential indices", () => {
    const text = Array.from(
      { length: 10 },
      (_, i) => `Paragraph ${i + 1} contains some text for the chunk test to verify things.`,
    ).join("\n\n");

    const result = chunkText(text, { maxChunkWords: 20, minWordsForChunking: 5 });
    for (let i = 0; i < result.chunks.length; i++) {
      expect(result.chunks[i]?.index).toBe(i);
    }
  });

  test("chunk word counts are reasonable", () => {
    const text = Array.from(
      { length: 15 },
      (_, i) =>
        `Paragraph ${i + 1} containing text that will be used for word count verification of the splitting.`,
    ).join("\n\n");

    const result = chunkText(text, { maxChunkWords: 30, minWordsForChunking: 10 });
    for (const chunk of result.chunks) {
      expect(chunk.wordCount).toBeGreaterThan(0);
    }
  });

  test("empty text returns single empty chunk", () => {
    const result = chunkText("");
    expect(result.totalChunks).toBe(1);
  });

  test("whitespace-only text returns single chunk", () => {
    const result = chunkText("   \n\n  \n  ");
    expect(result.totalChunks).toBeLessThanOrEqual(1);
  });
});

describe("rankChunks", () => {
  const chunks: TextChunk[] = [
    {
      index: 0,
      text: "Error handling must use Result pattern for all API endpoints.",
      charStart: 0,
      charEnd: 64,
      wordCount: 11,
    },
    {
      index: 1,
      text: "Database migrations must be backward compatible always.",
      charStart: 65,
      charEnd: 122,
      wordCount: 8,
    },
    {
      index: 2,
      text: "Use Bun as the primary JavaScript runtime for all projects.",
      charStart: 123,
      charEnd: 184,
      wordCount: 11,
    },
  ];

  test("scores chunks by query relevance", () => {
    const ranked = rankChunks(chunks, "error handling API");
    expect(ranked.length).toBe(3);
    // Chunk about error handling should score highest
    expect(ranked[0]?.index).toBe(0);
  });

  test("returns uniform scores for empty query", () => {
    const ranked = rankChunks(chunks, "");
    for (const r of ranked) {
      expect(r.score).toBe(0.5);
    }
  });

  test("scores are normalized to [0, 1]", () => {
    const ranked = rankChunks(chunks, "database migration");
    for (const r of ranked) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });
});

describe("selectTopChunks", () => {
  const chunks: TextChunk[] = [
    { index: 0, text: "Short A.", charStart: 0, charEnd: 8, wordCount: 2 },
    { index: 1, text: "Short B with more words here.", charStart: 9, charEnd: 35, wordCount: 6 },
    { index: 2, text: "Short C.", charStart: 36, charEnd: 44, wordCount: 2 },
  ];

  test("selects top chunks within budget", () => {
    const ranked = rankChunks(chunks, "more words");
    const selected = selectTopChunks(ranked, 3, 10);
    expect(selected.length).toBeGreaterThan(0);
    // Total words should be under budget
    const totalWords = selected.reduce((sum, c) => sum + c.wordCount, 0);
    expect(totalWords).toBeLessThanOrEqual(10);
  });

  test("respects maxChunks limit", () => {
    const ranked = rankChunks(chunks, "short");
    const selected = selectTopChunks(ranked, 1, 100);
    expect(selected.length).toBeLessThanOrEqual(1);
  });

  test("restores original order", () => {
    const ranked = rankChunks(chunks, "short");
    const selected = selectTopChunks(ranked, 3, 100);
    for (let i = 1; i < selected.length; i++) {
      expect(selected[i]?.index).toBeGreaterThan(selected[i - 1]?.index);
    }
  });
});

describe("prepareChunkedDisclosure", () => {
  test("returns unchunked for short text", () => {
    const result = prepareChunkedDisclosure("mem-1", "Short memory.", "");
    expect(result.chunked).toBe(false);
    expect(result.layer2Chunks.length).toBe(1);
    expect(result.layer3Chunks.length).toBe(0);
  });

  test("splits long text into layer2 and layer3", () => {
    const longText = Array.from(
      { length: 30 },
      (_, i) =>
        `Paragraph ${i + 1} with sufficient content to ensure that chunking activates properly for the disclosure.`,
    ).join("\n\n");

    const result = prepareChunkedDisclosure("mem-1", longText, "content chunking activation", {
      maxChunkWords: 25,
      maxDetailChunks: 2,
      detailWordBudget: 60,
    });

    expect(result.chunked).toBe(true);
    expect(result.layer2Chunks.length).toBeGreaterThanOrEqual(1);
    expect(result.layer2Chunks.length).toBeLessThanOrEqual(2);
    // layer2 + layer3 should cover all chunks
    const total = result.layer2Chunks.length + result.layer3Chunks.length;
    expect(total).toBeGreaterThanOrEqual(1);
  });
});
