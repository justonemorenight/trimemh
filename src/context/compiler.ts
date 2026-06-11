import type {
  AuditEvent,
  CodeMemoryResult,
  MemoryItem,
  MemoryKind,
  RiskLevel,
} from "../domain/schema";
import { KIND_RISK_MAP } from "../domain/schema";
import { guardXmlPayload } from "../infrastructure/guardrail";
import { truncateWords } from "../infrastructure/sanitize";
import type { CcrStore, DeferredDetail } from "./ccr";
import {
  clearCcrStore,
  compressDetail,
  createCcrStore,
  registerDeferred,
  trackFullText,
} from "./ccr";
import {
  buildLibraryGuardDisplay,
  buildSafeFallbackDisplay,
  compressionFallbackReason,
  compressionLosesCriticalMarkers,
  estimateCompressionTokens,
  libraryOrGeneratedReason,
} from "./compression-safety";
import type { MemoryContentType } from "./content-router";
import { renderContentByType } from "./content-router";
import type { MemoryEvidenceInput } from "./evidence";

export const COMPACTION_THRESHOLD = 100;
export const SEMANTIC_DETAIL_THRESHOLD = 0.75;
export const SEMANTIC_DETAIL_LIMIT = 3;
export const SEMANTIC_DETAIL_TOKEN_CAP = 1_000;
export const CODE_PATH_DETAIL_LIMIT = 5;
export const LRU_IDLE_TURN_LIMIT = 3;
export const MEMORY_CONTEXT_BUDGET_RATIO = 0.1;
export const MIN_MEMORY_CONTEXT_BUDGET_RATIO = 0.01;
export const MAX_MEMORY_CONTEXT_BUDGET_RATIO = 0.5;
export const CHUNKED_MEMORY_PREFIX = "[chunked memory:";

// ─── CacheAligner (P0 — KV-cache stabilization) ──────────────────

/**
 * Stable XML prefix that never changes structure between turns.
 * Anthropic/OpenAI KV-caches key on prefix matching — by keeping the
 * outer skeleton identical across turns, we maximize cache hits.
 *
 * The skeleton IS:
 *   <memory_context version="1" project="...">
 *   <memory_index>...</memory_index>
 *   <memory_details>...</memory_details>
 *   <memory_lineage />
 *   <deferred_details keys="..." />
 *   </memory_context>
 *
 * Elements always appear in this FIXED order regardless of content.
 * Empty elements still render as self-closing tags.
 */

/** Structural fingerprint of the context XML skeleton (without content). */
let cachedPrefixFingerprint = "";

/** Compile the outer <memory_context> opening tag (stable across turns). */
export function compileStablePrefix(projectId: string): string {
  return `<memory_context version="1" project="${xmlAttr(projectId)}" disclosure="progressive">`;
}

/** Compile the outer closing tag (stable across turns). */
export const STABLE_SUFFIX = "</memory_context>";

/**
 * Compute a structural fingerprint from the context skeleton.
 * When the fingerprint changes, we know the cache is invalidated.
 * When it stays the same, the LLM provider can reuse KV-cache entries.
 */
export function updatePrefixFingerprint(fingerprint: string): { changed: boolean } {
  const changed = fingerprint !== cachedPrefixFingerprint;
  cachedPrefixFingerprint = fingerprint;
  return { changed };
}

/**
 * Get the current prefix fingerprint for diagnostics.
 */
export function getPrefixFingerprint(): string {
  return cachedPrefixFingerprint;
}

// ─── Adaptive context budget (Phase 2 — Intelligence Upgrade) ──────

/** Task types for adaptive budget allocation. */
export type TaskContextType =
  | "code_generation"
  | "code_review"
  | "debugging"
  | "planning"
  | "refactoring"
  | "documentation"
  | "conversation"
  | "unknown";

export const TASK_CONTEXT_TYPES: readonly TaskContextType[] = [
  "code_generation",
  "code_review",
  "debugging",
  "planning",
  "refactoring",
  "documentation",
  "conversation",
  "unknown",
];

