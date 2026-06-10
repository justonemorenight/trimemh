import type { Database } from "bun:sqlite";

import type { MemoryKind, MemoryProposal } from "../domain/schema";
import { updateProposal } from "../persistence/proposal-repo";
import { listPendingProposals } from "../persistence/repository";
import { normalizeText } from "../retrieval/dedup";
import { now } from "./helpers";

const STALE_DAYS = 7;
const MERGE_KINDS = new Set<MemoryKind>(["session_summary", "tooling", "fact"]);
const TOKEN_SPLIT_RE = /[^a-z0-9]+/i;

function tokenSet(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .toLowerCase()
      .split(TOKEN_SPLIT_RE)
      .filter((token) => token.length > 2),
  );
}

function jaccardSimilarity(a: string, b: string): number {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection++;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function findSimilarPendingProposal(
  db: Database,
  projectId: string,
  kind: MemoryKind,
  text: string,
): MemoryProposal | null {
  if (!MERGE_KINDS.has(kind)) {
    return null;
  }

  const pending = listPendingProposals(db, projectId).filter((p) => p.proposed_kind === kind);
  let best: { proposal: MemoryProposal; score: number } | null = null;

  for (const proposal of pending) {
    const score = jaccardSimilarity(proposal.proposed_text, text);
    if (score >= 0.55 && (!best || score > best.score)) {
      best = { proposal, score };
    }
  }

  return best?.proposal ?? null;
}

export function mergePendingProposal(
  db: Database,
  existing: MemoryProposal,
  text: string,
  rationale?: string,
): MemoryProposal {
  existing.proposed_text = text;
  if (rationale) {
    existing.rationale = rationale;
  }
  existing.created_at = now();
  return updateProposal(db, existing);
}

export function staleProposalIds(proposals: MemoryProposal[]): Set<string> {
  const stale = new Set<string>();
  const nowMs = Date.now();
  const staleMs = STALE_DAYS * 24 * 60 * 60 * 1000;

  const byKind = new Map<string, MemoryProposal[]>();
  for (const proposal of proposals) {
    const group = byKind.get(proposal.proposed_kind) ?? [];
    group.push(proposal);
    byKind.set(proposal.proposed_kind, group);
  }

  for (const group of byKind.values()) {
    const sorted = [...group].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    for (let i = 1; i < sorted.length; i++) {
      const proposal = sorted[i];
      if (!proposal) {
        continue;
      }
      const age = nowMs - new Date(proposal.created_at).getTime();
      if (age >= staleMs) {
        stale.add(proposal.id);
      }
    }
  }

  return stale;
}

export function formatProposalBatchHints(proposals: MemoryProposal[]): string[] {
  if (proposals.length === 0) {
    return [];
  }

  const lines: string[] = [];
  const byKind = new Map<string, MemoryProposal[]>();
  for (const proposal of proposals) {
    const group = byKind.get(proposal.proposed_kind) ?? [];
    group.push(proposal);
    byKind.set(proposal.proposed_kind, group);
  }

  for (const [kind, group] of byKind.entries()) {
    if (group.length >= 3) {
      lines.push(
        `Batch hint: ${group.length} pending "${kind}" proposals — consider approving the newest and rejecting stale duplicates.`,
      );
    }
  }

  const stale = staleProposalIds(proposals);
  if (stale.size > 0) {
    lines.push(
      `Stale candidates (${STALE_DAYS}+ days, superseded by newer pending): ${stale.size}`,
    );
  }

  return lines;
}
