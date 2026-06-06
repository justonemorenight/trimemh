// ─── Service barrel — re-exports from sub-modules ─────────────────
// Backward-compatible: all imports from "./service" still work.

import { dedupMerge, dedupScan } from "./application/dedup-use-cases";
import { getMemoriesForCode, hybridRecall, recall } from "./application/recall-use-cases";

// Graph + Code links
export {
  approveMemoryLinkProposal,
  createMemoryCodeLink,
  createMemoryEdge,
  createOrGetCodeEntity,
  getCodeImpact,
  getRelatedMemories,
  proposeMemoryCodeLink,
  proposeMemoryEdge,
  rejectMemoryLinkProposal,
} from "./service/graph-service";
// Helpers
export { codeEntityKey } from "./service/helpers";
// MCP-facing calls
export {
  mcpCodeSearch,
  mcpGet,
  mcpHybridSearch,
  mcpMemoryCodeLinkPropose,
  mcpMemoryLinkPropose,
  mcpPropose,
  mcpRelated,
  mcpRetrieveFull,
  mcpSearch,
  mcpStats,
} from "./service/mcp-service";
// Memory CRUD
export { forget, listAll, remember, rememberMany } from "./service/memory-service";
// Proposal workflow
export { approve, proposals, propose, reject, status } from "./service/proposal-service";
// Re-exports from application layer
export type { DedupReport } from "./application/dedup-use-cases";
export type { IndexOptions, IndexResult } from "./application/index-use-cases";
export { detectProjectMetaForSeed, indexProject } from "./application/index-use-cases";
export { seedProjectMemories } from "./application/project-seed";
export { dedupMerge, dedupScan, getMemoriesForCode, hybridRecall, recall };
