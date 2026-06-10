import type { Database } from "bun:sqlite";

import { CONFIG } from "../config";
import type { MemoryItem } from "../domain/schema";
import { getAuditEvents, listPendingProposals } from "../persistence/repository";
import { embedText } from "../retrieval/embedding-provider";
import { vectorSearch } from "../retrieval/hybrid";
import { getMemoriesForCode, listAll } from "../service";
import type { DeferredDetail } from "./ccr";
import { prepareChunkedDisclosure } from "./chunking";
import type {
  ActiveDetail,
  MemoryDetailInput,
  MemoryLineageInput,
  PromptContextState,
  SemanticMatch,
  TaskContextType,
} from "./compiler";
import {
  STABLE_SUFFIX,
  adaptiveBudget,
  budgetRatioForTask,
  classifyTaskContext,
  clearLayer3AtTurnEnd,
  compileDeferredSection,
  compileLayer1Index,
  compileLayer2Details,
  compileLayer3Lineage,
  compileMemoryEvidence,
  compileStablePrefix,
  detectsOperationalContext,
  enforceContextBudget,
  evictLruDetails,
  getCcrStore,
  resetCcrStore,
  selectCodePathDetails,
  selectOperationalDetails,
  selectSemanticDetails,
  updatePrefixFingerprint,
} from "./compiler";
import type { CompressionPolicyInput } from "./compression-policy";
import { resolveCompressionPolicy } from "./compression-policy";
import { detectContentTypeForItem } from "./content-sniffers";
import type { ContextAccuracySignals, EvidenceMode } from "./evidence";
import { generateEvidenceSubqueries, queryTerms, selectMemoryEvidence } from "./evidence";

const WORD_SPLIT_RE = /\s+/;
const MAX_RETRIEVAL_ROUNDS = 3;
const EVIDENCE_AUTO_TASKS = new Set<TaskContextType>([
  "planning",
  "debugging",
  "code_review",
  "refactoring",
]);

export interface RuntimeContextState {
  turn: number;
  activeDetails: ActiveDetail[];
}

export interface AssembleContextInput {
  db: Database;
  projectId: string;
  query?: string | null;
  openPaths?: string[];
  includeLineageForIds?: string[];
  modelContextTokens?: number;
  taskType?: TaskContextType;
  memoryContextBudgetRatio?: number;
  evidenceMode?: EvidenceMode;
  retrievalRounds?: number;
  compressionPolicy?: CompressionPolicyInput;
  state?: RuntimeContextState;
}

export interface AssembledContext {
  xml: string;
  state: RuntimeContextState;
  selectedDetailIds: string[];
  lineageIds: string[];
  evicted: Array<{ id: string; layer: "layer2" | "layer3"; reason: string }>;
  compactedIndex: boolean;
  overBudget: boolean;
  /** CCR deferred details available for on-demand retrieval */
  deferredDetails: DeferredDetail[];
  /** CCR stats for diagnostics */
  ccrStats: {
    totalTokensSaved: number;
    compressedCount: number;
    fullCount: number;
    retrievableCount: number;
  };
  /** Task type used for adaptive memory context budgeting */
  taskType: TaskContextType;
  /** Memory context budget ratio used for this turn */
  budgetRatio: number;
  /** Memory context budget in approximate tokens */
  budgetTokens: number;
  /** Estimated prompt tokens after compression/render preview */
  estimatedPromptTokens: number;
  /** Whether the KV-cache prefix changed (CacheAligner) */
  prefixChanged: boolean;
  /** Number of pending proposals awaiting agent review */
  pendingProposalCount: number;
  /** Number of compact evidence spans rendered into the prompt */
  evidenceSpanCount: number;
  /** Memory IDs represented by rendered evidence spans */
  evidenceMemoryIds: string[];
  /** Number of semantic retrieval rounds used */
  retrievalRounds: number;
  /** Compression/evidence policy ID used for this turn */
  compressionPolicyId: string;
  /** Runtime accuracy signals for eval/debugging */
  contextAccuracySignals: ContextAccuracySignals;
}

export function createRuntimeContextState(): RuntimeContextState {
  return { turn: 0, activeDetails: [] };
}

function mergeDetails(details: MemoryDetailInput[]): MemoryDetailInput[] {
  const byId = new Map<string, MemoryDetailInput>();
  for (const detail of details) {
    const existing = byId.get(detail.item.id);
    byId.set(detail.item.id, {
      item: detail.item,
      codeLinks: [...(existing?.codeLinks ?? []), ...(detail.codeLinks ?? [])],
    });
  }
  return [...byId.values()];
}

