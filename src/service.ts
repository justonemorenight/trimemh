// ─── Service barrel — re-exports from sub-modules ─────────────────
// Backward-compatible: all imports from "./service" still work.

import type { DedupReport } from "./application/dedup-use-cases";
import { dedupMerge, dedupScan } from "./application/dedup-use-cases";
import { getMemoriesForCode, hybridRecall, recall } from "./application/recall-use-cases";

// Helpers
export { codeEntityKey } from "./service/helpers";

// Memory CRUD
export { forget, listAll, remember, rememberMany } from "./service/memory-service";

// Proposal workflow
export { approve, proposals, propose, reject, status } from "./service/proposal-service";

// Graph + Code links
export {
  approveMemoryLinkProposal,
  createMemoryCodeLink,
  createMemoryEdge,
  createOrGetCodeEntity,
  getRelatedMemories,
  proposeMemoryCodeLink,
  proposeMemoryEdge,
  rejectMemoryLinkProposal,
} from "./service/graph-service";

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

// Re-exports from application layer
export type { DedupReport };
export { dedupMerge, dedupScan, getMemoriesForCode, hybridRecall, recall };
