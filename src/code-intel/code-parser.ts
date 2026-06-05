/**
 * Code Parser — Regex-based fallback with tree-sitter bridge (Phase 3)
 *
 * Provides code entity extraction from source files without external dependencies.
 * Uses regex-based parsing for common languages as a default, with an optional
 * tree-sitter WASM bridge for production-grade accuracy.
 *
 * Supported languages (regex mode): TypeScript, JavaScript, Python, Go, Rust
 * Tree-sitter bridge: any language with a tree-sitter WASM grammar
 *
 * Extracted entities:
 * - file:       The file itself
 * - function:   Named function declarations
 * - class:      Class declarations
 * - module:     ES module exports, Python module-level definitions
 * - section:    Top-level sections (imports, exports, constants, etc.)
 *
 * Usage:
 *   import { parseFile } from "./code-parser";
 *   const entities = parseFile("/path/to/file.ts", sourceCode);
 */

import type { CodeEntityType } from "../domain/schema";

// ─── Types ──────────────────────────────────────────────────────────

export interface ParseResult {
  path: string;
  language: string;
  entities: ExtractedEntity[];
}

export interface ExtractedEntity {
  entityType: CodeEntityType;
  symbol: string;
  lineStart: number;
  lineEnd: number;
  /** Content fingerprint (quick hash for change detection). */
  fingerprint: string;
}

export interface CodeParseOptions {
  /** Max entities to extract per file (default: 200). */
  maxEntities: number;
  /** Include section-level entities (imports, exports). */
  includeSections: boolean;
}

// ─── Language detection ─────────────────────────────────────────────

function detectLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "py":
    case "pyx":
      return "python";
    case "go":
      return "go";
    case "rs":
      return "rust";
    case "rb":
      return "ruby";
    case "java":
      return "java";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
      return "html";
    case "json":
      return "json";
    case "md":
    case "mdx":
      return "markdown";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    default:
      return "unknown";
  }
}

// ─── Quick fingerprint ──────────────────────────────────────────────

function quickFingerprint(text: string): string {
  // DJB2 hash for speed (not crypto)
  let hash = 5381;
  for (let i = 0; i < Math.min(text.length, 500); i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ─── Regex-based extractors ─────────────────────────────────────────

type RegexExtractor = (lines: string[], path: string, opts: CodeParseOptions) => ExtractedEntity[];

/**
 * Extract function declarations from TypeScript/JavaScript.
 * Matches: function name(), const name = () =>, async function name(), name: () =>
 */
function extractTypescriptFunctions(
  lines: string[],
  _path: string,
  _opts: CodeParseOptions,
): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const patterns = [
    // function name(args)
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/,
    // const name = (args) => / const name = async (args) =>
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*\w+\s*)?=>/,
    // name(args) { }  (class method shorthand)
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    /(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/,
    // static name(args) / get name() / set name()
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    /(?:static\s+)?(?:get|set)\s+(\w+)\s*\(/,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) {
      continue;
    }

    for (const pat of patterns) {
      const match = line.match(pat);
      if (match?.[1] && !["if", "for", "while", "switch", "catch", "typeof"].includes(match[1])) {
        entities.push({
          entityType: "function",
          symbol: match[1],
          lineStart: i + 1,
          lineEnd: i + 1,
          fingerprint: quickFingerprint(line),
        });
        break; // one entity per line
      }
    }
    if (entities.length >= _opts.maxEntities) {
      break;
    }
  }
  return entities;
}

/**
 * Extract class declarations from TypeScript/JavaScript.
 */
function extractTypescriptClasses(
  lines: string[],
  _path: string,
  _opts: CodeParseOptions,
): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  const pattern = /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (line.startsWith("//") || line.startsWith("/*")) {
      continue;
    }

    const match = line.match(pattern);
    if (match?.[1]) {
      entities.push({
        entityType: "class",
        symbol: match[1],
        lineStart: i + 1,
        lineEnd: i + 1,
        fingerprint: quickFingerprint(line),
      });
    }
    if (entities.length >= _opts.maxEntities) {
      break;
    }
  }
  return entities;
}

