export interface TriMemhJson<T> {
  success: boolean;
  data: T;
}

export interface MemoryItem {
  id: string;
  kind: string;
  text: string;
  status?: string;
  confidence?: number;
  source?: string;
  visibility?: string;
  created_at?: string;
  updated_at?: string;
  expires_at?: string | null;
}

export interface RecallResult {
  item: MemoryItem;
  snippet?: string;
  score?: number;
  rank?: number;
}

export interface MemoryProposal {
  id: string;
  action?: string;
  proposed_kind?: string;
  proposed_text: string;
  proposed_by?: string;
  risk_level?: string;
  status?: string;
  rationale?: string | null;
  created_at?: string;
  decision_note?: string | null;
}

export interface TriMemhStatus {
  project_id?: string;
  db_path?: string;
  stats?: {
    total?: number;
    pendingProposals?: number;
    byKind?: Record<string, number>;
    byStatus?: Record<string, number>;
  };
  pendingProposals?: MemoryProposal[];
  recentAudit?: unknown[];
}

export interface ContextDiagnostics {
  selected_detail_ids?: string[];
  lineage_ids?: string[];
  over_budget?: boolean;
  task_type?: string;
  budget_ratio?: number;
  budget_tokens?: number;
  estimated_prompt_tokens?: number;
  evidence_span_count?: number;
  evidence_memory_ids?: string[];
  pending_proposal_count?: number;
}

export interface ContextResult {
  xml: string;
  diagnostics: ContextDiagnostics;
}

export interface CodeEntity {
  id?: string;
  entity_type?: string;
  path: string;
  symbol?: string | null;
  line_start?: number | null;
  line_end?: number | null;
  fingerprint?: string | null;
}

export interface MemoryCodeLink {
  id?: string;
  relation?: string;
  memory_id?: string;
  entity_id?: string;
}

export interface StaleMemoryReasonDetail {
  reason: string;
  description: string;
  entity?: CodeEntity;
  link?: MemoryCodeLink;
  details?: Record<string, unknown>;
}

export interface StaleMemoryResult {
  memory: MemoryItem;
  severity: "low" | "medium" | "high";
  suggested_action: string;
  reasons: StaleMemoryReasonDetail[];
}

export interface StaleMemoryReport {
  checked_at: string;
  results: StaleMemoryResult[];
  summary: {
    checked_memory_count: number;
    flagged_memory_count: number;
    high_count: number;
    medium_count: number;
    low_count: number;
  };
}

export type AtlasNodeKind = "memory" | "file" | "function" | "class" | "module" | "section";
export type AtlasEdgeKind = "memory_code" | "memory_memory" | "affected_path" | "stale_reason";

export interface AtlasNode {
  id: string;
  label: string;
  kind: AtlasNodeKind;
  path?: string;
  symbol?: string | null;
  severity?: "low" | "medium" | "high";
  memory?: MemoryItem;
  entity?: CodeEntity;
  staleReasons?: string[];
}

export interface AtlasEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: AtlasEdgeKind;
  confidence?: number;
}

export interface AtlasGraph {
  query: { path?: string; symbol?: string | null; depth: number };
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  stale?: StaleMemoryReport;
  summary: {
    node_count: number;
    edge_count: number;
    memory_count: number;
    code_count: number;
    stale_count: number;
  };
}

export type TreePayload =
  | { type: "memory"; memory: MemoryItem }
  | { type: "proposal"; proposal: MemoryProposal }
  | { type: "stale"; finding: StaleMemoryResult }
  | { type: "group"; id: string; label: string };
