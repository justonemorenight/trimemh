/**
 * ContentRouter (P0 — Token Reduction)
 *
 * Detects the type of incoming memory content and dispatches to the
 * appropriate renderer. Different content types need different compression
 * strategies — code benefits from AST/signature extraction, logs benefit
 * from error-line filtering, JSON benefits from schema-only display.
 *
 * Content types detected:
 *   code     — source code (signatures only, body deferred)
 *   log      — application logs (errors only, collapse repeats)
 *   json     — structured data (keys/schema only)
 *   config   — configuration files (key names only)
 *   diff     — patches/diffs (file names + change counts)
 *   prose    — natural language (CCR smart truncation)
 */

import type { MemoryItem } from "../domain/schema";
import { guardXmlPayload } from "../infrastructure/guardrail";
import { truncateWords } from "../infrastructure/sanitize";
import { compressCodeWithAst } from "./code-compressor";

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

/** Minimum confidence before a non-prose type overrides the prose default. */
const MIN_NON_PROSE_CONFIDENCE = 0.35;

const SNIFFERS: ContentSniffer[] = [
  {
    type: "diff",
    test: (text) => {
      // Git diff or unified diff pattern — needs actual diff markers
      const lines = text.split("\n");
      let diffMarkers = 0;
      let nonDiffLines = 0;
      let contextLines = 0;
      for (const line of lines.slice(0, 25)) {
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        if (/^diff --git|^@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@|^---\s|^\+\+\+\s/.test(line)) {
          diffMarkers += 3; // strong signal
          // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        } else if (/^[+-]/.test(line) && !/^\+\+\+/.test(line) && !/^---/.test(line)) {
          diffMarkers++;
          // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        } else if (/^ /.test(line)) {
          contextLines++; // unified diff context line — normal, not a penalty
        } else if (line.trim().length > 0) {
          nonDiffLines++;
        }
      }
      // Penalize only if truly non-diff lines dominate (not context lines)
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

      // Strong signals — code block markers or structural density
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      if (/^```[\s\S]*```$/m.test(text)) {
        score += 0.5;
      }
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      if (/^\s*```(?:ts|tsx|js|jsx|typescript|javascript)\b/im.test(text)) {
        score += 0.7;
      }

      // Count code structural patterns vs total lines
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

        // Strong structural signals
        if (
          // biome-ignore lint/performance/useTopLevelRegex: warning suppression
          /^(pub\s+)?(async\s+)?(function|class|def\s|fn\s|interface|enum|type|struct|impl|module|namespace)\s+\w/.test(
            t,
          )
        ) {
          structuralLines += 3;
        }
        // Imports/exports
        else if (
          // biome-ignore lint/performance/useTopLevelRegex: warning suppression
          /^(import\s+|export\s+(default\s+)?(async\s+)?(function|class|const|let|var|interface|type|enum))/.test(
            t,
          )
        ) {
          structuralLines += 3;
        }
        // Variable declarations with type annotations
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        else if (/\b(const|let|var)\s+\w+\s*(:\s*\w+)?\s*=/.test(t)) {
          structuralLines += 1.5;
        }
        // Object literal/config lines inside snippets
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        else if (/^[A-Za-z_$][\w$-]*\s*:\s*[^,]+,?$/.test(t)) {
          structuralLines += 0.75;
        }
        // Control flow and error-handling snippets
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        else if (/^(if|else if|for|while|switch|try|catch|finally)\b/.test(t)) {
          structuralLines += 1;
        }
        // Braces on their own line (code block markers)
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        else if (/^[{};]\s*$/.test(t) || /[{};]\s*$/.test(t)) {
          structuralLines += 1;
        }
        // Return/throw/await patterns
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        else if (/^\s*(return|throw|await|yield)\s/.test(t)) {
          structuralLines += 1;
        }
        // Indentation (code blocks)
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        else if (/^( {2,4}|\t)\S/.test(t)) {
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

      // Structural density: what % of non-empty lines look structural?
      if (totalNonEmptyLines > 0) {
        const density = structuralLines / totalNonEmptyLines;
        if (density >= 1.5) {
          score += 0.7; // very code-like (dense structural patterns)
        } else if (density >= 0.8) {
          score += 0.5; // code-like (mostly structural lines)
        } else if (density >= 0.4) {
          score += 0.2; // weakly code-like (mixed prose + code)
        }
        // Below 0.4: probably prose mentioning code terms — no score
      }

      if (snippetSignals >= 6) {
        score += 0.45;
      } else if (snippetSignals >= 3) {
        score += 0.25;
      }

      // Penalty: if text has natural language sentence patterns, it's less likely code
      const sentenceCount = (text.match(/[.!?]\s+[A-Z]/g) ?? []).length;
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      const normalizedSentences = sentenceCount / Math.max(1, text.split(/\s+/).length / 15);
      if (normalizedSentences > 0.15) {
        score -= 0.2; // many sentences = prose, not code
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
      let keywordOnlyLines = 0; // keywords WITHOUT timestamps — weaker signal

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
          // Timestamp + log level = definitive log line
          // biome-ignore lint/performance/useTopLevelRegex: warning suppression
          if (/\b(ERROR|WARN|INFO|DEBUG|TRACE|FATAL|CRITICAL)\b/i.test(trimmed)) {
            timestampLines++; // extra weight for canonical log format
          }
          // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        } else if (/\b(ERROR|WARN|INFO|DEBUG|TRACE|FATAL|CRITICAL)\b/i.test(trimmed)) {
          // Keywords without timestamps — weak signal, could be prose mention
          keywordOnlyLines++;
        }

        // Stack trace lines
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        if (/^\s+at\s+\S+/.test(trimmed) && hasTimestamp) {
          timestampLines += 0.5;
        }
      }

      // Only count keyword-only lines if they have surrounding context
      // (e.g., multiple such lines suggest a log, single mention = prose)
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
          return 0.6; // looks like JSON but isn't valid
        }
      }
      return 0;
    },
  },
  {
    type: "config",
    test: (text) => {
      let score = 0;
      // Dockerfile
      if (
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        /^(FROM|RUN|COPY|ENV|EXPOSE|CMD|ENTRYPOINT|WORKDIR|ADD|VOLUME|USER|ARG|LABEL)\s/m.test(text)
      ) {
        score += 0.8;
      }
      // TOML/INI
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      if (/^\[.*\]\s*$/.test(text.split("\n")[0] ?? "")) {
        score += 0.5;
      }
      // .env
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      if (/^[A-Z_][A-Z0-9_]*=/.test(text.split("\n")[0] ?? "")) {
        score += 0.4;
      }
      // YAML
      if (
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        /^[\w-]+:\s/.test(text.split("\n")[0] ?? "") &&
        !text.includes("{") &&
        !text.includes(";")
      ) {
        score += 0.3;
      }
      // key=value pairs dominate
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

function snifferScore(type: MemoryContentType, text: string): number {
  return SNIFFERS.find((sniffer) => sniffer.type === type)?.test(text) ?? 0;
}

/**
 * Prose sniffer — detects natural language patterns.
 * Prose is characterized by: sentence structure, article/conjunction density,
 * conversational markers, and lack of strong structural patterns.
 */
function scoreProse(text: string): number {
  let score = 0.3; // base score for default

  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 20) {
    return 0.3; // too short to tell
  }

  // Sentence detection: punctuation followed by capital letter
  const sentences = text.match(/[.!?]\s+[A-Z]/g) ?? [];
  const sentenceDensity = sentences.length / Math.max(1, words.length / 12);
  if (sentenceDensity > 0.2) {
    score += 0.3; // clear sentence structure
  } else if (sentenceDensity > 0.08) {
    score += 0.15;
  }

  // Common prose markers: articles, conjunctions, prepositions
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

  // Bullet points or numbered lists (common in prose documents)
  const bulletLines = text.match(/^(\s*[-*+•]|\s*\d+[.)]\s)/gm) ?? [];
  if (bulletLines.length >= 3) {
    score += 0.1;
  }

  // Headers / markdown headings
  const headers = text.match(/^#{1,4}\s+\w+/gm) ?? [];
  if (headers.length >= 2) {
    score += 0.15;
  }

  // Penalty: if the text has too many non-prose patterns
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
 * Returns the best-matching type with confidence score.
 *
 * Non-prose types must exceed MIN_NON_PROSE_CONFIDENCE (0.40) to override
 * the prose default. This prevents single-keyword false positives where
 * a prose bug report mentioning "ERROR" gets misdetected as a log.
 */
export function detectContentType(text: string): ContentMatch {
  // Compute prose score first as baseline
  const proseScore = scoreProse(text);
  let bestMatch: ContentMatch = { type: "prose", confidence: proseScore };

  for (const sniffer of SNIFFERS) {
    const confidence = sniffer.test(text);
    // Non-prose types need minimum confidence AND must beat the prose baseline
    if (confidence > bestMatch.confidence && confidence >= MIN_NON_PROSE_CONFIDENCE) {
      bestMatch = { type: sniffer.type, confidence };
    }
  }

  return bestMatch;
}

function detectContentTypeForItem(item: MemoryItem): ContentMatch {
  const match = detectContentType(item.text);
  if (match.type !== "prose") {
    return match;
  }

  if (item.kind === "code_context") {
    const codeConfidence = snifferScore("code", item.text);
    const hasStrongCodeMarker =
      codeConfidence >= MIN_NON_PROSE_CONFIDENCE - 0.1 ||
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      /^\s*```(?:ts|tsx|js|jsx|typescript|javascript)\b/im.test(item.text) ||
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      /\b(const|let|var)\s+\w+\s*=|\basync\s+function\b|\bnew\s+[A-Z]\w*\s*\(/.test(item.text);

    if (hasStrongCodeMarker && codeConfidence >= 0.2) {
      return { type: "code", confidence: Math.max(codeConfidence, MIN_NON_PROSE_CONFIDENCE) };
    }
  }

  return match;
}

// ─── Per-type renderers ─────────────────────────────────────────────

/**
 * Render code content: show function/class signatures, defer body.
 *
 * Token saving: 40-80% depending on comment density and body length.
 */
function codePathFromMetadata(item: MemoryItem): string | undefined {
  try {
    const metadata = JSON.parse(item.metadata_json || "{}") as Record<string, unknown>;
    for (const key of ["path", "filePath", "sourcePath", "filename"]) {
      const value = metadata[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
  } catch {
    // Ignore malformed metadata and fall back to content sniffing.
  }
  return undefined;
}

function renderCode(item: MemoryItem): RenderedContent {
  const text = item.text;
  const ast = compressCodeWithAst(text, { path: codePathFromMetadata(item) });
  if (ast) {
    return {
      display: guardXmlPayload(ast.display),
      contentType: "code",
      compressed: ast.compressed,
      displayTokens: ast.displayTokens,
    };
  }

  const lines = text.split("\n");
  const signatures: string[] = [];
  let skippedLines = 0;
  let totalLines = 0;

  // Extract structural lines: function/class/method signatures, imports, exports
  for (const line of lines) {
    totalLines++;
    const trimmed = line.trim();

    // Always keep: imports, exports, function/class/struct signatures
    if (
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      /^(import |export |from |require\()/.test(trimmed) ||
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      /^(pub )?(async )?(function |class |def |fn |struct |enum |interface |type |const |impl |module )/.test(
        trimmed,
      ) ||
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      /^(protected |private |public |static |abstract |final |override )/.test(trimmed) ||
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      /^\s*\* @/.test(trimmed) || // JSDoc annotations
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      /^\s*\/\//.test(trimmed) // Single-line comments (context)
    ) {
      signatures.push(trimmed);
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    } else if (/^[})]\s*$/.test(trimmed) || /^\)\s*:\s*\w/.test(trimmed)) {
      // Closing braces and return type annotations
      signatures.push(trimmed);
    } else {
      skippedLines++;
    }
  }

  // If we kept most lines anyway, just return trimmed
  if (skippedLines < totalLines * 0.3) {
    return {
      display: guardXmlPayload(text),
      contentType: "code",
      compressed: false,
      displayTokens: Math.ceil(text.length / 4),
    };
  }

  const display = [
    `// ${totalLines} lines, ${skippedLines} body lines compressed`,
    ...signatures.slice(0, 30), // cap at 30 signature lines
    skippedLines > 0
      ? `// ... ${skippedLines} implementation lines deferred (retrieve with memory_retrieve)`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    display: guardXmlPayload(display),
    contentType: "code",
    compressed: true,
    displayTokens: Math.ceil(display.length / 4),
  };
}

/**
 * Render log content: keep ERROR/FATAL/CRITICAL lines, collapse repeated patterns,
 * drop timestamps for non-error lines, normalize variable data before dedup.
 *
 * Token saving: 70-95% for routine logs, 50-70% for error-heavy logs.
 *
 * Architecture:
 *   1. Normalize variable data (timestamps, IDs, numbers) into placeholders
 *   2. Group lines by normalized pattern
 *   3. ERROR/FATAL: keep first N occurrences, show pattern summary
 *   4. WARN: keep all unique patterns, collapse repeats
 *   5. INFO: show unique patterns only, collapse repeats
 *   6. DEBUG/TRACE: count only, skip content
 */
function renderLog(text: string): RenderedContent {
  const lines = text.split("\n");

  // ─── Step 1: Classify & normalize each line ─────────────────────────
  interface NormalizedLine {
    original: string;
    normalized: string; // variable data replaced with placeholders
    pattern: string; // simplified pattern for grouping
    level: "error" | "warn" | "info" | "debug" | "other";
  }

  const normalized: NormalizedLine[] = [];

  // Regex patterns for variable data to normalize
  const VAR_PATTERNS: [RegExp, string][] = [
    // ISO timestamps: 2026-06-05T14:32:11.234Z
    [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<TS>"],
    // Syslog timestamps: Jun  5 14:32:11
    [/\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}/g, "<TS>"],
    // Bracket timestamps: [2026-06-05]
    [/\[\d{4}-\d{2}-\d{2}\]/g, "[<DATE>]"],
    // Hex hashes: a1b2c3d4e5f6...
    [/\b[a-f0-9]{8,64}\b/gi, "<HASH>"],
    // UUIDs
    [/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi, "<UUID>"],
    // requestId=xxx, sessionId=xxx etc (alphanumeric IDs)
    [/\b(requestId|sessionId|userId|traceId|spanId|correlationId)=[\w-]+/gi, "$1=<ID>"],
    // IP addresses
    [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<IP>"],
    // Numbers (after preserving other patterns): latency=234ms → latency=<N>ms
    [/\b\d+(?:\.\d+)?(?:ms|s|min|MB|GB|KB|%|bps)?\b/g, "<N>"],
    // Port numbers after colon in service names
    [/(\w+):\d{4,5}\b/g, "$1:<PORT>"],
  ];

  function normalizeLine(line: string): string {
    let result = line;
    for (const [pattern, replacement] of VAR_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }

  // biome-ignore lint/nursery/noShadow: warning suppression
  function extractPattern(normalized: string): string {
    // Further simplify: strip whitespace variations, collapse repeated placeholders
    return normalized
      .replace(/\s+/g, " ")
      .replace(/(<N>\s*)+/g, "<N...>")
      .replace(/(<ID>\s*)+/g, "<ID...>")
      .trim();
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let level: NormalizedLine["level"] = "other";
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    if (/\b(ERROR|FATAL|CRITICAL|FAIL|PANIC)\b/i.test(trimmed)) {
      level = "error";
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    } else if (/\bWARN(ING)?\b/i.test(trimmed)) {
      level = "warn";
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    } else if (/\bINFO\b/i.test(trimmed)) {
      level = "info";
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    } else if (/\b(DEBUG|TRACE)\b/i.test(trimmed)) {
      level = "debug";
    }

    const norm = normalizeLine(trimmed);
    normalized.push({
      original: trimmed,
      normalized: norm,
      pattern: extractPattern(norm),
      level,
    });
  }

  const signature = renderShortErrorSignature(normalized);
  if (signature) {
    return signature;
  }

  // ─── Step 2: Group by pattern ───────────────────────────────────────
  interface PatternGroup {
    pattern: string;
    level: NormalizedLine["level"];
    examples: string[]; // first few original lines
    count: number;
  }

  const groups = new Map<string, PatternGroup>();

  for (const nl of normalized) {
    const key = `${nl.level}:${nl.pattern}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      if (existing.examples.length < 3) {
        existing.examples.push(nl.original);
      }
    } else {
      groups.set(key, {
        pattern: nl.pattern,
        level: nl.level,
        examples: [nl.original],
        count: 1,
      });
    }
  }

  // ─── Step 3: Render based on level ──────────────────────────────────
  const output: string[] = [];
  let totalSkipped = 0;

  // Sort groups: errors first, then warnings, then info, then other
  const sortedGroups = [...groups.values()].sort((a, b) => {
    const order = { error: 0, warn: 1, info: 2, other: 3, debug: 4 };
    return (order[a.level] ?? 5) - (order[b.level] ?? 5);
  });

  // Track how many error/warn lines were collapsed
  let collapsedErrors = 0;
  let collapsedWarns = 0;
  let collapsedInfo = 0;

  for (const group of sortedGroups) {
    switch (group.level) {
      case "error":
      case "warn": {
        const emoji = group.level === "error" ? "❌" : "⚠️";
        // Show first 3 examples
        for (const ex of group.examples) {
          // Strip timestamp from display
          const cleaned = ex.replace(
            // biome-ignore lint/performance/useTopLevelRegex: warning suppression
            /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\s*)/,
            "",
          );
          output.push(`${emoji} ${cleaned}`);
        }
        if (group.count > 3) {
          const extra = group.count - 3;
          if (group.level === "error") {
            collapsedErrors += extra;
          } else {
            collapsedWarns += extra;
          }
          output.push(`  └─ +${extra} similar ${group.level} occurrences`);
        }
        break;
      }
      case "info": {
        if (group.count === 1) {
          // Single occurrence: show it (truncated)
          const cleaned = group.examples[0]?.replace(
            // biome-ignore lint/performance/useTopLevelRegex: warning suppression
            /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\s*)/,
            "",
          );
          output.push(`ℹ️  ${truncateWords(cleaned, 25)}`);
        } else {
          // Repeated: show representative only
          collapsedInfo += group.count - 1;
          const cleaned = group.examples[0]?.replace(
            // biome-ignore lint/performance/useTopLevelRegex: warning suppression
            /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\s*)/,
            "",
          );
          output.push(`ℹ️  ${truncateWords(cleaned, 25)} [×${group.count}]`);
        }
        break;
      }
      case "debug": {
        totalSkipped += group.count;
        break;
      }
      case "other": {
        // Non-level lines (stack traces, system metrics): keep first 3
        for (let i = 0; i < Math.min(group.count, 3); i++) {
          output.push(truncateWords(group.examples[i] ?? group.pattern, 20));
        }
        if (group.count > 3) {
          totalSkipped += group.count - 3;
        }
        break;
      }
    }
  }

  // ─── Summary footer ─────────────────────────────────────────────────
  const summaryParts: string[] = [];
  if (collapsedErrors > 0) {
    summaryParts.push(`${collapsedErrors} similar errors collapsed`);
  }
  if (collapsedWarns > 0) {
    summaryParts.push(`${collapsedWarns} similar warnings collapsed`);
  }
  if (collapsedInfo > 0) {
    summaryParts.push(`${collapsedInfo} repeated INFO collapsed`);
  }
  if (totalSkipped > 0) {
    summaryParts.push(`${totalSkipped} DEBUG/TRACE/other lines skipped`);
  }

  if (summaryParts.length > 0) {
    output.push(
      `\n── Compression summary: ${summaryParts.join(", ")} — ${normalized.length} total lines`,
    );
  }

  const display = output.join("\n");
  return {
    display: guardXmlPayload(display),
    contentType: "log",
    compressed: collapsedErrors + collapsedWarns + collapsedInfo + totalSkipped > 0,
    displayTokens: Math.ceil(display.length / 4),
  };
}

function renderShortErrorSignature(
  normalized: Array<{
    original: string;
    pattern: string;
    level: "error" | "warn" | "info" | "debug" | "other";
  }>,
): RenderedContent | null {
  if (normalized.length === 0 || normalized.length > 80) {
    return null;
  }

  const errors = normalized.filter((line) => line.level === "error");
  if (errors.length < 2) {
    return null;
  }

  const requestIds = new Set<string>();
  const groups = new Map<string, { service: string; signature: string; count: number }>();

  for (const line of normalized) {
    for (const match of line.original.matchAll(/\brequestId=([\w-]+)/g)) {
      const rid = match[1];
      if (rid) {
        requestIds.add(rid);
      }
    }

    if (line.level !== "error") {
      continue;
    }
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    const service = line.original.match(/\]\s+([\w.-]+)\s+/)?.[1] ?? "unknown-service";
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    const errorName = line.original.match(/\b([A-Z][A-Za-z0-9_]*(?:Error|Exception))\b/)?.[1];
    const message =
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      line.original.match(/\b(?:Error|Exception):\s*([\s\S]+)$/)?.[1] ??
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      line.original.match(/\b(ERROR|FATAL|CRITICAL)\]\s+[\w.-]+\s+(.+)$/i)?.[2] ??
      line.pattern;
    const compactMessage = message
      .replace(/\b(requestId|sessionId|userId|traceId|spanId|correlationId)=[\w-]+/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 72);
    const signature = `${errorName ?? "error"}: ${compactMessage}`;
    const key = `${service}:${signature}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
    } else {
      groups.set(key, { service, signature, count: 1 });
    }
  }

  if (groups.size === 0) {
    return null;
  }

  const display = [
    `log error signatures: ${errors.length} error lines across ${groups.size} patterns`,
    ...[...groups.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)
      .map((group) => `- ${group.service}: ${group.signature} x${group.count}`),
    requestIds.size > 0 ? `requestIds: ${[...requestIds].slice(0, 6).join(", ")}` : "",
    `summary: ${normalized.length} lines compacted; retrieve full log with memory_retrieve`,
  ]
    .filter(Boolean)
    .join("\n");

  if (display.length >= normalized.map((line) => line.original).join("\n").length) {
    return null;
  }

  return {
    display: guardXmlPayload(display),
    contentType: "log",
    compressed: true,
    displayTokens: Math.ceil(display.length / 4),
  };
}

/**
 * Render JSON content: show top-level keys and data types, not values.
 * For arrays, show length and first element type.
 *
 * Token saving: 60-90% for large JSON payloads.
 */
function renderJson(text: string): RenderedContent {
  try {
    const parsed = JSON.parse(text);
    const schema = describeJsonSchema(parsed);
    return {
      display: guardXmlPayload(schema),
      contentType: "json",
      compressed: text.length > schema.length * 3,
      displayTokens: Math.ceil(schema.length / 4),
    };
  } catch {
    // Invalid JSON — treat as prose
    return {
      display: guardXmlPayload(text),
      contentType: "json",
      compressed: false,
      displayTokens: Math.ceil(text.length / 4),
    };
  }
}

function describeJsonSchema(obj: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);

  if (obj === null) {
    return `${pad}null`;
  }
  if (typeof obj === "string") {
    return `${pad}string (${obj.length} chars)`;
  }
  if (typeof obj === "number") {
    return `${pad}number`;
  }
  if (typeof obj === "boolean") {
    return `${pad}boolean`;
  }

  if (Array.isArray(obj)) {
    const sample = obj.length > 0 ? describeJsonSchema(obj[0], indent + 1).trimStart() : "unknown";
    return `${pad}array[${obj.length}] of\n${sample}`;
  }

  if (typeof obj === "object") {
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      return `${pad}{}`;
    }
    if (keys.length > 20) {
      return `${pad}object with ${keys.length} keys: ${keys.slice(0, 20).join(", ")}, ...`;
    }
    const lines = [`${pad}object {`];
    for (const key of keys.slice(0, 20)) {
      const val = (obj as Record<string, unknown>)[key];
      lines.push(`${pad}  ${key}: ${describeJsonSchema(val, 0).trimStart()}`);
    }
    lines.push(`${pad}}`);
    return lines.join("\n");
  }

  return `${pad}${typeof obj}`;
}

/**
 * Render config content: show key names only, not values.
 *
 * Token saving: 40-70%.
 */
function renderConfig(text: string): RenderedContent {
  const lines = text.split("\n").filter(Boolean);
  const keys: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments — but count them
    if (trimmed.startsWith("#") || trimmed.startsWith("//")) {
      continue;
    }

    // Dockerfile instructions: keep instruction name, drop args
    const dockerMatch = trimmed.match(
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      /^(FROM|RUN|COPY|ENV|EXPOSE|CMD|ENTRYPOINT|WORKDIR|ADD|VOLUME|USER|ARG|LABEL)\s/,
    );
    if (dockerMatch) {
      const key = dockerMatch[1];
      if (key) {
        keys.push(key);
      }
      continue;
    }

    // key=value or key: value — keep key name only
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    const kvMatch = trimmed.match(/^([A-Za-z_][\w.-]*)\s*[=:]\s*/);
    if (kvMatch) {
      const key = kvMatch[1];
      if (key) {
        keys.push(key);
      }
      continue;
    }

    // Section headers [section]
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]/);
    if (sectionMatch) {
      keys.push(`[${sectionMatch[1]}]`);
      continue;
    }

    // Fallback: truncate the line
    keys.push(truncateWords(trimmed, 5));
  }

  if (keys.length === 0) {
    return {
      display: guardXmlPayload(text),
      contentType: "config",
      compressed: false,
      displayTokens: Math.ceil(text.length / 4),
    };
  }

  const display = keys.join("\n");
  return {
    display: guardXmlPayload(display),
    contentType: "config",
    compressed: text.length > display.length * 1.5,
    displayTokens: Math.ceil(display.length / 4),
  };
}