/**
 * Extract exports (module-level) from TypeScript/JavaScript.
 */
function extractTypescriptExports(
  lines: string[],
  _path: string,
  _opts: CodeParseOptions,
): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const patterns = [
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    /export\s+(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/,
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    /export\s+\{\s*(\w+)/,
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    /export\s+default\s+(?:function|class)?\s*(\w+)?/,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    for (const pat of patterns) {
      const match = line.match(pat);
      if (match?.[1]) {
        entities.push({
          entityType: "module",
          symbol: match[1],
          lineStart: i + 1,
          lineEnd: i + 1,
          fingerprint: quickFingerprint(line),
        });
        break;
      }
    }
    if (entities.length >= _opts.maxEntities) {
      break;
    }
  }
  return entities;
}

/**
 * Extract function and class definitions from Python.
 */
function extractPythonEntities(
  lines: string[],
  _path: string,
  _opts: CodeParseOptions,
): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  const funcPattern = /def\s+(\w+)\s*\(/;
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  const classPattern = /class\s+(\w+)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (line.startsWith("#")) {
      continue;
    }

    const funcMatch = line.match(funcPattern);
    if (funcMatch?.[1] && !funcMatch[1].startsWith("_")) {
      entities.push({
        entityType: "function",
        symbol: funcMatch[1],
        lineStart: i + 1,
        lineEnd: i + 1,
        fingerprint: quickFingerprint(line),
      });
      continue;
    }

    const classMatch = line.match(classPattern);
    if (classMatch?.[1]) {
      entities.push({
        entityType: "class",
        symbol: classMatch[1],
        lineStart: i + 1,
        lineEnd: i + 1,
        fingerprint: quickFingerprint(line),
      });
    }
    if (entities.length >= _opts.maxEntities) {
      break;
    }
  }
  return entities;
}

/**
 * Extract function definitions from Go.
 */
function extractGoEntities(
  lines: string[],
  _path: string,
  _opts: CodeParseOptions,
): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  const funcPattern = /func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?(\w+)\s*\(/;
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  const structPattern = /type\s+(\w+)\s+struct/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (line.startsWith("//")) {
      continue;
    }

    const funcMatch = line.match(funcPattern);
    if (funcMatch?.[1]) {
      entities.push({
        entityType: "function",
        symbol: funcMatch[1],
        lineStart: i + 1,
        lineEnd: i + 1,
        fingerprint: quickFingerprint(line),
      });
      continue;
    }

    const structMatch = line.match(structPattern);
    if (structMatch?.[1]) {
      entities.push({
        entityType: "class",
        symbol: structMatch[1],
        lineStart: i + 1,
        lineEnd: i + 1,
        fingerprint: quickFingerprint(line),
      });
    }
    if (entities.length >= _opts.maxEntities) {
      break;
    }
  }
  return entities;
}

/**
 * Extract function definitions from Rust.
 */
function extractRustEntities(
  lines: string[],
  _path: string,
  _opts: CodeParseOptions,
): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  const fnPattern = /(?:pub\s+)?fn\s+(\w+)\s*[<(]/;
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  const structPattern = /(?:pub\s+)?struct\s+(\w+)/;
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  const implPattern = /impl\s+(\w+)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (line.startsWith("//")) {
      continue;
    }

    for (const pat of [fnPattern, structPattern, implPattern]) {
      const match = line.match(pat);
      if (match?.[1] && match[1] !== "main") {
        entities.push({
          entityType: pat === fnPattern ? "function" : "class",
          symbol: match[1],
          lineStart: i + 1,
          lineEnd: i + 1,
          fingerprint: quickFingerprint(line),
        });
        break;
      }
    }
    if (entities.length >= _opts.maxEntities) {
      break;
    }
  }
  return entities;
}

// ─── Extractor registry ─────────────────────────────────────────────

