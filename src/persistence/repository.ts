// ─── Repository barrel — re-exports from sub-modules ─────────────
// Backward-compatible: all imports from "./persistence/repository" still work.

// Code Entities + Links + Link Proposals
export {
  findCodeEntityByKey,
  findMemoryCodeLink,
  getCodeEntitiesForMemoryRows,
  getCodeEntityById,
  getMemoriesForCodeEntitiesRows,
  getMemoriesForCodeRows,
  getMemoryLinkProposalById,
  insertCodeEntity,
  insertMemoryCodeLink,
  insertMemoryLinkProposal,
  listCodeEntitiesForPath,
  updateMemoryLinkProposal,
} from "./code-link-repo";
// Memory Graph
export {
  findMemoryEdge,
  getMemoryEdgeById,
  getRelatedMemoryRows,
  insertMemoryEdge,
} from "./graph-repo";
export type {
  LifecycleEntityType,
  LifecycleState,
  MemoryLifecycleEvent,
  MemorySessionRecord,
} from "./lifecycle-repo";
// Lifecycle + session registry
export {
  getMemorySession,
  insertLifecycleEvent,
  latestLifecycleState,
  listLifecycleEvents,
  listMemorySessions,
  upsertMemorySession,
} from "./lifecycle-repo";
// Memory items
export {
  deleteMemoryItem,
  findMemoryByHash,
  getMemoriesWithEmbeddings,
  getMemoryById,
  insertMemoryItem,
  listMemoryItems,
  mergeMemoryEvidence,
  searchMemoryFts,
  updateMemoryItem,
} from "./memory-repo";
// Proposals + Audit + Stats
export {
  getAuditEvents,
  getMemoryStats,
  getProposalById,
  insertAuditEvent,
  insertProposal,
  listPendingProposals,
  listProposals,
  updateProposal,
} from "./proposal-repo";
