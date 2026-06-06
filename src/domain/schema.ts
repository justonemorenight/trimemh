import { z } from "zod";

// ─── Enums / constants ────────────────────────────────────────────

export const MEMORY_KINDS = [
  "preference",
  "fact",
  "decision",
  "session_summary",
  "code_context",
  "procedure",
  "mistake",
  "trade_rule",
  "security_rule",
] as const;

export const MEMORY_STATUSES = ["active", "archived", "expired"] as const;
export const VISIBILITY = ["private", "team", "public"] as const;
export const PROPOSAL_ACTIONS = ["create", "update", "delete"] as const;
export const PROPOSAL_STATUSES = ["pending", "approved", "rejected"] as const;
export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export const MEMORY_EDGE_RELATIONS = [
  "supports",
  "contradicts",
  "depends_on",
  "derived_from",
  "supersedes",
  "relates_to",
] as const;
export const CODE_ENTITY_TYPES = ["file", "function", "class", "module", "section"] as const;
export const CODE_LINK_RELATIONS = [
  "relates_to",
  "documents",
  "warns_about",
  "implements",
  "depends_on",
] as const;
export const LINK_PROPOSAL_TYPES = ["memory_edge", "memory_code_link"] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export type Visibility = (typeof VISIBILITY)[number];
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number];
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type MemoryEdgeRelation = (typeof MEMORY_EDGE_RELATIONS)[number];
export type CodeEntityType = (typeof CODE_ENTITY_TYPES)[number];
export type CodeLinkRelation = (typeof CODE_LINK_RELATIONS)[number];
export type LinkProposalType = (typeof LINK_PROPOSAL_TYPES)[number];

// ─── Risk mapping: kind → default risk level ─────────────────────

export const KIND_RISK_MAP: Record<MemoryKind, RiskLevel> = {
  preference: "low",
  fact: "low",
  decision: "medium",
  session_summary: "medium",
  code_context: "medium",
  procedure: "high",
  mistake: "high",
  trade_rule: "critical",
  security_rule: "critical",
};

// ─── Zod schemas ──────────────────────────────────────────────────

export const EvidenceSchema = z.object({
  source: z.string(),
  reference: z.string(),
  note: z.string().optional(),
});

export type Evidence = z.infer<typeof EvidenceSchema>;

export const MemoryItemSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  kind: z.enum(MEMORY_KINDS),
  text: z.string().min(1),
  status: z.enum(MEMORY_STATUSES).default("active"),
  visibility: z.enum(VISIBILITY).default("private"),
  confidence: z.number().min(0).max(1).default(0.5),
  source: z.string(),
  content_hash: z.string(),
  evidence_json: z.string().default("[]"),
  metadata_json: z.string().default("{}"),
  embedding: z.null().default(null),
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string().nullable().default(null),
});

// Raw Zod inference types embedding as `null` (valid for input validation).
// The runtime DB layer carries SQLite BLOB bytes. Vector code deserializes
// those bytes into Float32Array only when similarity scoring needs it.
export type MemoryItem = Omit<z.infer<typeof MemoryItemSchema>, "embedding"> & {
  embedding: Uint8Array | null;
};

export const MemoryProposalSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  action: z.enum(PROPOSAL_ACTIONS),
  target_memory_id: z.string().nullable().default(null),
  proposed_kind: z.enum(MEMORY_KINDS),
  proposed_text: z.string().min(1),
  proposed_by: z.string(),
  risk_level: z.enum(RISK_LEVELS),
  status: z.enum(PROPOSAL_STATUSES).default("pending"),
  rationale: z.string().nullable().default(null),
  evidence_json: z.string().default("[]"),
  created_at: z.string(),
  decided_at: z.string().nullable().default(null),
  decided_by: z.string().nullable().default(null),
  decision_note: z.string().nullable().default(null),
});

export type MemoryProposal = z.infer<typeof MemoryProposalSchema>;

export const AuditEventSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  actor: z.string(),
  event_type: z.string(),
  entity_type: z.string(),
  entity_id: z.string(),
  payload_json: z.string().default("{}"),
  created_at: z.string(),
});

