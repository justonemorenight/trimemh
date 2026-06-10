/**
 * Content renderers — per-type rendering strategies for prompt injection.
 *
 * Each renderer applies type-specific compression:
 *   code     — function/class signatures, defer body
 *   log      — error/warn lines, collapse repeats
 *   json     — keys + types, not values
 *   config   — key names only
 *   diff     — file names + change stats
 */

import { CONFIG } from "../config";
import type { MemoryItem } from "../domain/schema";
import { guardXmlPayload } from "../infrastructure/guardrail";
import { truncateWords } from "../infrastructure/sanitize";
import { compressCodeWithAst } from "./code-compressor";
import type { RenderedContent } from "./content-sniffers";

// ─── Code renderer ──────────────────────────────────────────────────

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

export function renderCode(item: MemoryItem): RenderedContent {
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

  for (const line of lines) {
    totalLines++;
    const trimmed = line.trim();

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
      /^\s*\* @/.test(trimmed) ||
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      /^\s*\/\//.test(trimmed)
    ) {
      signatures.push(trimmed);
    } else if (
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      /^[})]\s*$/.test(trimmed) ||
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      /^\)\s*:\s*\w/.test(trimmed)
    ) {
      signatures.push(trimmed);
    } else {
      skippedLines++;
    }
  }

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
    ...signatures.slice(0, CONFIG.contentRouter.codeSignatureLines),
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

// ─── Log renderer ───────────────────────────────────────────────────

interface NormalizedLine {
  original: string;
  normalized: string;
  pattern: string;
  level: "error" | "warn" | "info" | "debug" | "other";
}

interface PatternGroup {
  pattern: string;
  level: NormalizedLine["level"];
  examples: string[];
  count: number;
}

const VAR_PATTERNS: [RegExp, string][] = [
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<TS>"],
  [/\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}/g, "<TS>"],
  [/\[\d{4}-\d{2}-\d{2}\]/g, "[<DATE>]"],
  [/\b[a-f0-9]{8,64}\b/gi, "<HASH>"],
  [/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi, "<UUID>"],
  [/\b(requestId|sessionId|userId|traceId|spanId|correlationId)=[\w-]+/gi, "$1=<ID>"],
  [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<IP>"],
  [/\b\d+(?:\.\d+)?(?:ms|s|min|MB|GB|KB|%|bps)?\b/g, "<N>"],
  [/(\w+):\d{4,5}\b/g, "$1:<PORT>"],
];

