import type { MemoryKind } from "../domain/schema";

export type MemhFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface MemhClientOptions {
  baseUrl?: string;
  projectId?: string;
  fetch?: MemhFetch;
}

export interface ContextRequest {
  query?: string;
  openPaths?: string[];
  includeLineageForIds?: string[];
  modelContextTokens?: number;
}

export interface ContextResponse {
  xml: string;
  selected_detail_ids: string[];
  lineage_ids: string[];
  evicted: unknown[];
  compacted_index: boolean;
  over_budget: boolean;
  state: {
    turn: number;
    active_detail_ids: string[];
  };
}

export interface SearchRequest {
  query?: string;
  vector?: number[];
  mode?: "fts" | "vector" | "hybrid";
  limit?: number;
}

export interface ProposalRequest {
  kind: MemoryKind;
  text: string;
  action?: "create" | "update" | "delete";
  targetMemoryId?: string;
  proposedBy?: string;
  rationale?: string;
  evidence?: Array<{ source: string; reference: string; note?: string }>;
}

export class MemhClient {
  readonly baseUrl: string;
  readonly projectId?: string;
  private readonly fetchImpl: MemhFetch;

  constructor(options: MemhClientOptions = {}) {
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
    this.projectId = options.projectId;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async context(input: ContextRequest = {}): Promise<ContextResponse> {
    const body = {
      query: input.query,
      openPaths: input.openPaths,
      includeLineageForIds: input.includeLineageForIds,
      modelContextTokens: input.modelContextTokens,
    };
    const response = await this.request<{ data: ContextResponse }>("/api/context/assemble", {
      method: "POST",
      body,
    });
    return response.data;
  }

  async search(input: SearchRequest): Promise<unknown[]> {
    const response = await this.request<{ data: unknown[] }>("/api/memories/recall", {
      method: "POST",
      body: {
        mode: input.mode ?? "hybrid",
        query: input.query,
        vector: input.vector,
        limit: input.limit,
      },
    });
    return response.data;
  }

  async retrieve(memoryId: string): Promise<unknown> {
    const response = await this.request<{ data: unknown }>(
      `/api/memories/${encodeURIComponent(memoryId)}`,
      {
        method: "GET",
      },
    );
    return response.data;
  }

  async propose(input: ProposalRequest): Promise<unknown> {
    const response = await this.request<{ data: unknown }>("/api/proposals", {
      method: "POST",
      body: {
        kind: input.kind,
        text: input.text,
        action: input.action,
        targetMemoryId: input.targetMemoryId,
        proposed_by: input.proposedBy,
        rationale: input.rationale,
        evidence: input.evidence,
      },
    });
    return response.data;
  }

  private async request<T>(
    path: string,
    options: { method: string; body?: Record<string, unknown> },
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    const init: RequestInit = { method: options.method, headers };
    if (options.body) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    if (this.projectId) {
      headers["X-Memh-Project-Id"] = this.projectId;
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    const payload = (await response.json().catch(() => null)) as {
      success?: boolean;
      error?: string;
    } | null;
    if (!response.ok || payload?.success === false) {
      const message = payload?.error ?? `triMemh API request failed with HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload as T;
  }
}
