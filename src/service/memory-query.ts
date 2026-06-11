import type { Database } from "bun:sqlite";

import { CONFIG } from "../config";
import type { MemoryItem } from "../domain/schema";
import {
  deleteMemoryItem,
  getMemoryById,
  listMemoryItems as listMemories,
} from "../persistence/repository";
import { audit } from "./helpers";

// ─── List memories ────────────────────────────────────────────────

export function listAll(
  db: Database,
  projectId: string,
  kind?: string,
  status?: string,
): MemoryItem[] {
  return listMemories(db, projectId, { kind, status, limit: CONFIG.service.defaultListLimit });
}

// ─── Forget (delete) ──────────────────────────────────────────────

export function forget(db: Database, projectId: string, id: string): boolean {
  const existing = getMemoryById(db, id);
  if (!existing) {
    throw new Error(`Memory "${id}" not found.`);
  }
  if (existing.project_id !== projectId) {
    throw new Error(`Memory "${id}" belongs to a different project.`);
  }

  const deleted = deleteMemoryItem(db, id);
  if (deleted) {
    audit(db, projectId, "user", "memory_deleted", "memory_item", id, {
      kind: existing.kind,
    });
  }
  return deleted;
}
