import type { Database } from "bun:sqlite";

import { CONFIG } from "../config";
import type { MemoryItem } from "../domain/schema";
import { getAuditEvents } from "../persistence/repository";
import { embedText } from "../retrieval/embedding-provider";
import { vectorSearch } from "../retrieval/hybrid";
import { getMemoriesForCode, listAll } from "../service";
import type { DeferredDetail } from "./ccr";
import type {
  ActiveDetail,
  MemoryDetailInput,
  MemoryLineageInput,
  PromptContextState,
} from "./compiler";
import {
  STABLE_SUFFIX,
  clearLayer3AtTurnEnd,
  compileDeferredSection,
  compileLayer1Index,
  compileLayer2Details,
  compileLayer3Lineage,
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
  /** Whether the KV-cache prefix changed (CacheAligner) */
  prefixChanged: boolean;
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
): { xml: string; prefixChanged: boolean } {
  const { changed } = updatePrefixFingerprint(fingerprint);

  const parts = [compileStablePrefix(projectId), state.layer1];
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

  const allActiveMemories = listAll(input.db, input.projectId, undefined, "active");
  const layer1 = compileLayer1Index(allActiveMemories, { projectId: input.projectId });

  const { kept, evicted } = evictLruDetails(previous.activeDetails, turn, openPaths);
  const keptDetails = kept.map((detail) => ({ item: detail.item }));

  const semanticDetails = query
    ? selectSemanticDetails(
        vectorSearch(
          input.db,
          input.projectId,
          embedText(query),
          CONFIG.context.vectorSearchLimit,
        ).map((result) => ({
          item: result.item,
          similarity: result.similarity,
        })),
      )
    : [];

  const codeDetails = (input.openPaths ?? []).flatMap((path) =>
    selectCodePathDetails(getMemoriesForCode(input.db, input.projectId, path)),
  );

  const operationalDetails =
    query && detectsOperationalContext(query) ? selectOperationalDetails(allActiveMemories) : [];

  const semanticIds = new Set(semanticDetails.map((detail) => detail.item.id));
  const codePathIds = new Set(codeDetails.map((detail) => detail.item.id));
  const operationalIds = new Set(operationalDetails.map((detail) => detail.item.id));

  const layer2Details = mergeDetails([
    ...keptDetails,
    ...semanticDetails,
    ...codeDetails,
    ...operationalDetails,
  ]);
  const layer3Lineages = lineageForIds(
    input.db,
    input.projectId,
    allActiveMemories,
    input.includeLineageForIds ?? [],
  );

  const budgeted = enforceContextBudget(
    {
      layer1,
      layer2Details,
      layer3Lineages,
    },
    {
      modelContextTokens,
      allIndexMemories: allActiveMemories,
      projectId: input.projectId,
    },
  );

  const selectedDetailIds = budgeted.state.layer2Details.map((detail) => detail.item.id);
  const activeDetails: ActiveDetail[] = budgeted.state.layer2Details.map((detail) => ({
    item: detail.item,
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
    String(budgeted.state.layer2Details.length),
    String(budgeted.state.layer3Lineages.length),
    budgeted.compactedIndex ? "compact" : "full",
  ].join(":");

  const { xml, prefixChanged } = renderContextXml(budgeted.state, input.projectId, fingerprint);

  // Collect CCR stats
  const ccrStore = getCcrStore();
  const deferredDetails = [...ccrStore.deferred.values()];

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
    deferredDetails,
    ccrStats: {
      totalTokensSaved: ccrStore.totalTokensSaved,
      compressedCount: ccrStore.compressedCount,
      fullCount: ccrStore.fullCount,
      retrievableCount: ccrStore.deferred.size,
    },
    prefixChanged,
  };
}