function detailSource(
  detail: MemoryDetailInput,
  semanticIds: Set<string>,
  codePathIds: Set<string>,
  operationalIds: Set<string>,
): ActiveDetail["source"] {
  if (operationalIds.has(detail.item.id)) {
    return "operational";
  }
  if (codePathIds.has(detail.item.id)) {
    return "code_path";
  }
  if (semanticIds.has(detail.item.id)) {
    return "semantic";
  }
  return "manual";
}

function cloneDetailWithItem(detail: MemoryDetailInput, item: MemoryItem): MemoryDetailInput {
  return {
    ...detail,
    item,
    codeLinks: detail.codeLinks ? [...detail.codeLinks] : undefined,
  };
}

function chunkableProseDetail(detail: MemoryDetailInput, query: string): boolean {
  if (!query.trim()) {
    return false;
  }
  if (detectContentTypeForItem(detail.item).type !== "prose") {
    return false;
  }
  return (
    detail.item.text.trim().split(WORD_SPLIT_RE).filter(Boolean).length >=
    CONFIG.chunking.minWordsForChunking
  );
}

function applyQueryAwareChunks(details: MemoryDetailInput[], query: string): MemoryDetailInput[] {
  return details.map((detail) => {
    if (!chunkableProseDetail(detail, query)) {
      return detail;
    }

    const disclosure = prepareChunkedDisclosure(detail.item.id, detail.item.text, query);
    if (!disclosure.chunked) {
      return detail;
    }

    const totalChunks = disclosure.layer2Chunks.length + disclosure.layer3Chunks.length;
    const chunkText = [
      `[chunked memory: ${disclosure.layer2Chunks.length}/${totalChunks} relevant chunks selected; retrieve full text with memory_retrieve("${detail.item.id}")]`,
      ...disclosure.layer2Chunks.map(
        (chunk) =>
          `[chunk ${chunk.index + 1}/${totalChunks} score=${chunk.score.toFixed(3)}]\n${chunk.text}`,
      ),
    ].join("\n\n");

    return cloneDetailWithItem(detail, {
      ...detail.item,
      text: chunkText,
    });
  });
}

function normalizedEvidenceMode(value: EvidenceMode | undefined): EvidenceMode {
  return value ?? "auto";
}

function evidenceEnabled(mode: EvidenceMode, taskType: TaskContextType): boolean {
  if (mode === "force") {
    return true;
  }
  if (mode === "off") {
    return false;
  }
  return EVIDENCE_AUTO_TASKS.has(taskType);
}

function normalizedRetrievalRounds(
  requested: number | undefined,
  taskType: TaskContextType,
  query: string,
): number {
  if (!query.trim()) {
    return 1;
  }
  const fallback = EVIDENCE_AUTO_TASKS.has(taskType) ? 2 : 1;
  const raw = requested ?? fallback;
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(1, Math.min(MAX_RETRIEVAL_ROUNDS, Math.floor(raw)));
}

function mergeSemanticMatches(
  existing: Map<string, SemanticMatch>,
  matches: SemanticMatch[],
): void {
  for (const match of matches) {
    const current = existing.get(match.item.id);
    if (!current || match.similarity > current.similarity) {
      existing.set(match.item.id, match);
    }
  }
}

function semanticMatchesForQuery(db: Database, projectId: string, query: string): SemanticMatch[] {
  return vectorSearch(db, projectId, embedText(query), CONFIG.context.vectorSearchLimit).map(
    (result) => ({
      item: result.item,
      similarity: result.similarity,
    }),
  );
}

function selectIterativeSemanticDetails(input: {
  db: Database;
  projectId: string;
  query: string;
  openPaths: string[];
  retrievalRounds: number;
  compressionPolicy: ReturnType<typeof resolveCompressionPolicy>;
}): { details: MemoryDetailInput[]; roundsUsed: number; subqueries: string[] } {
  if (!input.query.trim()) {
    return { details: [], roundsUsed: 0, subqueries: [] };
  }

  const candidates = new Map<string, SemanticMatch>();
  const firstRound = semanticMatchesForQuery(input.db, input.projectId, input.query);
  mergeSemanticMatches(candidates, firstRound);
  let roundsUsed = 1;
  const subqueries: string[] = [];

  if (input.retrievalRounds > 1 && firstRound.length > 0) {
    const seedDetails = selectSemanticDetails(firstRound).length
      ? selectSemanticDetails(firstRound)
      : firstRound.slice(0, 3).map((match) => ({ item: match.item }));
    subqueries.push(
      ...generateEvidenceSubqueries({
        query: input.query,
        details: seedDetails,
        openPaths: input.openPaths,
        policy: input.compressionPolicy,
      }),
    );
  }

  for (const subquery of subqueries.slice(0, input.retrievalRounds - 1)) {
    mergeSemanticMatches(candidates, semanticMatchesForQuery(input.db, input.projectId, subquery));
    roundsUsed += 1;
  }

  return {
    details: selectSemanticDetails([...candidates.values()]),
    roundsUsed,
    subqueries,
  };
}