/** Budget ratios per task type. Higher = more memory context. */
export const TASK_BUDGET_RATIOS: Record<TaskContextType, number> = {
  code_generation: 0.08, // need max room for code output
  code_review: 0.15, // need rules + procedures
  debugging: 0.12, // need context but also trace space
  planning: 0.2, // need historical decisions
  refactoring: 0.14, // need code context links
  documentation: 0.1, // moderate context
  conversation: 0.06, // minimal memory context
  unknown: 0.1, // default
};

/** Keywords → task type heuristic classification. */
const TASK_CLASSIFIERS: Array<{ pattern: RegExp; type: TaskContextType }> = [
  {
    pattern:
      /\b(implement|build|create|write|generate|code|develop)\b.*\b(function|class|module|api|endpoint|component)\b/i,
    type: "code_generation",
  },
  {
    pattern:
      /\b(review|audit|check|examine|inspect|analyze)\b.*\b(code|pr|pull request|diff|change)\b/i,
    type: "code_review",
  },
  {
    pattern:
      /\b(debug|fix|resolve|troubleshoot|investigate)\b.*\b(bug|error|issue|crash|fail|broken)\b/i,
    type: "debugging",
  },
  { pattern: /\b(plan|design|architect|decide|roadmap|strategy)\b/i, type: "planning" },
  { pattern: /\b(refactor|restructure|reorganize|clean|improve)\b/i, type: "refactoring" },
  { pattern: /\b(document|explain|describe|summarize|readme)\b/i, type: "documentation" },
  { pattern: /\b(chat|talk|conversation|quick question|brainstorm)\b/i, type: "conversation" },
];

/**
 * Classify a user/agent query into a task context type.
 * Used for adaptive budget allocation.
 */
export function classifyTaskContext(query: string): TaskContextType {
  if (!query?.trim()) {
    return "unknown";
  }
  for (const classifier of TASK_CLASSIFIERS) {
    if (classifier.pattern.test(query)) {
      return classifier.type;
    }
  }
  return "unknown";
}

/**
 * Calculate adaptive context budget based on task type and model window.
 *
 * Phase 2 enhancement: instead of a static 10% budget, allocate memory
 * context tokens proportional to the task's need for historical knowledge.
 *
 *   planning (20%) > code_review (15%) > refactoring (14%)
 *   > debugging (12%) > documentation (10%) > code_generation (8%)
 *   > conversation (6%)
 */
export function adaptiveBudget(
  modelContextTokens: number,
  taskType: TaskContextType = "unknown",
  overrideRatio?: number,
): number {
  const ratio = budgetRatioForTask(taskType, overrideRatio);
  return Math.floor(modelContextTokens * ratio);
}

export function budgetRatioForTask(taskType: TaskContextType, overrideRatio?: number): number {
  const rawRatio = overrideRatio ?? TASK_BUDGET_RATIOS[taskType] ?? MEMORY_CONTEXT_BUDGET_RATIO;
  if (!Number.isFinite(rawRatio)) {
    return MEMORY_CONTEXT_BUDGET_RATIO;
  }
  return Math.max(
    MIN_MEMORY_CONTEXT_BUDGET_RATIO,
    Math.min(MAX_MEMORY_CONTEXT_BUDGET_RATIO, rawRatio),
  );
}

const RISK_ORDER: Record<RiskLevel, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const HIGH_RISK_OPERATION_PATTERN =
  /\b(trade|buy|sell|order|transaction|portfolio|allocate|git clean|rm -rf|delete database)\b/i;

export interface MemoryIndexItem {
  id: string;
  kind: MemoryKind;
  text: string;
  status?: string;
  created_at?: string;
  confidence?: number;
}

export interface DetailCodeLink {
  path: string;
  relation: string;
  confidence?: number;
  symbol?: string | null;
  line_start?: number | null;
  line_end?: number | null;
}

export interface MemoryDetailInput {
  item: MemoryItem;
  codeLinks?: DetailCodeLink[];
}

export interface MemoryLineageInput {
  item: MemoryItem;
  auditEvents: AuditEvent[];
}

export interface SemanticMatch {
  item: MemoryItem;
  similarity: number;
}

export interface ActiveDetail {
  item: MemoryItem;
  lastReferencedTurn: number;
  source: "semantic" | "code_path" | "operational" | "manual";
  openPath?: string;
}