function normalizeLine(line: string): string {
  let result = line;
  for (const [pattern, replacement] of VAR_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function extractPattern(normalized: string): string {
  return normalized
    .replace(/\s+/g, " ")
    .replace(/(<N>\s*)+/g, "<N...>")
    .replace(/(<ID>\s*)+/g, "<ID...>")
    .trim();
}

function renderShortErrorSignature(normalized: NormalizedLine[]): RenderedContent | null {
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

export function renderLog(text: string): RenderedContent {
  const lines = text.split("\n");
  const normalized: NormalizedLine[] = [];

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

  const output: string[] = [];
  let totalSkipped = 0;

  const sortedGroups = [...groups.values()].sort((a, b) => {
    const order = { error: 0, warn: 1, info: 2, other: 3, debug: 4 };
    return (order[a.level] ?? 5) - (order[b.level] ?? 5);
  });

  let collapsedErrors = 0;
  let collapsedWarns = 0;
  let collapsedInfo = 0;

  for (const group of sortedGroups) {
    switch (group.level) {
      case "error":
      case "warn": {
        const emoji = group.level === "error" ? "❌" : "⚠️";
        for (const ex of group.examples) {
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
          const cleaned = group.examples[0]?.replace(
            // biome-ignore lint/performance/useTopLevelRegex: warning suppression
            /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\s*)/,
            "",
          );
          output.push(`ℹ️  ${truncateWords(cleaned, 25)}`);
        } else {
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

// ─── JSON renderer ──────────────────────────────────────────────────

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

// ─── Smart JSON array compression (SmartCrusher-lite) ───────────────

const SMART_ARRAY_MIN_ITEMS = 3;
const SMART_JSON_ERROR_KEY_RE = /error|warning|exception|fail|alert/i;
const SMART_JSON_ERROR_VALUE_RE = /error|fail|critical|exception|timeout|denied|rejected/i;

/** Check if value is an array of homogeneous records */
function isArrayOfRecords(value: unknown): value is Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length < SMART_ARRAY_MIN_ITEMS) {
    return false;
  }
  if (!value.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
    return false;
  }
  const firstKeys = new Set(Object.keys(value[0] as Record<string, unknown>));
  const matchCount = value.slice(1).filter((item) => {
    const keys = Object.keys(item as Record<string, unknown>);
    const overlap = keys.filter((k) => firstKeys.has(k)).length;
    return overlap / Math.max(firstKeys.size, keys.length) >= 0.8;
  }).length;
  return matchCount / (value.length - 1) >= 0.8;
}

/** Extract fields whose value is the same across ALL rows */
function extractConstants(rows: Record<string, unknown>[]): Record<string, unknown> {
  const first = rows[0];
  if (!first) {
    return {};
  }
  const constants: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(first)) {
    if (typeof value === "object" && value !== null) {
      continue;
    }
    if (rows.every((row) => row[key] === value)) {
      constants[key] = value;
    }
  }
  return constants;
}

interface FieldDistribution {
  key: string;
  counts: Map<string, number>;
  uniqueRatio: number;
}

/** Extract value distributions for low-cardinality fields */
function extractDistributions(
  rows: Record<string, unknown>[],
  constantKeys: Set<string>,
): FieldDistribution[] {
  const distributions: FieldDistribution[] = [];
  const first = rows[0];
  if (!first) {
    return distributions;
  }

  for (const key of Object.keys(first)) {
    if (constantKeys.has(key)) {
      continue;
    }
    const counts = new Map<string, number>();
    let allPrimitive = true;

    for (const row of rows) {
      const value = row[key];
      if (typeof value === "object" && value !== null) {
        allPrimitive = false;
        break;
      }
      const strValue = String(value);
      counts.set(strValue, (counts.get(strValue) ?? 0) + 1);
    }

    if (!allPrimitive) {
      continue;
    }
    const uniqueRatio = counts.size / rows.length;
    if (uniqueRatio < 0.5 && counts.size > 1) {
      // low cardinality, not all same
      distributions.push({ key, counts, uniqueRatio });
    }
  }

  return distributions.sort((a, b) => a.uniqueRatio - b.uniqueRatio).slice(0, 5);
}

interface AnomalyRow {
  index: number;
  row: Record<string, unknown>;
  reason: string;
}

/** Extract rows with error/warning signals or outlier values */
function extractAnomalies(rows: Record<string, unknown>[]): AnomalyRow[] {
  const anomalies: AnomalyRow[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) {
      continue;
    }

    // 1. Rows where error-like field has non-empty value
    for (const [key, value] of Object.entries(row)) {
      if (
        SMART_JSON_ERROR_KEY_RE.test(key) &&
        value &&
        value !== "" &&
        value !== null &&
        value !== false &&
        value !== 0
      ) {
        anomalies.push({
          index: i,
          row,
          reason: `${key} is non-empty: ${String(value).slice(0, 80)}`,
        });
        break;
      }
    }

    // 2. Rows where status-like field indicates failure
    for (const key of ["status", "state", "result", "level"]) {
      const value = row[key];
      if (typeof value === "string" && SMART_JSON_ERROR_VALUE_RE.test(value)) {
        if (!anomalies.some((a) => a.index === i)) {
          anomalies.push({ index: i, row, reason: `${key}=${value}` });
        }
        break;
      }
    }
  }

  // 3. Numeric outliers (mean ± 2σ)
  const first = rows[0];
  if (first) {
    for (const key of Object.keys(first)) {
      const values = rows.map((r) => r[key]).filter((v): v is number => typeof v === "number");
      if (values.length < 5) {
        continue;
      }
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const stddev = Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
      if (stddev === 0) {
        continue;
      }
      const threshold = 2 * stddev;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row) {
          continue;
        }
        const value = row[key];
        if (typeof value === "number" && Math.abs(value - mean) > threshold) {
          if (!anomalies.some((a) => a.index === i)) {
            anomalies.push({
              index: i,
              row,
              reason: `${key}=${value} is outlier (mean=${mean.toFixed(1)}, σ=${stddev.toFixed(1)})`,
            });
          }
        }
      }
    }
  }

  return anomalies.slice(0, 5); // Cap at 5
}

/** Sample head and tail rows, excluding anomaly indices */
function sampleHeadTail(
  rows: Record<string, unknown>[],
  anomalyIndices: Set<number>,
  n = 1,
): {
  head: Array<{ index: number; row: Record<string, unknown> }>;
  tail: Array<{ index: number; row: Record<string, unknown> }>;
} {
  const head: Array<{ index: number; row: Record<string, unknown> }> = [];
  const tail: Array<{ index: number; row: Record<string, unknown> }> = [];

  for (let i = 0; i < rows.length && head.length < n; i++) {
    const row = rows[i];
    if (row && !anomalyIndices.has(i)) {
      head.push({ index: i, row });
    }
  }
  for (let i = rows.length - 1; i >= 0 && tail.length < n; i--) {
    const row = rows[i];
    if (row && !anomalyIndices.has(i) && !head.some((h) => h.index === i)) {
      tail.push({ index: i, row });
    }
  }

  return { head, tail: tail.reverse() };
}

function compactRowStr(row: Record<string, unknown>): string {
  const entries = Object.entries(row).map(([k, v]) => {
    if (typeof v === "string" && v.length > 60) {
      return `${k}: "${v.slice(0, 57)}..."`;
    }
    return `${k}: ${JSON.stringify(v)}`;
  });
  return `{ ${entries.join(", ")} }`;
}

function compactSchemaStr(rows: Record<string, unknown>[]): string {
  const first = rows[0];
  if (!first) {
    return "{}";
  }
  const fields = Object.entries(first).map(([k, v]) => {
    if (v === null) {
      return `${k}: null`;
    }
    if (Array.isArray(v)) {
      return `${k}: array`;
    }
    return `${k}: ${typeof v}`;
  });
  return `{ ${fields.join(", ")} }`;
}

/** Render a smart summary for an array of homogeneous records */
function jsonArraySummaryText(rows: Record<string, unknown>[], memoryId?: string): string {
  const constants = extractConstants(rows);
  const constantKeys = new Set(Object.keys(constants));
  const distributions = extractDistributions(rows, constantKeys);
  const anomalies = extractAnomalies(rows);
  const anomalyIndices = new Set(anomalies.map((a) => a.index));
  const { head, tail } = sampleHeadTail(rows, anomalyIndices);

  const lines: string[] = [];
  lines.push(`array[${rows.length}] of ${compactSchemaStr(rows)}`);

  if (Object.keys(constants).length > 0) {
    const constantStr = Object.entries(constants)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(", ");
    lines.push(`  constants: { ${constantStr} }`);
  }

  if (distributions.length > 0) {
    for (const dist of distributions) {
      const valueCounts = [...dist.counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([value, count]) => `"${value}"×${count}`)
        .join(", ");
      lines.push(`  distribution: { ${dist.key}: ${valueCounts} }`);
    }
  }

  if (anomalies.length > 0) {
    lines.push("  anomalies:");
    for (const a of anomalies) {
      lines.push(`    row[${a.index}]: ${compactRowStr(a.row)}`);
      lines.push(`      reason: ${a.reason}`);
    }
  }

  if (head.length > 0) {
    for (const h of head) {
      lines.push(`  head[${h.index}]: ${compactRowStr(h.row)}`);
    }
  }
  if (tail.length > 0) {
    for (const t of tail) {
      lines.push(`  tail[${t.index}]: ${compactRowStr(t.row)}`);
    }
  }

  if (memoryId) {
    lines.push(`  retrieve full with: memory_retrieve("${memoryId}")`);
  }

  return lines.join("\n");
}

function renderJsonArraySummary(
  rows: Record<string, unknown>[],
  originalText: string,
  memoryId?: string,
): RenderedContent {
  const display = jsonArraySummaryText(rows, memoryId);
  return {
    display: guardXmlPayload(display),
    contentType: "json",
    compressed: originalText.length > display.length * 1.5,
    displayTokens: Math.ceil(display.length / 4),
  };
}

/** For objects containing a large array-of-records field */
function renderJsonWithNestedArrays(
  obj: Record<string, unknown>,
  originalText: string,
  memoryId?: string,
): RenderedContent | null {
  // Find the largest array-of-records field
  let bestKey = "";
  let bestArray: Record<string, unknown>[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (isArrayOfRecords(value) && value.length > bestArray.length) {
      bestKey = key;
      bestArray = value;
    }
  }

  if (bestArray.length === 0) {
    return null;
  }

  // Render non-array fields as schema
  const otherFields: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (key === bestKey) {
      continue;
    }
    otherFields.push(`  ${key}: ${describeJsonSchema(value, 0).trimStart()}`);
  }

  const lines: string[] = [];
  lines.push("object {");
  for (const f of otherFields) {
    lines.push(f);
  }
  lines.push(`  ${bestKey}: ${jsonArraySummaryText(bestArray, memoryId)}`);
  lines.push("}");

  const display = lines.join("\n");
  return {
    display: guardXmlPayload(display),
    contentType: "json",
    compressed: originalText.length > display.length * 1.5,
    displayTokens: Math.ceil(display.length / 4),
  };
}