export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const MemoryEdgeSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  source_memory_id: z.string(),
  target_memory_id: z.string(),
  relation: z.enum(MEMORY_EDGE_RELATIONS),
  confidence: z.number().min(0).max(1).default(0.5),
  source: z.string(),
  rationale: z.string().nullable().default(null),
  evidence_json: z.string().default("[]"),
  metadata_json: z.string().default("{}"),
  created_at: z.string(),
  updated_at: z.string(),
});

export type MemoryEdge = z.infer<typeof MemoryEdgeSchema>;

export const CodeEntitySchema = z.object({
  id: z.string(),
  project_id: z.string(),
  entity_key: z.string(),
  entity_type: z.enum(CODE_ENTITY_TYPES),
  path: z.string().min(1),
  symbol: z.string().nullable().default(null),
  line_start: z.number().int().nullable().default(null),
  line_end: z.number().int().nullable().default(null),
  fingerprint: z.string().nullable().default(null),
  metadata_json: z.string().default("{}"),
  created_at: z.string(),
  updated_at: z.string(),
});

export type CodeEntity = z.infer<typeof CodeEntitySchema>;

export const MemoryCodeLinkSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  memory_id: z.string(),
  entity_id: z.string(),
  relation: z.enum(CODE_LINK_RELATIONS),
  confidence: z.number().min(0).max(1).default(0.5),
  source: z.string(),
  rationale: z.string().nullable().default(null),
  evidence_json: z.string().default("[]"),
  metadata_json: z.string().default("{}"),
  created_at: z.string(),
  updated_at: z.string(),
});

export type MemoryCodeLink = z.infer<typeof MemoryCodeLinkSchema>;

export const MemoryLinkProposalSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  proposal_type: z.enum(LINK_PROPOSAL_TYPES),
  source_memory_id: z.string().nullable().default(null),
  target_memory_id: z.string().nullable().default(null),
  entity_type: z.enum(CODE_ENTITY_TYPES).nullable().default(null),
  path: z.string().nullable().default(null),
  symbol: z.string().nullable().default(null),
  line_start: z.number().int().nullable().default(null),
  line_end: z.number().int().nullable().default(null),
  fingerprint: z.string().nullable().default(null),
  relation: z.string(),
  confidence: z.number().min(0).max(1).default(0.5),
  proposed_by: z.string(),
  status: z.enum(PROPOSAL_STATUSES).default("pending"),
  rationale: z.string().nullable().default(null),
  evidence_json: z.string().default("[]"),
  created_at: z.string(),
  decided_at: z.string().nullable().default(null),
  decided_by: z.string().nullable().default(null),
  decision_note: z.string().nullable().default(null),
});

export type MemoryLinkProposal = z.infer<typeof MemoryLinkProposalSchema>;

// ─── Input / output types for service layer ───────────────────────

export interface RememberInput {
  kind: MemoryKind;
  text: string;
  projectId: string;
  visibility?: Visibility;
  confidence?: number;
  source?: string;
  evidence?: Evidence[];
  metadata?: Record<string, unknown>;
  expiresAt?: string;
  /** Float32Array embedding vector for semantic search (SDD-02) */
  embedding?: Float32Array;
}

export interface ProposeInput {
  kind: MemoryKind;
  text: string;
  projectId: string;
  proposedBy: string;
  rationale?: string;
  evidence?: Evidence[];
  action?: ProposalAction;
  targetMemoryId?: string;
  /** SDD-05 §6.1.1: SHA-256 of sorted tool arguments for audit integrity */
  argumentsHash?: string;
  /** Agent explicitly requests manual review (bypasses auto-approve). */
  requireReview?: boolean;
  /** Confidence 0-1, used for auto-approve threshold. */
  confidence?: number;
}

export interface CreateMemoryEdgeInput {
  projectId: string;
  sourceMemoryId: string;
  targetMemoryId: string;
  relation: MemoryEdgeRelation;
  confidence?: number;
  source?: string;
  rationale?: string;
  evidence?: Evidence[];
  metadata?: Record<string, unknown>;
}

