import type { Database } from "bun:sqlite";

import type { MemoryItem, MemoryProposal } from "../domain/schema";
import { getMemoryById, getProposalById, listPendingProposals } from "../persistence/repository";

function isFullUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function matchByPrefix<T extends { id: string }>(
  items: T[],
  prefix: string,
  label: string,
): T {
  if (isFullUuid(prefix)) {
    const exact = items.find((item) => item.id === prefix);
    if (exact) {
      return exact;
    }
  }

  const matched = items.filter((item) => item.id.startsWith(prefix));
  if (matched.length === 1) {
    return matched[0]!;
  }
  if (matched.length > 1) {
    throw new Error(
      `${label} prefix "${prefix}" is ambiguous. Matched: ${matched.map((item) => item.id).join(", ")}`,
    );
  }

  throw new Error(`${label} "${prefix}" not found.`);
}

export function resolveMemoryId(
  db: Database,
  projectId: string,
  idOrPrefix: string,
): MemoryItem {
  const exact = getMemoryById(db, idOrPrefix);
  if (exact && exact.project_id === projectId) {
    return exact;
  }

  const rows = db
    .query(
      `SELECT id FROM memory_items
       WHERE project_id = ? AND id LIKE ? || '%'
       ORDER BY updated_at DESC;`,
    )
    .all(projectId, idOrPrefix) as Array<{ id: string }>;

  const items = rows
    .map((row) => getMemoryById(db, row.id))
    .filter((item): item is MemoryItem => item !== null);

  return matchByPrefix(items, idOrPrefix, "Memory");
}

export function resolveProposalId(
  db: Database,
  projectId: string,
  idOrPrefix: string,
): MemoryProposal {
  const exact = getProposalById(db, idOrPrefix);
  if (exact && exact.project_id === projectId) {
    return exact;
  }

  const pending = listPendingProposals(db, projectId).filter((p) =>
    p.id.startsWith(idOrPrefix),
  );
  if (pending.length === 1) {
    return pending[0]!;
  }
  if (pending.length > 1) {
    throw new Error(
      `Proposal prefix "${idOrPrefix}" is ambiguous. Matched: ${pending.map((p) => p.id).join(", ")}`,
    );
  }

  throw new Error(`Proposal "${idOrPrefix}" not found.`);
}

export function formatIdLine(id: string): string {
  return `id: ${id}`;
}
