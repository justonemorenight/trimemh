/**
 * Content sniffers — detect the type of incoming memory content.
 *
 * Content types detected:
 *   code     — source code (signatures only, body deferred)
 *   log      — application logs (errors only, collapse repeats)
 *   json     — structured data (keys/schema only)
 *   config   — configuration files (key names only)
 *   diff     — patches/diffs (file names + change counts)
 *   prose    — natural language (CCR smart truncation)
 */

import { CONFIG } from "../config";
import type { MemoryItem } from "../domain/schema";

// ─── Types ──────────────────────────────────────────────────────────

export type MemoryContentType = "code" | "log" | "json" | "config" | "diff" | "prose";

export interface ContentMatch {
  type: MemoryContentType;
  confidence: number; // 0-1, how confident the sniffer is
}

export interface RenderedContent {
  /** The display text for prompt injection */
  display: string;
  /** Content type that was detected */
  contentType: MemoryContentType;
  /** Whether compression was applied */
  compressed: boolean;
  /** Approximate tokens in the display text */
  displayTokens: number;
}

// ─── Content sniffers ────────────────────────────────────────────────

interface ContentSniffer {
  type: MemoryContentType;
  /** Returns confidence 0-1. Higher = more certain match. */
  test: (text: string) => number;
}

const CODE_TRAILING_STRUCTURE_RE = /[{};]\s*$/;
const DOCKERFILE_DIRECTIVE_RE =
  /^(FROM|RUN|COPY|ENV|EXPOSE|CMD|ENTRYPOINT|WORKDIR|ADD|VOLUME|USER|ARG|LABEL)\s/m;

