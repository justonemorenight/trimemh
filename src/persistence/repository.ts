// ─── Repository barrel — re-exports from sub-modules ─────────────
// Backward-compatible: all imports from "./persistence/repository" still work.

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

// Memory Graph
export {
  findMemoryEdge,
  getMemoryEdgeById,
  getRelatedMemoryRows,
  insertMemoryEdge,
} from "./graph-repo";

// Code Entities + Links + Link Proposals
export {
  findCodeEntityByKey,
  findMemoryCodeLink,
  getCodeEntityById,
  getMemoriesForCodeRows,
  getMemoryLinkProposalById,
  insertCodeEntity,
  insertMemoryCodeLink,
  insertMemoryLinkProposal,
  updateMemoryLinkProposal,
} from "./code-link-repo";