export interface ProposeMemoryEdgeInput extends CreateMemoryEdgeInput {
  proposedBy: string;
  /** SDD-05 §6.1.1: SHA-256 of sorted tool arguments for audit integrity */
  argumentsHash?: string;
  /** Agent explicitly requests manual review (bypasses auto-approve). */
  requireReview?: boolean;
}

export interface CodeEntityInput {
  projectId: string;
  entityType: CodeEntityType;
  path: string;
  symbol?: string;
  lineStart?: number;
  lineEnd?: number;
  fingerprint?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateMemoryCodeLinkInput extends CodeEntityInput {
  memoryId: string;
  relation: CodeLinkRelation;
  confidence?: number;
  source?: string;
  rationale?: string;
  evidence?: Evidence[];
  metadata?: Record<string, unknown>;
}

export interface ProposeMemoryCodeLinkInput extends CreateMemoryCodeLinkInput {
  proposedBy: string;
  /** SDD-05 §6.1.1: SHA-256 of sorted tool arguments for audit integrity */
  argumentsHash?: string;
  /** Agent explicitly requests manual review (bypasses auto-approve). */
  requireReview?: boolean;
}

export interface RelatedMemoryResult {
  item: MemoryItem;
  edge: MemoryEdge;
  depth: number;
  direction: "incoming" | "outgoing";
}

export interface CodeMemoryResult {
  item: MemoryItem;
  entity: CodeEntity;
  link: MemoryCodeLink;
}

export interface RecallExplanation {
  why_selected: string[];
  composite_score: number;
  factors: {
    similarity: number;
    recency: number;
    confidence: number;
    access: number;
    feedback: number;
    ftsBoost: number;
    riskBoost: number;
    graphBoost: number;
    codePathBoost: number;
  };
  signals: {
    task_type: string;
    retrieval_mode: "fts" | "vector" | "hybrid";
    original_rank: number;
    fts_rank: number;
    graph_degree: number;
    feedback_score: number;
    access_count: number;
    code_path_match: boolean;
    operational_context: boolean;
  };
}

export interface RecallResult {
  item: MemoryItem;
  rank: number;
  snippet: string;
  explanation?: RecallExplanation;
}

export interface CodeImpactMemory {
  item: MemoryItem;
  link: MemoryCodeLink;
}

export interface CodeImpactRelatedMemory {
  item: MemoryItem;
  edge: MemoryEdge;
  direction: "incoming" | "outgoing";
  depth: number;
}

export interface CodeImpactPath {
  entity: CodeEntity;
  memory_id: string;
  relation: CodeLinkRelation;
}

export interface CodeImpactResult {
  query: {
    path: string;
    symbol: string | null;
  };
  entities: CodeEntity[];
  linked_memories: CodeImpactMemory[];
  related_memories: CodeImpactRelatedMemory[];
  affected_paths: CodeImpactPath[];
  summary: {
    entity_count: number;
    linked_memory_count: number;
    related_memory_count: number;
    affected_path_count: number;
  };
}

export interface MemoryStats {
  total: number;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
  pendingProposals: number;
}

export interface McpSearchResult {
  id: string;
  kind: MemoryKind;
  text: string;
  snippet: string;
  confidence: number;
  source: string;
  created_at: string;
  explanation?: RecallExplanation;
  related?: Array<{
    id: string;
    kind: MemoryKind;
    text: string;
    relation: MemoryEdgeRelation;
    direction: "incoming" | "outgoing";
  }>;
}

export interface McpProposalResult {
  proposal_id: string;
  status: ProposalStatus;
  risk_level: RiskLevel;
  message: string;
}

export interface McpLinkProposalResult {
  proposal_id: string;
  status: ProposalStatus;
  proposal_type: LinkProposalType;
  message: string;
}

// ─── Config ───────────────────────────────────────────────────────

export interface TriMemhConfig {
  projectId: string;
  dbPath: string;
  autoApproveRisk?: RiskLevel;
}