const SNIFFERS: ContentSniffer[] = [
  {
    type: "diff",
    test: (text) => {
      const lines = text.split("\n");
      let diffMarkers = 0;
      let nonDiffLines = 0;
      let contextLines = 0;
      for (const line of lines.slice(0, 25)) {
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        if (/^diff --git|^@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@|^---\s|^\+\+\+\s/.test(line)) {
          diffMarkers += 3;
          // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        } else if (/^[+-]/.test(line) && !/^\+\+\+/.test(line) && !/^---/.test(line)) {
          diffMarkers++;
          // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        } else if (/^ /.test(line)) {
          contextLines++;
        } else if (line.trim().length > 0) {
          nonDiffLines++;
        }
      }
      const effectiveNonDiff = nonDiffLines - contextLines * 0.5;
      const penalty = effectiveNonDiff > 10 ? 0.5 : effectiveNonDiff > 5 ? 0.7 : 1.0;
      return Math.min(1.0, (diffMarkers / 6) * penalty);
    },
  },
  {
    type: "code",
    test: (text) => {
      let score = 0;
      const firstLines = text.split("\n").slice(0, 80).join("\n");

      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      if (/^```[\s\S]*```$/m.test(text)) {
        score += 0.5;
      }
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      if (/^\s*```(?:ts|tsx|js|jsx|typescript|javascript)\b/im.test(text)) {
        score += 0.7;
      }

      const lines = text.split("\n");
      let structuralLines = 0;
      let totalNonEmptyLines = 0;
      let snippetSignals = 0;

      for (const line of lines.slice(0, 80)) {
        const t = line.trim();
        if (!t) {
          continue;
        }
        totalNonEmptyLines++;

        if (
          // biome-ignore lint/performance/useTopLevelRegex: warning suppression
          /^(pub\s+)?(async\s+)?(function|class|def\s|fn\s|interface|enum|type|struct|impl|module|namespace)\s+\w/.test(
            t,
          )
        ) {
          structuralLines += 3;
        } else if (
          // biome-ignore lint/performance/useTopLevelRegex: warning suppression
          /^(import\s+|export\s+(default\s+)?(async\s+)?(function|class|const|let|var|interface|type|enum))/.test(
            t,
          )
        ) {
          structuralLines += 3;
        } else if (
          // biome-ignore lint/performance/useTopLevelRegex: warning suppression
          /\b(const|let|var)\s+\w+\s*(:\s*\w+)?\s*=/.test(t)
        ) {
          structuralLines += 1.5;
        } else if (
          // biome-ignore lint/performance/useTopLevelRegex: warning suppression
          /^[A-Za-z_$][\w$-]*\s*:\s*[^,]+,?$/.test(t)
        ) {
          structuralLines += 0.75;
        } else if (
          // biome-ignore lint/performance/useTopLevelRegex: warning suppression
          /^(if|else if|for|while|switch|try|catch|finally)\b/.test(t)
        ) {
          structuralLines += 1;
        } else if (
          // biome-ignore lint/performance/useTopLevelRegex: warning suppression
          /^[{};]\s*$/.test(t) ||
          CODE_TRAILING_STRUCTURE_RE.test(t)
        ) {
          structuralLines += 1;
        } else if (
          // biome-ignore lint/performance/useTopLevelRegex: warning suppression
          /^\s*(return|throw|await|yield)\s/.test(t)
        ) {
          structuralLines += 1;
        } else if (
          // biome-ignore lint/performance/useTopLevelRegex: warning suppression
          /^( {2,4}|\t)\S/.test(t)
        ) {
          structuralLines += 0.5;
        }

        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        if (/\bnew\s+[A-Z]\w*\s*\(/.test(t)) {
          snippetSignals += 2;
        }
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        if (/=>/.test(t)) {
          snippetSignals += 1;
        }
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        if (/\bprocess\.env\.[A-Z0-9_]+\b/.test(t)) {
          snippetSignals += 1;
        }
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        if (/\basync\s+function\b|\bPromise<|\):\s*Promise\b/.test(t)) {
          snippetSignals += 1;
        }
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        if (/^\s*\/\/\s+\w/.test(line) && /[{}();=]/.test(firstLines)) {
          snippetSignals += 0.35;
        }
      }

      if (totalNonEmptyLines > 0) {
        const density = structuralLines / totalNonEmptyLines;
        if (density >= 1.5) {
          score += 0.7;
        } else if (density >= 0.8) {
          score += 0.5;
        } else if (density >= 0.4) {
          score += 0.2;
        }
      }

      if (snippetSignals >= 6) {
        score += 0.45;
      } else if (snippetSignals >= 3) {
        score += 0.25;
      }

      const sentenceCount = (text.match(/[.!?]\s+[A-Z]/g) ?? []).length;
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      const normalizedSentences = sentenceCount / Math.max(1, text.split(/\s+/).length / 15);
      if (normalizedSentences > 0.15) {
        score -= 0.2;
      }

      return Math.max(0, Math.min(1.0, score));
    },
  },
  {
    type: "log",
    test: (text) => {
      let score = 0;
      const lines = text.split("\n").slice(0, 40);
      let timestampLines = 0;
      let keywordOnlyLines = 0;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        const hasTimestamp =
          // biome-ignore lint/performance/useTopLevelRegex: warning suppression
          /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}|\[\d{4}-\d{2}-\d{2}|\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})/.test(
            trimmed,
          );

        if (hasTimestamp) {
          timestampLines++;
          // biome-ignore lint/performance/useTopLevelRegex: warning suppression
          if (/\b(ERROR|WARN|INFO|DEBUG|TRACE|FATAL|CRITICAL)\b/i.test(trimmed)) {
            timestampLines++;
          }
        } else if (
          // biome-ignore lint/performance/useTopLevelRegex: warning suppression
          /\b(ERROR|WARN|INFO|DEBUG|TRACE|FATAL|CRITICAL)\b/i.test(trimmed)
        ) {
          keywordOnlyLines++;
        }

        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        if (/^\s+at\s+\S+/.test(trimmed) && hasTimestamp) {
          timestampLines += 0.5;
        }
      }

      const effectiveLogLines =
        timestampLines + (keywordOnlyLines >= 3 ? keywordOnlyLines * 0.5 : 0);

      score = Math.min(1.0, effectiveLogLines / 8);
      return score;
    },
  },
  {
    type: "json",
    test: (text) => {
      const trimmed = text.trim();
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      if (/^\{[\s\S]*\}$/.test(trimmed) || /^\[[\s\S]*\]$/.test(trimmed)) {
        try {
          JSON.parse(trimmed);
          return 1.0;
        } catch {
          return 0.6;
        }
      }
      return 0;
    },
  },
  {
    type: "config",
    test: (text) => {
      let score = 0;
      if (DOCKERFILE_DIRECTIVE_RE.test(text)) {
        score += 0.8;
      }
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      if (/^\[.*\]\s*$/.test(text.split("\n")[0] ?? "")) {
        score += 0.5;
      }
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      if (/^[A-Z_][A-Z0-9_]*=/.test(text.split("\n")[0] ?? "")) {
        score += 0.4;
      }
      if (
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        /^[\w-]+:\s/.test(text.split("\n")[0] ?? "") &&
        !text.includes("{") &&
        !text.includes(";")
      ) {
        score += 0.3;
      }
      const lines = text.split("\n").filter(Boolean);
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      const kvLines = lines.filter((l) => /^[A-Za-z_][\w.-]*\s*[=:]\s*/.test(l)).length;
      if (lines.length > 0 && kvLines / lines.length > 0.6) {
        score += 0.5;
      }

      return Math.min(1.0, score);
    },
  },
];

export function snifferScore(type: MemoryContentType, text: string): number {
  return SNIFFERS.find((sniffer) => sniffer.type === type)?.test(text) ?? 0;
}

/**
 * Prose sniffer — detects natural language patterns.
 */
function scoreProse(text: string): number {
  let score = 0.3;

  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 20) {
    return 0.3;
  }

  const sentences = text.match(/[.!?]\s+[A-Z]/g) ?? [];
  const sentenceDensity = sentences.length / Math.max(1, words.length / 12);
  if (sentenceDensity > 0.2) {
    score += 0.3;
  } else if (sentenceDensity > 0.08) {
    score += 0.15;
  }

  const proseWords =
    text.match(
      /\b(the|a|an|is|was|are|were|been|have|has|had|will|would|should|could|may|might|can|shall|we|our|us|they|their|them|I|you|he|she|it|this|that|these|those|and|or|but|because|however|therefore|although|while|since|also|just|very|really|quite|maybe|perhaps|actually|basically|probably)\b/gi,
    ) ?? [];
  const proseDensity = proseWords.length / Math.max(1, words.length);
  if (proseDensity > 0.06) {
    score += 0.25;
  } else if (proseDensity > 0.03) {
    score += 0.1;
  }

  const bulletLines = text.match(/^(\s*[-*+•]|\s*\d+[.)]\s)/gm) ?? [];
  if (bulletLines.length >= 3) {
    score += 0.1;
  }

  const headers = text.match(/^#{1,4}\s+\w+/gm) ?? [];
  if (headers.length >= 2) {
    score += 0.15;
  }

  const codeKeywords =
    text.match(
      /\b(function|const|let|var|import|export|class|interface|type|enum|return|await|async|throw|catch|try|yield)\b/g,
    ) ?? [];
  const codeKeywordDensity = codeKeywords.length / Math.max(1, words.length);
  if (codeKeywordDensity > 0.03) {
    score -= 0.15;
  }

  return Math.max(0.25, Math.min(1.0, score));
}

/**
 * Detect the content type of a memory text.
 */
export function detectContentType(text: string): ContentMatch {
  const proseScore = scoreProse(text);
  let bestMatch: ContentMatch = { type: "prose", confidence: proseScore };

  for (const sniffer of SNIFFERS) {
    const confidence = sniffer.test(text);
    if (
      confidence > bestMatch.confidence &&
      confidence >= CONFIG.contentRouter.minNonProseConfidence
    ) {
      bestMatch = { type: sniffer.type, confidence };
    }
  }

  return bestMatch;
}

export function detectContentTypeForItem(item: MemoryItem): ContentMatch {
  const match = detectContentType(item.text);
  if (match.type !== "prose") {
    return match;
  }

  if (item.kind === "code_context") {
    const codeConfidence = snifferScore("code", item.text);
    const hasStrongCodeMarker =
      codeConfidence >= CONFIG.contentRouter.minNonProseConfidence - 0.1 ||
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      /^\s*```(?:ts|tsx|js|jsx|typescript|javascript)\b/im.test(item.text) ||
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      /\b(const|let|var)\s+\w+\s*=|\basync\s+function\b|\bnew\s+[A-Z]\w*\s*\(/.test(item.text);

    if (hasStrongCodeMarker && codeConfidence >= 0.2) {
      return {
        type: "code",
        confidence: Math.max(codeConfidence, CONFIG.contentRouter.minNonProseConfidence),
      };
    }
  }

  return match;
}
