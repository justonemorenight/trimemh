/**
 * Global Configuration & Magic Numbers for tri-memory
 * Centralizes all hardcoded thresholds, array limits, model names, and config values.
 */

export const CONFIG = {
  api: {
    defaultPort: 3000,
    maxListLimit: 100,
    defaultListLimit: 10,
  },
  mcp: {
    port: 3100,
    maxSearchResults: 5,
    defaultSearchLimit: 10,
    maxSearchLimitSchema: 20,
    snippetLength: 80,
    shortIdLength: 8,
  },
  db: {
    busyTimeoutMs: 5000,
    cacheSizePages: -2000,
    walAutoCheckpointPages: 1000,
    journalSizeLimitBytes: 67108864,
    mmapSizeBytes: 268435456,
  },
  guardrails: {
    maxStringBytes: 10240,
    maxRequestBytes: 15360,
    maxOutputWords: 200,
    maxHttpSearchResults: 100,
  },
  compressionSafety: {
    minTokenSavingsForCompressedOutput: 8,
    maxCompressionInflationRatio: 1.05,
    criticalMarkerFallbackEnabled: true,
    fallbackExcerptWords: 220,
    libraryGeneratedPathPatterns: [
      "node_modules/",
      "vendor/",
      "dist/",
      "build/",
      ".next/",
      "coverage/",
      "bun.lock",
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      ".min.js",
    ],
  },
  cache: {
    memoryItemMaxSize: 500,
    queryDefaultTtlMs: 30000,
  },
  embedding: {
    defaultDimensions: 384,
    defaultProviderName: "local-hash-v1",
    onnxProviderName: "onnx-minilm-l6-v2",
    onnxModelPrefix: "onnx:",
  },
  agents: {
    defaultClaudeAgent: "claude-code",
  },
  retrieval: {
    crossAgentDumpLimit: 10000,
    feedbackLimit: 10000,
    feedbackPositiveScore: 0.2,
    feedbackNegativeScore: -0.15,
    rrfK: 60,
    expansionMaxSynonymsPerTerm: 2,
    expansionMaxTerms: 30,
    scoringRecencyHalfLifeHours: 168,
  },
  reranker: {
    crossEncodeWeight: 0.7,
    stageOneLimit: 20,
    stageTwoLimit: 5,
    minScore: 0.05,
  },
  service: {
    defaultSearchLimit: 10,
    defaultListLimit: 100,
    maxGraphDepth: 2,
    snippetLength: 200,
  },
  chunking: {
    maxChunkWords: 150,
    overlapSentences: 1,
    minWordsForChunking: 300,
    bm25K1: 1.2,
    bm25B: 0.75,
    maxDetailChunks: 3,
    detailWordBudget: 500,
  },
  codeIntel: {
    parserMaxEntities: 200,
    watcherDebounceMs: 2000,
    watcherMaxFileSizeBytes: 1000000,
  },
  logging: {
    maxModuleLength: 32,
    maxMessageLength: 1000,
    maxContextValueLength: 500,
  },
  zod: {
    maxMemoryText: 10000,
    maxMemoryRationale: 2000,
    maxQueryLength: 2000,
    maxLineageIds: 256,
    maxPathLength: 2000,
    maxSymbolLength: 512,
    maxFingerprintLength: 500,
    maxRelationLength: 100,
    maxEntityLength: 200,
  },
  rateLimit: {
    defaultConfig: { capacity: 30, refillRate: 5, label: "default" },
    tools: {
      memory_search: { capacity: 30, refillRate: 5, label: "memory_search" },
      memory_hybrid_search: { capacity: 20, refillRate: 3, label: "memory_hybrid_search" },
      memory_propose: { capacity: 10, refillRate: 1, label: "memory_propose" },
      memory_get: { capacity: 60, refillRate: 10, label: "memory_get" },
      memory_stats: { capacity: 20, refillRate: 5, label: "memory_stats" },
      memory_related: { capacity: 20, refillRate: 5, label: "memory_related" },
      memory_code_search: { capacity: 20, refillRate: 5, label: "memory_code_search" },
      memory_link_propose: { capacity: 10, refillRate: 1, label: "memory_link_propose" },
      memory_code_link_propose: { capacity: 10, refillRate: 1, label: "memory_code_link_propose" },
      memory_list_proposals: { capacity: 20, refillRate: 5, label: "memory_list_proposals" },
      memory_approve: { capacity: 15, refillRate: 3, label: "memory_approve" },
      memory_reject: { capacity: 15, refillRate: 3, label: "memory_reject" },
    },
  },
  context: {
    defaultModelTokens: 32000,
    maxModelTokens: 1000000,
    minModelTokens: 1000,
    auditEventLimit: 200,
    vectorSearchLimit: 20,
  },
  ccr: {
    shortThresholdWords: 300,
    mediumThresholdWords: 1000,
    mediumDisplayWords: 80,
    longDisplayWords: 40,
    fullTextMaxWords: 300,
  },
  contentRouter: {
    minNonProseConfidence: 0.35,
    codeSignatureLines: 30,
  },
  codeCompressor: {
    maxAstSummaryLines: 60,
    maxClassMembers: 14,
    maxNestedSymbols: 24,
    maxImportantLiterals: 12,
    maxUnionTypes: 8,
    maxInterfaceMembers: 8,
  },
  autoApprove: {
    /** Master switch — when true, low/medium-risk MCP proposals auto-approve by default. */
    enabled: true,
    /** Auto-approve proposals at or below this risk level.
     *  "low" = only low risk auto-approved
     *  "medium" = low + medium auto-approved (default)
     *  "high" = low + medium + high auto-approved
     *  "all" or "critical" = everything auto-approved */
    maxRiskLevel: "medium",
    /** Minimum confidence (0-1) for auto-approval. */
    minConfidence: 0.3,
    /** Whether to auto-approve link proposals (memory edges + code links). */
    autoApproveLinks: true,
  },
};
