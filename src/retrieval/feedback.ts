/**
 * Agent Feedback Loop (P2 — Agent Intelligence)
 *
 * Agents report whether a retrieved memory was useful. This feedback
 * accumulates in the memory's metadata and feeds into the scoring
 * pipeline, creating a self-improving recall system.
 *
 * Architecture:
 *   Agent retrieves memories → uses them → reports feedback via MCP
 *     → feedback_score updated (exponential moving average)
 *     → scoring.ts reads feedback_score for future rankings
 *     → high-feedback memories rise, low-feedback memories decay
 *
 * The feedback loop is UNSUPERVISED — agents self-report without
 * human intervention. This scales across many agents and sessions.
 */

import type { Database } from "bun:sqlite";

import { audit } from "../application/service-helpers";
import { CONFIG } from "../config";
import { getMemoryById, updateMemoryItem } from "../persistence/repository";

// ─── Types ──────────────────────────────────────────────────────────

export interface FeedbackInput {
  /** Memory ID to rate */
  memoryId: string;
  /** Was the memory useful for the current task? */
  useful: boolean;
  /** Agent-provided reason (for audit) */
  reason?: string;
  /** Which agent provided this feedback */
  actor: string;
  /** Project context */
  projectId: string;
}

export interface FeedbackResult {
  memoryId: string;
  /** Previous feedback score */
  previousScore: number;
  /** New feedback score (after EMA update) */
  newScore: number;
  /** Number of feedback events this memory has received */
  totalFeedbackEvents: number;
  /** Direction of change */
  direction: "improved" | "degraded" | "unchanged";
}

// ─── Configuration ──────────────────────────────────────────────────

const FEEDBACK_CONFIG = {
  /** EMA alpha — weight of new feedback vs historical (0-1).
   *  0.15 means new feedback contributes 15%, history 85%.
   *  Low alpha = stable scores, resistant to noise. */
  alpha: 0.15,
  /** Feedback applied when useful=true */
  positiveFeedback: CONFIG.retrieval.feedbackPositiveScore,
  /** Feedback applied when useful=false */
  negativeFeedback: CONFIG.retrieval.feedbackNegativeScore,
  /** Score floor */
  minScore: -1.0,
  /** Score ceiling */
  maxScore: 1.0,
} as const;

// ─── Core logic ─────────────────────────────────────────────────────

/**
 * Apply agent feedback to a memory's feedback_score.
 *
 * Uses Exponential Moving Average (EMA):
 *   newScore = (1 - alpha) * oldScore + alpha * feedback
 *
 * Where feedback = +0.2 for useful, -0.15 for not useful.
 * The asymmetry (0.2 vs -0.15) makes the system slightly optimistic —
 * it takes more negative feedback to cancel one positive feedback.
 */
export function applyFeedback(db: Database, input: FeedbackInput): FeedbackResult {
  const memory = getMemoryById(db, input.memoryId);
  if (!memory) {
    throw new Error(`Memory "${input.memoryId}" not found.`);
  }
  if (memory.project_id !== input.projectId) {
    throw new Error(`Memory "${input.memoryId}" belongs to a different project.`);
  }

  // Parse existing metadata
  const metadata = JSON.parse(memory.metadata_json);
  const oldScore: number = metadata.feedback_score ?? 0;
  const events: number = (metadata.feedback_events ?? 0) + 1;

  // Compute feedback value
  const feedbackValue = input.useful
    ? FEEDBACK_CONFIG.positiveFeedback
    : FEEDBACK_CONFIG.negativeFeedback;

  // Exponential moving average
  const newScore = clamp(
    oldScore * (1 - FEEDBACK_CONFIG.alpha) + feedbackValue * FEEDBACK_CONFIG.alpha,
    FEEDBACK_CONFIG.minScore,
    FEEDBACK_CONFIG.maxScore,
  );

  // Update metadata
  const updatedMetadata = {
    ...metadata,
    feedback_score: Math.round(newScore * 10_000) / 10_000,
    feedback_events: events,
    last_feedback_at: new Date().toISOString(),
    last_feedback_useful: input.useful,
    last_feedback_actor: input.actor,
  };

  memory.metadata_json = JSON.stringify(updatedMetadata);
  memory.updated_at = new Date().toISOString();

  updateMemoryItem(db, memory);

  // Audit
  audit(db, input.projectId, input.actor, "memory_feedback", "memory_item", input.memoryId, {
    useful: input.useful,
    reason: input.reason ?? "",
    previous_score: oldScore,
    new_score: newScore,
    events,
  });

  return {
    memoryId: input.memoryId,
    previousScore: Math.round(oldScore * 10_000) / 10_000,
    newScore: Math.round(newScore * 10_000) / 10_000,
    totalFeedbackEvents: events,
    direction:
      newScore > oldScore + 0.001
        ? "improved"
        : newScore < oldScore - 0.001
          ? "degraded"
          : "unchanged",
  };
}