function lineageForIds(
  db: Database,
  projectId: string,
  memories: MemoryItem[],
  ids: string[],
): MemoryLineageInput[] {
  if (ids.length === 0) {
    return [];
  }
  const requested = new Set(ids);
  const byId = new Map(memories.map((item) => [item.id, item]));
  const audit = getAuditEvents(db, projectId, CONFIG.context.auditEventLimit);

  return [...requested]
    .map((id) => {
      const item = byId.get(id);
      if (!item) {
        return null;
      }
      return {
        item,
        auditEvents: audit.filter((event) => event.entity_id === id),
      };
    })
    .filter((entry): entry is MemoryLineageInput => entry !== null);
}

function renderContextXml(
  state: PromptContextState,
  projectId: string,
  fingerprint: string,
  pendingProposalCount: number,
): { xml: string; prefixChanged: boolean } {
  const { changed } = updatePrefixFingerprint(fingerprint);

  const parts = [compileStablePrefix(projectId), state.layer1];
  // Pending proposals alert (tells agent to use memory_list_proposals)
  parts.push(`<pending_proposals count="${pendingProposalCount}" />`);
  parts.push(compileMemoryEvidence(state.memoryEvidence));
  // Layer 2 always rendered (CacheAligner: stable structure)
  if (state.layer2Details.length > 0) {
    parts.push(compileLayer2Details(state.layer2Details));
  } else {
    parts.push('<memory_details count="0" />');
  }
  // Layer 3 always present (CacheAligner: stable structure)
  for (const lineage of state.layer3Lineages) {
    parts.push(compileLayer3Lineage(lineage));
  }
  if (state.layer3Lineages.length === 0) {
    parts.push("<memory_lineage />");
  }
  // Deferred details section (CCR: tells LLM what's retrievable)
  const ccrStore = getCcrStore();
  parts.push(compileDeferredSection(ccrStore));
  parts.push(STABLE_SUFFIX);
  return { xml: parts.join("\n"), prefixChanged: changed };
}