/**
 * Render diff content: show file names + change stats, not full diff.
 *
 * Token saving: 75-95% for large diffs.
 */
function renderDiff(text: string): RenderedContent {
  const lines = text.split("\n");
  const files: Array<{ path: string; additions: number; deletions: number }> = [];
  let currentFile = "";
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    // Detect file headers
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    const fileMatch = line.match(/^diff --git a\/(.*) b\/(.*)/);
    if (fileMatch) {
      if (currentFile) {
        files.push({ path: currentFile, additions, deletions });
      }
      currentFile = fileMatch[2] ?? fileMatch[1] ?? "";
      additions = 0;
      deletions = 0;
      continue;
    }

    // Alternative: --- a/file +++ b/file
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    const altMatch = line.match(/^\+\+\+ b\/(.*)/);
    if (altMatch && !currentFile) {
      currentFile = altMatch[1] ?? "";
      continue;
    }

    // Count changes
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }

  // Don't forget last file
  if (currentFile) {
    files.push({ path: currentFile, additions, deletions });
  }

  if (files.length === 0) {
    return {
      display: guardXmlPayload(text),
      contentType: "diff",
      compressed: false,
      displayTokens: Math.ceil(text.length / 4),
    };
  }

  const totalAdd = files.reduce((s, f) => s + f.additions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);

  const summary = [
    `diff: ${files.length} files changed, +${totalAdd} -${totalDel}`,
    ...files.map((f) => `  ${f.path}: +${f.additions} -${f.deletions}`),
  ].join("\n");

  return {
    display: guardXmlPayload(summary),
    contentType: "diff",
    compressed: true,
    displayTokens: Math.ceil(summary.length / 4),
  };
}