export interface PromptContextState {
  layer1: string;
  memoryEvidence?: MemoryEvidenceInput[];
  layer2Details: MemoryDetailInput[];
  layer3Lineages: MemoryLineageInput[];
}

export interface BudgetResult {
  state: PromptContextState;
  evicted: Array<{ id: string; layer: "layer2" | "layer3"; reason: string }>;
  compactedIndex: boolean;
  overBudget: boolean;
  budgetTokens: number;
  estimatedPromptTokens: number;
}

function riskForKind(kind: MemoryKind): RiskLevel {
  return KIND_RISK_MAP[kind];
}

function emojiForRisk(risk: RiskLevel): string {
  switch (risk) {
    case "critical":
      return "🔴";
    case "high":
      return "🟡";
    case "medium":
      return "🟤";
    case "low":
      return "🔵";
  }
}

function summarize(text: string, maxWords = 8): string {
  return guardXmlPayload(truncateWords(text.replace(/\s+/g, " ").trim(), maxWords));
}

function xmlAttr(value: string | number | null | undefined): string {
  return guardXmlPayload(String(value ?? ""));
}

function groupByKind(items: MemoryIndexItem[]): Map<MemoryKind, MemoryIndexItem[]> {
  const grouped = new Map<MemoryKind, MemoryIndexItem[]>();
  for (const item of items) {
    const existing = grouped.get(item.kind) ?? [];
    existing.push(item);
    grouped.set(item.kind, existing);
  }
  return grouped;
}

function renderExpandedCategory(kind: MemoryKind, items: MemoryIndexItem[]): string {
  const risk = riskForKind(kind);
  const emoji = emojiForRisk(risk);
  const lines = [`  <category kind="${kind}" risk="${risk}" count="${items.length}">`];
  for (const item of items) {
    lines.push(
      `    <item id="${xmlAttr(item.id)}">${emoji} [${kind}] ${summarize(item.text)}</item>`,
    );
  }
  lines.push("  </category>");
  return lines.join("\n");
}

function renderCompactedMediumCategory(kind: MemoryKind, items: MemoryIndexItem[]): string {
  const titles = items
    .slice(0, 20)
    .map((item) => `${item.id.slice(0, 8)}:${summarize(item.text, 5)}`)
    .join(", ");
  const suffix = items.length > 20 ? `, +${items.length - 20} more` : "";
  return [
    `  <category kind="${kind}" risk="medium" status="compacted" count="${items.length}">`,
    `    <item_summary>Active ${kind} items: ${guardXmlPayload(titles + suffix)}</item_summary>`,
    "  </category>",
  ].join("\n");
}

function renderCollapsedLowCategory(kind: MemoryKind, items: MemoryIndexItem[]): string {
  return `  <category kind="${kind}" risk="low" status="collapsed" count="${items.length}" />`;
}