export function renderJson(text: string, memoryId?: string): RenderedContent {
  try {
    const parsed = JSON.parse(text);

    // Smart array compression for arrays of records
    if (isArrayOfRecords(parsed)) {
      return renderJsonArraySummary(parsed, text, memoryId);
    }

    // Check if top-level object contains array-of-records fields
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const result = renderJsonWithNestedArrays(parsed as Record<string, unknown>, text, memoryId);
      if (result) {
        return result;
      }
    }

    // Existing: schema-only for other JSON
    const schema = describeJsonSchema(parsed);
    return {
      display: guardXmlPayload(schema),
      contentType: "json",
      compressed: text.length > schema.length * 3,
      displayTokens: Math.ceil(schema.length / 4),
    };
  } catch {
    return {
      display: guardXmlPayload(text),
      contentType: "json",
      compressed: false,
      displayTokens: Math.ceil(text.length / 4),
    };
  }
}

// ─── Config renderer ────────────────────────────────────────────────

export function renderConfig(text: string): RenderedContent {
  const lines = text.split("\n").filter(Boolean);
  const keys: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("#") || trimmed.startsWith("//")) {
      continue;
    }

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

    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    const kvMatch = trimmed.match(/^([A-Za-z_][\w.-]*)\s*[=:]\s*/);
    if (kvMatch) {
      const key = kvMatch[1];
      if (key) {
        keys.push(key);
      }
      continue;
    }

    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]/);
    if (sectionMatch) {
      keys.push(`[${sectionMatch[1]}]`);
      continue;
    }

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

// ─── Diff renderer ──────────────────────────────────────────────────

export function renderDiff(text: string): RenderedContent {
  const lines = text.split("\n");
  const files: Array<{ path: string; additions: number; deletions: number }> = [];
  let currentFile = "";
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
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

    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    const altMatch = line.match(/^\+\+\+ b\/(.*)/);
    if (altMatch && !currentFile) {
      currentFile = altMatch[1] ?? "";
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }

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
