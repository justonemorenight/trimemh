// ─── Service barrel — re-exports from sub-modules ─────────────────
// Backward-compatible: all imports from "./service" still work.

import { dedupMerge, dedupScan } from "./application/dedup-use-cases";
import { getMemoriesForCode, hybridRecall, recall } from "./application/recall-use-cases";

// Re-exports from application layer
export type { DedupReport } from "./application/dedup-use-cases";
export type { IndexOptions, IndexResult } from "./application/index-use-cases";
export { detectProjectMetaForSeed, indexProject } from "./application/index-use-cases";
export { seedProjectMemories } from "./application/project-seed";
// Claude review
export {
  buildClaudeReviewCommand,
  parseClaudeReviewOutput,
  runClaudeReview,
} from "./service/claude-review-service";
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
// Hook ingestion
export {
  HOOK_CAPTURE_EVENTS,
  captureHookEvent,
  normalizeHookPayload,
  parseHookEvent,
} from "./service/hook-service";
// Lifecycle operations
export {
  MEMORY_LIFECYCLE_STATES,
  detectMemoryConflicts,
  expireMemories,
  latestLifecycle,
  lifecycleEvents,
  proposalLifecycle,
  recordLifecycleEvent,
  supersedeMemory,
} from "./service/lifecycle-service";
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
  formatProjectMismatchWarnings,
  formatProposalResultExtras,
} from "./service/mcp-service";
// Normalized lifecycle event adapters
export {
  ClaudeCodeAdapter,
  CodexAdapter,
  GenericMemoryEventAdapter,
  adapterForAgent,
} from "./service/memory-event-adapter";
// Memory CRUD
export { forget, listAll, remember, rememberMany } from "./service/memory-service";
// Proposal workflow
export { approve, proposals, propose, reject, status } from "./service/proposal-service";
// Session workflows
export {
  buildSessionSummaryText,
  closeSession,
  listSessionRegistry,
  listSessionSummaries,
  registerSessionObservation,
  sessionHistory,
  summarizeSession,
} from "./service/session-service";
export { dedupMerge, dedupScan, getMemoriesForCode, hybridRecall, recall };
