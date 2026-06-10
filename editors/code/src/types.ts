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
  created_at?: string;
  updated_at?: string;
}

export interface RecallResult {
  item: MemoryItem;
  snippet?: string;
  score?: number;
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
