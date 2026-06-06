/**
 * MCP Security & Output Sanitization
 *
 * SDD-05 §5: Input size limits, output hygiene, XML injection protection,
 * and audit integrity via arguments_hash.
 */

// ─── SHA-256 via Bun.CryptoHasher ───────────────────────────────

let _hasher: import("bun").CryptoHasher | null = null;

function sha256hex(input: string): string {
  if (!_hasher) {
    _hasher = new Bun.CryptoHasher("sha256");
  }
  // Clone the hasher state by creating a fresh one each time —
  // Bun.CryptoHasher.update() is mutable, so we reinstantiate.
  const h = new Bun.CryptoHasher("sha256");
  h.update(input);
  return h.digest("hex") as string;
}

// ─── XML escaping (SDD-05 §5.3.2) ──────────────────────────────

/**
 * Sanitize text before injecting it into XML-wrapped LLM prompts.
 *
 * 1. Replaces XML control characters with HTML entity mappings.
 * 2. Proactively strips closing XML tag patterns to prevent
 *    prompt-injection break-out attacks.
 */
export function sanitizeXmlPayload(text: string): string {
  if (!text) {
    return "";
  }

  // 1. Basic entity replacement to neutralize raw tag symbols
  let sanitized = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  // 2. Proactive check to block specific XML tag ending strings
  // Prevents string matching '</content>' or other container closing boundaries
  const tagPattern = /&lt;\/([a-zA-Z_][a-zA-Z0-9_\-.]*)&gt;/g;
  sanitized = sanitized.replace(tagPattern, "[REMOVED_BOUNDARY]");

  return sanitized;
}

// ─── Output normalization (SDD-05 §5.2) ─────────────────────────

/**
 * Collapse multiple consecutive newlines (3+) into at most 2.
 */
export function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

/**
 * Truncate text to at most `maxWords` words.
 * Appends "[Truncated for Context Hygiene]" when truncation occurs.
 */
export function truncateWords(text: string, maxWords = 200): string {
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  const words = text.split(/\s+/);
  if (words.length <= maxWords) {
    return text;
  }
  return `${words.slice(0, maxWords).join(" ")} … [Truncated for Context Hygiene]`;
}

/**
 * Apply all output hygiene rules:
 * 1. Collapse excessive blank lines
 * 2. Truncate to maxWords (default 200)
 * 3. XML-escape the result
 */
export function sanitizeOutput(text: string, maxWords = 200): string {
  return sanitizeXmlPayload(truncateWords(collapseBlankLines(text), maxWords));
}

// ─── Input validation (SDD-05 §5.1) ─────────────────────────────

/** Maximum bytes for a single string field (10 KB). */
import { CONFIG } from "../config";

export const MAX_STRING_BYTES = CONFIG.guardrails.maxStringBytes;

/**
 * Validate that a string does not exceed `maxBytes` when encoded as UTF-8.
 * Returns an error message string if invalid, or null if valid.
 */
export function validateStringSize(
  value: string,
  maxBytes: number | undefined = undefined,
  fieldName = "value",
): string | null {
  const effectiveMaxBytes = maxBytes ?? CONFIG.guardrails.maxStringBytes;
  const byteLength = new TextEncoder().encode(value).length;
  if (byteLength > effectiveMaxBytes) {
    return `Field "${fieldName}" exceeds maximum size of ${effectiveMaxBytes} bytes (received ${byteLength} bytes).`;
  }
  return null;
}

// ─── arguments_hash (SDD-05 §6.1.1) ────────────────────────────

/**
 * Compute a deterministic SHA-256 hash of a tool's arguments object.
 * Keys are sorted before serialization to guarantee determinism.
 *
 *   arguments_hash = SHA256(JSON.stringify(sortedKeys(arguments)))
 */
export function hashArguments(args: Record<string, unknown>): string {
  // Sort keys for deterministic serialization
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(args).sort()) {
    sorted[key] = args[key];
  }
  return sha256hex(JSON.stringify(sorted));
}