// ─── Main render API ─────────────────────────────────────────────────

/**
 * Render memory content for prompt injection, automatically detecting
 * content type and applying the best compression strategy.
 *
 * This is the single entry point for content-type-aware rendering.
 * For prose content, delegates to the caller's CCR compression.
 */
export function renderContentByType(
  item: MemoryItem,
  opts: {
    /** Force a specific content type (skip detection) */
    forceType?: MemoryContentType;
    /** Max tokens for the display output */
    tokenBudget?: number;
  } = {},
): RenderedContent {
  const match = opts.forceType
    ? { type: opts.forceType, confidence: 1.0 }
    : detectContentTypeForItem(item);

  let result: RenderedContent;

  switch (match.type) {
    case "code":
      result = renderCode(item);
      break;
    case "log":
      result = renderLog(item.text);
      break;
    case "json":
      result = renderJson(item.text);
      break;
    case "config":
      result = renderConfig(item.text);
      break;
    case "diff":
      result = renderDiff(item.text);
      break;
    default:
      // Prose: no content-type-specific compression
      // CCR handles prose with sentence-based truncation
      result = {
        display: guardXmlPayload(item.text),
        contentType: "prose",
        compressed: false,
        displayTokens: Math.ceil(item.text.length / 4),
      };
      break;
  }

  return result;
}

// ─── Utility ─────────────────────────────────────────────────────────

/**
 * Get a human-readable label for a content type.
 */
export function contentTypeLabel(type: MemoryContentType): string {
  const labels: Record<MemoryContentType, string> = {
    code: "source code",
    log: "application log",
    json: "structured data",
    config: "configuration",
    diff: "code diff",
    prose: "natural language",
  };
  return labels[type];
}