/**
 * Get the current feedback score for a memory.
 * Returns 0 if no feedback has been recorded.
 */
export function getFeedbackScore(db: Database, memoryId: string): number {
  const memory = getMemoryById(db, memoryId);
  if (!memory) {
    return 0;
  }
  try {
    const metadata = JSON.parse(memory.metadata_json);
    return metadata.feedback_score ?? 0;
  } catch {
    return 0;
  }
}

// ─── Batch feedback ─────────────────────────────────────────────────

/**
 * Apply feedback to multiple memories at once.
 * Useful when an agent used several memories in one turn.
 */
export function applyBatchFeedback(
  db: Database,
  projectId: string,
  feedbacks: Array<{ memoryId: string; useful: boolean; reason?: string }>,
  actor: string,
): FeedbackResult[] {
  return feedbacks.map((f) =>
    applyFeedback(db, {
      memoryId: f.memoryId,
      useful: f.useful,
      reason: f.reason,
      actor,
      projectId,
    }),
  );
}

// ─── Feedback decay (for stale memories) ────────────────────────────

/**
 * Apply automatic decay to memories that haven't received feedback
 * in a long time. This prevents stale memories from retaining high
 * feedback scores indefinitely.
 *
 * Decay formula: score *= e^(-daysIdle / halfLifeDays)
 * Half-life: 30 days (a memory with no feedback for 30 days loses half its score)
 */
export function decayStaleFeedback(db: Database, projectId: string, halfLifeDays = 30): number {
  // biome-ignore lint/style/noCommonJs: circular dependency workaround
  const { listMemoryItems } = require("../persistence/repository");
  const memories = listMemoryItems(db, projectId, {
    status: "active",
    limit: CONFIG.retrieval.feedbackLimit,
  });
  let decayed = 0;
  const now = Date.now();

  for (const memory of memories) {
    const metadata = JSON.parse(memory.metadata_json);
    const score: number = metadata.feedback_score;
    if (score === undefined || score === 0) {
      continue;
    }

    const lastFeedback: string | undefined = metadata.last_feedback_at;
    if (!lastFeedback) {
      continue;
    }

    const daysIdle = (now - new Date(lastFeedback).getTime()) / (1000 * 60 * 60 * 24);
    if (daysIdle < 7) {
      continue; // don't decay recent feedback
    }

    const decayFactor = Math.exp(-daysIdle / halfLifeDays);
    const newScore = score * decayFactor;

    if (Math.abs(newScore - score) < 0.001) {
      continue;
    }

    const updatedMetadata = {
      ...metadata,
      feedback_score: Math.round(newScore * 10_000) / 10_000,
      feedback_decayed_at: new Date().toISOString(),
    };

    memory.metadata_json = JSON.stringify(updatedMetadata);
    updateMemoryItem(db, memory);
    decayed++;
  }

  return decayed;
}

// ─── Helpers ────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