export function assembleMemoryContext(input: AssembleContextInput): AssembledContext {
  // Reset CCR store for new turn (CCR data is turn-isolated)
  resetCcrStore();

  const modelContextTokens = input.modelContextTokens ?? CONFIG.context.defaultModelTokens;
  const previous = input.state ?? createRuntimeContextState();
  const turn = previous.turn + 1;
  const openPaths = new Set(input.openPaths ?? []);
  const query = input.query?.trim() ?? "";
  const taskType = input.taskType ?? classifyTaskContext(query);
  const budgetRatio = budgetRatioForTask(taskType, input.memoryContextBudgetRatio);
  const budgetTokens = adaptiveBudget(modelContextTokens, taskType, input.memoryContextBudgetRatio);
  const evidenceMode = normalizedEvidenceMode(input.evidenceMode);
  const compressionPolicy = resolveCompressionPolicy(input.compressionPolicy);
  const requestedRetrievalRounds = normalizedRetrievalRounds(
    input.retrievalRounds,
    taskType,
    query,
  );

  const allActiveMemories = listAll(input.db, input.projectId, undefined, "active");
  const originalMemoryById = new Map(allActiveMemories.map((item) => [item.id, item]));
  const layer1 = compileLayer1Index(allActiveMemories, { projectId: input.projectId });

  // Fetch pending proposals count for agent review awareness
  const pendingProposals = listPendingProposals(input.db, input.projectId);
  const pendingProposalCount = pendingProposals.length;

  const { kept, evicted } = evictLruDetails(previous.activeDetails, turn, openPaths);
  const keptDetails = kept.map((detail) => ({ item: detail.item }));

  const semanticSelection = selectIterativeSemanticDetails({
    db: input.db,
    projectId: input.projectId,
    query,
    openPaths: input.openPaths ?? [],
    retrievalRounds: requestedRetrievalRounds,
    compressionPolicy,
  });
  const semanticDetails = semanticSelection.details;

  const codeDetails = (input.openPaths ?? []).flatMap((path) =>
    selectCodePathDetails(getMemoriesForCode(input.db, input.projectId, path)),
  );

  const operationalDetails =
    query && detectsOperationalContext(query) ? selectOperationalDetails(allActiveMemories) : [];

  const semanticIds = new Set(semanticDetails.map((detail) => detail.item.id));
  const codePathIds = new Set(codeDetails.map((detail) => detail.item.id));
  const operationalIds = new Set(operationalDetails.map((detail) => detail.item.id));

  const mergedDetails = mergeDetails([
    ...keptDetails,
    ...semanticDetails,
    ...codeDetails,
    ...operationalDetails,
  ]);
  const memoryEvidence = evidenceEnabled(evidenceMode, taskType)
    ? selectMemoryEvidence(mergedDetails, query, compressionPolicy)
    : [];
  const layer2Details = applyQueryAwareChunks(mergedDetails, query);
  const layer3Lineages = lineageForIds(
    input.db,
    input.projectId,
    allActiveMemories,
    input.includeLineageForIds ?? [],
  );

  const budgeted = enforceContextBudget(
    {
      layer1,
      memoryEvidence,
      layer2Details,
      layer3Lineages,
    },
    {
      modelContextTokens,
      budgetTokens,
      allIndexMemories: allActiveMemories,
      projectId: input.projectId,
    },
  );

  const selectedDetailIds = budgeted.state.layer2Details.map((detail) => detail.item.id);
  const activeDetails: ActiveDetail[] = budgeted.state.layer2Details.map((detail) => ({
    item: originalMemoryById.get(detail.item.id) ?? detail.item,
    lastReferencedTurn:
      selectedDetailIds.includes(detail.item.id) &&
      (semanticIds.has(detail.item.id) ||
        codePathIds.has(detail.item.id) ||
        operationalIds.has(detail.item.id))
        ? turn
        : (kept.find((keptDetail) => keptDetail.item.id === detail.item.id)?.lastReferencedTurn ??
          turn),
    source: detailSource(detail, semanticIds, codePathIds, operationalIds),
    openPath: detail.codeLinks?.[0]?.path,
  }));

  const renderableState = clearLayer3AtTurnEnd(budgeted.state);

  // CacheAligner: compute structural fingerprint for KV-cache stability
  const fingerprint = [
    input.projectId,
    String(allActiveMemories.length),
    String(budgeted.state.memoryEvidence?.length ?? 0),
    String(budgeted.state.layer2Details.length),
    String(budgeted.state.layer3Lineages.length),
    budgeted.compactedIndex ? "compact" : "full",
    `pending:${pendingProposalCount}`,
  ].join(":");

  const { xml, prefixChanged } = renderContextXml(
    budgeted.state,
    input.projectId,
    fingerprint,
    pendingProposalCount,
  );

  // Collect CCR stats
  const ccrStore = getCcrStore();
  const deferredDetails = [...ccrStore.deferred.values()];
  const evidence = budgeted.state.memoryEvidence ?? [];
  const contextAccuracySignals: ContextAccuracySignals = {
    evidenceMode,
    evidenceEnabled: evidenceEnabled(evidenceMode, taskType),
    queryTerms: queryTerms(query),
    retrievalSubqueries: semanticSelection.subqueries,
    selectedEvidenceCount: evidence.length,
  };

  return {
    xml,
    state: {
      turn,
      activeDetails: renderableState.layer2Details.length
        ? activeDetails.filter((detail) =>
            renderableState.layer2Details.some((rendered) => rendered.item.id === detail.item.id),
          )
        : activeDetails,
    },
    selectedDetailIds,
    lineageIds: budgeted.state.layer3Lineages.map((lineage) => lineage.item.id),
    evicted: [
      ...evicted.map((detail) => ({
        id: detail.item.id,
        layer: "layer2" as const,
        reason: "lru_or_closed_path",
      })),
      ...budgeted.evicted,
    ],
    compactedIndex: budgeted.compactedIndex,
    overBudget: budgeted.overBudget,
    taskType,
    budgetRatio,
    budgetTokens: budgeted.budgetTokens,
    estimatedPromptTokens: budgeted.estimatedPromptTokens,
    deferredDetails,
    ccrStats: {
      totalTokensSaved: ccrStore.totalTokensSaved,
      compressedCount: ccrStore.compressedCount,
      fullCount: ccrStore.fullCount,
      retrievableCount: ccrStore.deferred.size,
    },
    prefixChanged,
    pendingProposalCount,
    evidenceSpanCount: evidence.length,
    evidenceMemoryIds: [...new Set(evidence.map((span) => span.memoryId))],
    retrievalRounds: semanticSelection.roundsUsed,
    compressionPolicyId: compressionPolicy.id,
    contextAccuracySignals,
  };
}
