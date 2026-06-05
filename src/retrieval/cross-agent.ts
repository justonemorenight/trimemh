/**
 * Cross-Agent SharedContext (P2 — Agent Intelligence)
 *
 * Enables memory sharing and deduplication across multiple agent instances.
 * Inspired by headroom's SharedContext: multiple agents (Claude Code, Codex,
 * Cursor, Aider, Copilot CLI) can share a memory space with provenance tracking.
 *
 * Architecture:
 *   1. Visibility model: private (agent-only), team (shared), public (global)
 *   2. Agent provenance: each memory tagged with source_agent
 *   3. Cross-agent dedup: find duplicates across agents with lower threshold
 *   4. Agent identity: detected from env (CLAUDE_CODE_SESSION, etc.)
 *
 * Cross-agent dedup uses a LOWER threshold (0.85) than same-agent dedup
 * because different agents phrase things differently — the same underlying
 * knowledge expressed by Claude vs Codex will have lower cosine similarity.
 */

import type { Database } from "bun:sqlite";

import type { MemoryItem } from "../domain/schema";
import { getMemoriesWithEmbeddings } from "../persistence/repository";
import {
  SEMANTIC_DEDUP_MIN_DIMENSION,
  dedupThresholdForKind,
  findSemanticDuplicates,
} from "./dedup";
import { cosineSimilarity } from "./embedding";

// ─── Types ──────────────────────────────────────────────────────────

export interface AgentIdentity {
  /** Agent name: "claude-code", "codex", "cursor", "aider", "copilot" */
  agent: string;
  /** Session identifier (env-provided) */
  sessionId: string;
  /** When this agent joined the shared context */
  joinedAt: string;
}

export interface CrossAgentDuplicate {
  /** The query memory (from current agent) */
  query: { id?: string; text: string; kind: string; agent: string };
  /** The existing memory (from another agent) */
  existing: MemoryItem;
  /** Cosine similarity between the two */
  similarity: number;
  /** The kind-specific threshold used */
  thresholdUsed: number;
  /** The agent that owns the existing memory */
  existingAgent: string;
}

export interface SharedContextStats {
  /** Total memories in shared context */
  totalMemories: number;
  /** Breakdown by source agent */
  byAgent: Record<string, number>;
  /** Breakdown by visibility */
  byVisibility: Record<string, number>;
  /** Cross-agent duplicate pairs found */
  crossAgentDuplicates: number;
}

// ─── Agent identity detection ───────────────────────────────────────

/**
 * Detect the current agent identity from environment variables.
 * Supports common AI coding agent env patterns.
 */
export function detectAgentIdentity(): AgentIdentity {
  const sessionId =
    process.env.CLAUDE_CODE_SESSION_ID ??
    process.env.CODEX_SESSION_ID ??
    process.env.CURSOR_SESSION_ID ??
    process.env.AIDER_SESSION_ID ??
    process.env.COPILOT_SESSION_ID ??
    `session-${Date.now()}`;

  let agent = "unknown";
  if (process.env.CLAUDE_CODE_SESSION_ID) {
    agent = "claude-code";
  } else if (process.env.CODEX_SESSION_ID) {
    agent = "codex";
  } else if (process.env.CURSOR_SESSION_ID) {
    agent = "cursor";
  } else if (process.env.AIDER_SESSION_ID) {
    agent = "aider";
  } else if (process.env.COPILOT_SESSION_ID) {
    agent = "copilot";
  } else if (process.env.TRIMEMH_AGENT_ID) {
    agent = process.env.TRIMEMH_AGENT_ID;
  }

  return {
    agent,
    sessionId,
    joinedAt: new Date().toISOString(),
  };
}

/**
 * Extract agent identity from memory metadata.
 */
export function agentFromMemory(memory: MemoryItem): string {
  try {
    const metadata = JSON.parse(memory.metadata_json);
    return metadata.source_agent ?? metadata.agent ?? memory.source ?? "unknown";
  } catch {
    return memory.source ?? "unknown";
  }
}

// ─── Cross-agent dedup ──────────────────────────────────────────────

