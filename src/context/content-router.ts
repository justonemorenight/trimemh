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
import type { MemoryContentType, RenderedContent } from "./content-sniffers";
import { detectContentTypeForItem } from "./content-sniffers";
import {
  renderCode,
  renderConfig,
  renderDiff,
  renderJson,
  renderLog,
} from "./content-renderers";

// Re-export types and detection functions
export type { MemoryContentType, ContentMatch, RenderedContent } from "./content-sniffers";
export { detectContentType } from "./content-sniffers";
export { renderCode, renderConfig, renderDiff, renderJson, renderLog } from "./content-renderers";

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