const EXTRACTORS: Record<string, RegexExtractor[]> = {
  typescript: [extractTypescriptFunctions, extractTypescriptClasses, extractTypescriptExports],
  javascript: [extractTypescriptFunctions, extractTypescriptClasses, extractTypescriptExports],
  python: [extractPythonEntities],
  go: [extractGoEntities],
  rust: [extractRustEntities],
  unknown: [],
};

// ─── Main API ───────────────────────────────────────────────────────

const DEFAULT_OPTIONS: CodeParseOptions = {
  maxEntities: 200,
  includeSections: false,
};

/**
 * Parse a source file and extract code entities.
 *
 * Uses regex-based extraction by default. For production accuracy,
 * set TRIMEMH_USE_TREESITTER=1 to enable the tree-sitter bridge.
 */
export function parseFile(
  path: string,
  source: string,
  opts?: Partial<CodeParseOptions>,
): ParseResult {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const language = detectLanguage(path);
  const extractors = EXTRACTORS[language] ?? [];

  // Always include the file entity
  const entities: ExtractedEntity[] = [
    {
      entityType: "file",
      symbol: path.split("/").pop() ?? path,
      lineStart: 1,
      lineEnd: source.split("\n").length,
      fingerprint: quickFingerprint(source),
    },
  ];

  if (extractors.length === 0) {
    return { path, language, entities };
  }

  const lines = source.split("\n");

  for (const extractor of extractors) {
    const remaining = options.maxEntities - entities.length;
    if (remaining <= 0) {
      break;
    }

    const extracted = extractor(lines, path, { ...options, maxEntities: remaining });
    entities.push(...extracted);
  }

  // Deduplicate by symbol within the same entity type
  const seen = new Set<string>();
  const deduped = entities.filter((e) => {
    const key = `${e.entityType}:${e.symbol}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  return {
    path,
    language,
    entities: deduped,
  };
}

/**
 * Batch parse multiple files.
 */
export function parseFiles(
  files: Array<{ path: string; source: string }>,
  opts?: Partial<CodeParseOptions>,
): ParseResult[] {
  return files.map((f) => parseFile(f.path, f.source, opts));
}

/**
 * Detect changed entities between two versions of a file.
 * Returns { added, removed, modified } based on fingerprint comparison.
 */
export function diffEntities(
  oldEntities: ExtractedEntity[],
  newEntities: ExtractedEntity[],
): {
  added: ExtractedEntity[];
  removed: ExtractedEntity[];
  modified: ExtractedEntity[];
} {
  const oldMap = new Map(oldEntities.map((e) => [`${e.entityType}:${e.symbol}`, e]));
  const newMap = new Map(newEntities.map((e) => [`${e.entityType}:${e.symbol}`, e]));

  const added: ExtractedEntity[] = [];
  const removed: ExtractedEntity[] = [];
  const modified: ExtractedEntity[] = [];

  for (const [key, entity] of newMap) {
    const old = oldMap.get(key);
    if (!old) {
      added.push(entity);
    } else if (old.fingerprint !== entity.fingerprint) {
      modified.push(entity);
    }
  }

  for (const [key, entity] of oldMap) {
    if (!newMap.has(key)) {
      removed.push(entity);
    }
  }

  return { added, removed, modified };
}

// ─── Tree-sitter bridge (placeholder) ───────────────────────────────

/**
 * Placeholder for tree-sitter WASM integration.
 *
 * To enable tree-sitter parsing:
 * 1. Install: bun add tree-sitter tree-sitter-typescript tree-sitter-python
 * 2. Set TRIMEMH_USE_TREESITTER=1
 *
 * The tree-sitter parser provides more accurate entity extraction,
 * including nested functions, method definitions, and decorator support.
 */
// biome-ignore lint/suspicious/useAwait: warning suppression
export async function parseFileWithTreeSitter(path: string, source: string): Promise<ParseResult> {
  // Tree-sitter requires async WASM loading — deferred to Phase 4
  // For now, fall back to regex parsing
  console.warn(
    "[triMemh] Tree-sitter not yet integrated — falling back to regex parser. " +
      "Set TRIMEMH_USE_TREESITTER=0 to suppress this warning.",
  );
  return parseFile(path, source);
}