export function compileLayer1Index(
  memories: MemoryIndexItem[],
  opts: { projectId?: string; forceCompact?: boolean } = {},
): string {
  const active = memories.filter((item) => item.status !== "archived" && item.status !== "expired");
  const compact = opts.forceCompact ?? active.length > COMPACTION_THRESHOLD;
  const grouped = groupByKind(active);
  const orderedKinds = [...grouped.keys()].sort((a, b) => {
    const riskDiff = RISK_ORDER[riskForKind(b)] - RISK_ORDER[riskForKind(a)];
    return riskDiff || a.localeCompare(b);
  });

  const attrs = [
    `total_active="${active.length}"`,
    `compact="${compact}"`,
    opts.projectId ? `project_id="${xmlAttr(opts.projectId)}"` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const lines = [`<memory_index ${attrs}>`];
  for (const kind of orderedKinds) {
    const items = grouped.get(kind) ?? [];
    const risk = riskForKind(kind);
    if (!compact || risk === "critical" || risk === "high") {
      lines.push(renderExpandedCategory(kind, items));
    } else if (risk === "medium") {
      lines.push(renderCompactedMediumCategory(kind, items));
    } else {
      lines.push(renderCollapsedLowCategory(kind, items));
    }
  }
  lines.push("</memory_index>");
  return lines.join("\n");
}

// ─── CCR store (per-turn, mutable) ──────────────────────────────────

let currentCcrStore: CcrStore = createCcrStore();

/** Get the current turn's CCR store. */
export function getCcrStore(): CcrStore {
  return currentCcrStore;
}

/** Reset the CCR store for a new turn. */
export function resetCcrStore(): void {
  clearCcrStore(currentCcrStore);
  currentCcrStore = createCcrStore();
}

// ─── Smart detail rendering (ContentRouter + CCR) ──────────────────

export interface SmartDetailOutput {
  /** The display text for XML injection */
  displayContent: string;
  /** Content type that was detected */
  contentType: MemoryContentType;
  /** Whether compression was applied */
  compressed: boolean;
  /** Deferred detail for CCR retrieval (null if no compression) */
  deferred: DeferredDetail | null;
  /** Estimated display tokens */
  displayTokens: number;
}

/**
 * Smart rendering pipeline for a single memory detail:
 *
 * 1. Detect content type (code/log/json/config/diff/prose)
 * 2. Apply content-type-specific compression (ContentRouter)
 * 3. If result is still long and is prose, apply CCR compression
 * 4. Track deferred details in the CCR store
 */
function buildSmartDetailOutput(item: MemoryItem): SmartDetailOutput {
  if (item.text.startsWith(CHUNKED_MEMORY_PREFIX)) {
    return {
      displayContent: guardXmlPayload(item.text),
      contentType: "prose",
      compressed: true,
      deferred: null,
      displayTokens: estimateTokens(item.text),
    };
  }

  // Generated/library blobs are rarely useful in-context and can inflate prompts.
  const libraryReason = libraryOrGeneratedReason(item);
  if (libraryReason) {
    const guarded = buildLibraryGuardDisplay(item, libraryReason);
    return {
      displayContent: guarded.display,
      contentType: "code",
      compressed: guarded.compressed,
      deferred:
        guarded.tokenSaved > 0
          ? {
              memoryId: item.id,
              fullText: item.text,
              summary: guarded.display,
              tokenSaved: guarded.tokenSaved,
              retrievalKey: `trimemh:${item.id}`,
            }
          : null,
      displayTokens: estimateCompressionTokens(guarded.display),
    };
  }

  // Step 1+2: ContentRouter — type-specific compression
  const rendered = renderContentByType(item);

  // Step 3: If still long, apply CCR on top (for prose, or any type
  // where the type-specific renderer didn't compress enough)
  let displayContent = rendered.display;
  let deferred: DeferredDetail | null = null;
  let compressed = rendered.compressed;

  // For prose that wasn't compressed by ContentRouter, use CCR
  if (rendered.contentType === "prose" && !compressed) {
    const ccrResult = compressDetail(item);
    displayContent = ccrResult.display;
    deferred = ccrResult.deferred;
    compressed = deferred !== null;
  }

  let fallbackReason: string | null = null;
  if (compressed) {
    const codeCompressionStillSafe =
      rendered.contentType === "code" &&
      !compressionLosesCriticalMarkers(item.text, displayContent);
    fallbackReason = codeCompressionStillSafe
      ? null
      : compressionFallbackReason(item.text, displayContent);
  }
  if (fallbackReason) {
    const fallback = buildSafeFallbackDisplay(item, fallbackReason);
    displayContent = fallback.display;
    compressed = fallback.compressed;
    deferred =
      fallback.tokenSaved > 0
        ? {
            memoryId: item.id,
            fullText: item.text,
            summary: displayContent,
            tokenSaved: fallback.tokenSaved,
            retrievalKey: `trimemh:${item.id}`,
          }
        : null;
  }

  // For content types where the type renderer already compressed but the
  // display is still verbose, also register for CCR retrieval
  if (compressed && rendered.contentType !== "prose" && !deferred) {
    // The type renderer compressed, but we still want to offer retrieval
    const displayTokens = estimateCompressionTokens(displayContent);
    const fullTokens = Math.ceil(item.text.length / 4);
    const tokenSaved = Math.max(0, fullTokens - displayTokens);

    if (tokenSaved > 50 || rendered.contentType === "code") {
      deferred = {
        memoryId: item.id,
        fullText: item.text,
        summary: displayContent,
        tokenSaved,
        retrievalKey: `trimemh:${item.id}`,
      };
    }
  }

  return {
    displayContent,
    contentType: rendered.contentType,
    compressed,
    deferred,
    displayTokens: estimateCompressionTokens(displayContent),
  };
}

export function renderDetailSmart(item: MemoryItem): SmartDetailOutput {
  const output = buildSmartDetailOutput(item);

  // Step 4: Track in CCR store
  if (output.deferred) {
    registerDeferred(currentCcrStore, output.deferred);
  } else {
    trackFullText(currentCcrStore);
  }

  return output;
}

function compileLayer2DetailXml(detail: MemoryDetailInput, smart: SmartDetailOutput): string {
  const lines: string[] = [];
  const item = detail.item;
  const risk = riskForKind(item.kind as MemoryKind);

  const contentType = detail.codeLinks?.length
    ? "code" // code-linked memories are always code-related
    : smart.contentType;

  lines.push(
    `  <detail id="${xmlAttr(item.id)}" kind="${item.kind}" risk="${risk}" content_type="${contentType}" compressed="${smart.compressed}">`,
  );
  lines.push(`    <content>${smart.displayContent}</content>`);
  if (detail.codeLinks?.length) {
    lines.push("    <code_links>");
    for (const link of detail.codeLinks) {
      lines.push(
        `      <link relation="${xmlAttr(link.relation)}" path="${xmlAttr(link.path)}" symbol="${xmlAttr(link.symbol)}" line_start="${xmlAttr(link.line_start)}" line_end="${xmlAttr(link.line_end)}" confidence="${xmlAttr(link.confidence)}" />`,
      );
    }
    lines.push("    </code_links>");
  }
  lines.push(`    <confidence>${xmlAttr(item.confidence)}</confidence>`);
  lines.push(`    <source>${xmlAttr(item.source)}</source>`);
  lines.push("  </detail>");
  return lines.join("\n");
}

export function compileLayer2Details(details: MemoryDetailInput[]): string {
  const lines = [`<memory_details count="${details.length}">`];
  for (const detail of details) {
    lines.push(compileLayer2DetailXml(detail, renderDetailSmart(detail.item)));
  }
  lines.push("</memory_details>");
  return lines.join("\n");
}

export function compileMemoryEvidence(evidence: MemoryEvidenceInput[] = []): string {
  if (evidence.length === 0) {
    return '<memory_evidence count="0" />';
  }
  const lines = [`<memory_evidence count="${evidence.length}">`];
  for (const span of evidence) {
    const offsetAttrs =
      span.sourceStart !== undefined || span.sourceEnd !== undefined
        ? ` source_start="${xmlAttr(span.sourceStart)}" source_end="${xmlAttr(span.sourceEnd)}"`
        : "";
    lines.push(
      `  <evidence memory_id="${xmlAttr(span.memoryId)}" kind="${span.kind}" label="${span.label}" score="${xmlAttr(span.score)}"${offsetAttrs}>${guardXmlPayload(span.text)}</evidence>`,
    );
  }
  lines.push("</memory_evidence>");
  return lines.join("\n");
}

export function compileLayer2DetailsFromCode(results: CodeMemoryResult[]): string {
  const details = results.map((result) => ({
    item: result.item,
    codeLinks: [
      {
        path: result.entity.path,
        symbol: result.entity.symbol,
        line_start: result.entity.line_start,
        line_end: result.entity.line_end,
        relation: result.link.relation,
        confidence: result.link.confidence,
      },
    ],
  }));
  return compileLayer2Details(details);
}

// ─── Deferred details section (CCR) ─────────────────────────────────

/**
 * Render the <deferred_details> section for the context XML.
 * This tells the LLM which memories are available for on-demand retrieval
 * via the `memory_retrieve` MCP tool.
 */
export function compileDeferredSection(store: CcrStore): string {
  if (store.deferred.size === 0) {
    return '<deferred_details keys="none" />';
  }
  const keys = [...store.deferred.keys()].join(" ");
  const saved = store.totalTokensSaved;
  return `<deferred_details keys="${guardXmlPayload(keys)}" tokens_saved="${saved}" count="${store.deferred.size}" />`;
}

export function compileLayer3Lineage(input: MemoryLineageInput): string {
  const item = input.item;
  const lines = [
    `<memory_lineage target_id="${xmlAttr(item.id)}">`,
    "  <provenance>",
    `    <source>${xmlAttr(item.source)}</source>`,
    `    <created_at>${xmlAttr(item.created_at)}</created_at>`,
    `    <updated_at>${xmlAttr(item.updated_at)}</updated_at>`,
    `    <content_hash>${xmlAttr(item.content_hash)}</content_hash>`,
    `    <evidence>${guardXmlPayload(item.evidence_json)}</evidence>`,
    "  </provenance>",
    "  <audit_history>",
  ];
  for (const event of input.auditEvents) {
    lines.push(
      `    <event id="${xmlAttr(event.id)}" type="${xmlAttr(event.event_type)}" actor="${xmlAttr(event.actor)}" timestamp="${xmlAttr(event.created_at)}">${guardXmlPayload(event.payload_json)}</event>`,
    );
  }
  lines.push("  </audit_history>");
  lines.push("</memory_lineage>");
  return lines.join("\n");
}

export function selectSemanticDetails(matches: SemanticMatch[]): MemoryDetailInput[] {
  const selected: MemoryDetailInput[] = [];
  let tokenTotal = 0;
  for (const match of [...matches]
    .filter((m) => m.similarity > SEMANTIC_DETAIL_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity)) {
    if (selected.length >= SEMANTIC_DETAIL_LIMIT) {
      break;
    }
    const tokens = estimateTokens(match.item.text);
    if (tokenTotal + tokens > SEMANTIC_DETAIL_TOKEN_CAP && selected.length > 0) {
      break;
    }
    selected.push({ item: match.item });
    tokenTotal += tokens;
  }
  return selected;
}

export function selectCodePathDetails(results: CodeMemoryResult[]): MemoryDetailInput[] {
  return [...results]
    .sort((a, b) => {
      const riskDiff =
        RISK_ORDER[riskForKind(b.item.kind as MemoryKind)] -
        RISK_ORDER[riskForKind(a.item.kind as MemoryKind)];
      if (riskDiff) {
        return riskDiff;
      }
      return b.item.created_at.localeCompare(a.item.created_at);
    })
    .slice(0, CODE_PATH_DETAIL_LIMIT)
    .map((result) => ({
      item: result.item,
      codeLinks: [
        {
          path: result.entity.path,
          symbol: result.entity.symbol,
          line_start: result.entity.line_start,
          line_end: result.entity.line_end,
          relation: result.link.relation,
          confidence: result.link.confidence,
        },
      ],
    }));
}

export function detectsOperationalContext(text: string): boolean {
  return HIGH_RISK_OPERATION_PATTERN.test(text);
}

export function selectOperationalDetails(memories: MemoryItem[]): MemoryDetailInput[] {
  return memories
    .filter((item) => item.status === "active")
    .filter((item) => riskForKind(item.kind as MemoryKind) === "critical")
    .map((item) => ({ item }));
}

export function evictLruDetails(
  activeDetails: ActiveDetail[],
  currentTurn: number,
  openPaths: Set<string> = new Set(),
): { kept: ActiveDetail[]; evicted: ActiveDetail[] } {
  const kept: ActiveDetail[] = [];
  const evicted: ActiveDetail[] = [];
  for (const detail of activeDetails) {
    const idleTurns = currentTurn - detail.lastReferencedTurn;
    const closedPath = detail.openPath !== undefined && !openPaths.has(detail.openPath);
    if (idleTurns >= LRU_IDLE_TURN_LIMIT || closedPath) {
      evicted.push(detail);
    } else {
      kept.push(detail);
    }
  }
  return { kept, evicted };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateLayer2DetailsPromptTokens(details: MemoryDetailInput[]): number {
  const lines = [`<memory_details count="${details.length}">`];
  for (const detail of details) {
    lines.push(compileLayer2DetailXml(detail, buildSmartDetailOutput(detail.item)));
  }
  lines.push("</memory_details>");
  return estimateTokens(lines.join("\n"));
}

export function estimatePromptStateTokens(state: PromptContextState): number {
  return (
    estimateTokens(state.layer1) +
    estimateTokens(compileMemoryEvidence(state.memoryEvidence)) +
    estimateLayer2DetailsPromptTokens(state.layer2Details) +
    state.layer3Lineages.reduce(
      (sum, lineage) => sum + estimateTokens(compileLayer3Lineage(lineage)),
      0,
    )
  );
}

function sortDetailsForEviction(details: MemoryDetailInput[]): MemoryDetailInput[] {
  return [...details].sort((a, b) => {
    const riskDiff =
      RISK_ORDER[riskForKind(a.item.kind as MemoryKind)] -
      RISK_ORDER[riskForKind(b.item.kind as MemoryKind)];
    if (riskDiff) {
      return riskDiff;
    }
    return a.item.confidence - b.item.confidence;
  });
}

export function enforceContextBudget(
  state: PromptContextState,
  opts: {
    modelContextTokens: number;
    budgetTokens?: number;
    allIndexMemories?: MemoryIndexItem[];
    projectId?: string;
  },
): BudgetResult {
  const budget =
    opts.budgetTokens ?? Math.floor(opts.modelContextTokens * MEMORY_CONTEXT_BUDGET_RATIO);
  const next: PromptContextState = {
    layer1: state.layer1,
    memoryEvidence: [...(state.memoryEvidence ?? [])],
    layer2Details: [...state.layer2Details],
    layer3Lineages: [...state.layer3Lineages],
  };
  const evicted: BudgetResult["evicted"] = [];
  let compactedIndex = false;

  if (estimatePromptStateTokens(next) <= budget) {
    return {
      state: next,
      evicted,
      compactedIndex,
      overBudget: false,
      budgetTokens: budget,
      estimatedPromptTokens: estimatePromptStateTokens(next),
    };
  }

  for (const lineage of next.layer3Lineages) {
    evicted.push({ id: lineage.item.id, layer: "layer3", reason: "layer3_turn_isolation" });
  }
  next.layer3Lineages = [];

  for (const detail of sortDetailsForEviction(next.layer2Details)) {
    if (estimatePromptStateTokens(next) <= budget) {
      break;
    }
    const risk = riskForKind(detail.item.kind as MemoryKind);
    if (risk === "critical") {
      continue;
    }
    next.layer2Details = next.layer2Details.filter((d) => d.item.id !== detail.item.id);
    next.memoryEvidence = next.memoryEvidence?.filter(
      (evidence) => evidence.memoryId !== detail.item.id,
    );
    evicted.push({ id: detail.item.id, layer: "layer2", reason: `budget_${risk}_risk_eviction` });
  }

  while ((next.memoryEvidence?.length ?? 0) > 0 && estimatePromptStateTokens(next) > budget) {
    const sorted = [...(next.memoryEvidence ?? [])].sort((a, b) => a.score - b.score);
    const dropped = sorted[0];
    next.memoryEvidence = (next.memoryEvidence ?? []).filter((evidence) => evidence !== dropped);
  }

  if (estimatePromptStateTokens(next) > budget && opts.allIndexMemories) {
    next.layer1 = compileLayer1Index(opts.allIndexMemories, {
      projectId: opts.projectId,
      forceCompact: true,
    });
    compactedIndex = true;
  }

  return {
    state: next,
    evicted,
    compactedIndex,
    overBudget: estimatePromptStateTokens(next) > budget,
    budgetTokens: budget,
    estimatedPromptTokens: estimatePromptStateTokens(next),
  };
}

export function clearLayer3AtTurnEnd(state: PromptContextState): PromptContextState {
  return {
    ...state,
    layer3Lineages: [],
  };
}

export function detectAdversarialOverride(input: {
  relation: string;
  target?: MemoryItem | null;
}): { override: boolean; forcedRisk?: RiskLevel; targetRisk?: RiskLevel } {
  if (!(["supersedes", "contradicts"].includes(input.relation) && input.target)) {
    return { override: false };
  }
  const targetRisk = riskForKind(input.target.kind as MemoryKind);
  if (targetRisk === "high" || targetRisk === "critical") {
    return { override: true, forcedRisk: "critical", targetRisk };
  }
  return { override: false, targetRisk };
}