/**
 * Find semantic duplicates of a new memory across memories from OTHER agents.
 *
 * Cross-agent threshold is 0.85 (lower than default 0.90) because different
 * agents phrase the same knowledge differently. However, we still apply the
 * kind-specific threshold of the existing memory as a ceiling.
 */
export function findCrossAgentDuplicates(
  db: Database,
  projectId: string,
  embedding: Float32Array,
  currentAgent: string,
  opts: {
    threshold?: number;
    /** Limit to specific visibility levels */
    visibility?: Array<"team" | "public">;
  } = {},
): CrossAgentDuplicate[] {
  if (embedding.length < SEMANTIC_DEDUP_MIN_DIMENSION) {
    return [];
  }

  const candidates = getMemoriesWithEmbeddings(db, projectId)
    .filter((c) => {
      const agent = agentFromMemory(c.item);
      return agent !== currentAgent;
    })
    .filter((c) => {
      if (!opts.visibility) {
        return true;
      }
      return opts.visibility.includes(c.item.visibility as "team" | "public");
    });

  if (candidates.length === 0) {
    return [];
  }

  // Cross-agent threshold is lower than same-agent
  const crossAgentThreshold = opts.threshold ?? 0.85;
  const dups = findSemanticDuplicates(embedding, candidates, crossAgentThreshold);

  return dups.map((d) => ({
    query: {
      text: "", // filled in by caller
      kind: "",
      agent: currentAgent,
    },
    existing: d.existing,
    similarity: d.similarity,
    thresholdUsed: Math.max(crossAgentThreshold, dedupThresholdForKind(d.existing.kind)),
    existingAgent: agentFromMemory(d.existing),
  }));
}

// ─── Shared context stats ───────────────────────────────────────────

/**
 * Compute shared context statistics across all agents in a project.
 */
export function sharedContextStats(db: Database, projectId: string): SharedContextStats {
  // biome-ignore lint/style/noCommonJs: circular dependency workaround
  const { listMemories } = require("./repository");
  const memories: MemoryItem[] = listMemories(db, projectId, { limit: 10_000 });

  const byAgent: Record<string, number> = {};
  const byVisibility: Record<string, number> = { private: 0, team: 0, public: 0 };

  for (const memory of memories) {
    const agent = agentFromMemory(memory);
    byAgent[agent] = (byAgent[agent] ?? 0) + 1;
    byVisibility[memory.visibility] = (byVisibility[memory.visibility] ?? 0) + 1;
  }

  // Count cross-agent duplicates (expensive: O(n²), run sparingly)
  let crossAgentDuplicates = 0;
  const candidates = getMemoriesWithEmbeddings(db, projectId);
  const seen = new Set<string>();
  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i];
    if (!a) {
      continue;
    }
    const agentA = agentFromMemory(a.item);
    for (let j = i + 1; j < candidates.length; j++) {
      const b = candidates[j];
      if (!b) {
        continue;
      }
      const agentB = agentFromMemory(b.item);
      if (agentA === agentB) {
        continue; // only cross-agent
      }
      if (a.embedding.length !== b.embedding.length) {
        continue;
      }

      const sim = cosineSimilarity(a.embedding, b.embedding);
      if (sim >= 0.9) {
        const key = [a.item.id, b.item.id].sort().join("::");
        if (!seen.has(key)) {
          seen.add(key);
          crossAgentDuplicates++;
        }
      }
    }
  }

  return {
    totalMemories: memories.length,
    byAgent,
    byVisibility,
    crossAgentDuplicates,
  };
}

// ─── Agent-aware memory stamping ────────────────────────────────────

/**
 * Stamp a memory with the current agent's identity before saving.
 * Call this before insertMemoryItem to enable cross-agent provenance.
 */
export function stampAgentProvenance(
  metadata: Record<string, unknown>,
  agent?: AgentIdentity,
): Record<string, unknown> {
  const identity = agent ?? detectAgentIdentity();
  return {
    ...metadata,
    source_agent: identity.agent,
    agent_session_id: identity.sessionId,
    agent_joined_at: identity.joinedAt,
  };
}

/**
 * Check if two memories come from different agents.
 */
export function isCrossAgent(a: MemoryItem, b: MemoryItem): boolean {
  return agentFromMemory(a) !== agentFromMemory(b);
}
