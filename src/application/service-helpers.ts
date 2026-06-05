import type { Database } from "bun:sqlite";

import { v4 as uuidv4 } from "uuid";

import { guardRequestPayload } from "../infrastructure/guardrail";
import { insertAuditEvent } from "../persistence/repository";
import { embedText } from "../retrieval/embedding-provider";

export function now(): string {
  return new Date().toISOString();
}

export function json(v: unknown): string {
  return JSON.stringify(v);
}

export function guardedPayload<T>(value: T | undefined): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  return guardRequestPayload({ payload: value, surface: "service" }) as T;
}

export function embeddingForText(text: string, explicit?: Float32Array | null): Float32Array {
  return explicit ?? embedText(text);
}

export function audit(
  db: Database,
  projectId: string,
  actor: string,
  eventType: string,
  entityType: string,
  entityId: string,
  payload: unknown = {},
): void {
  insertAuditEvent(db, {
    id: uuidv4(),
    project_id: projectId,
    actor,
    event_type: eventType,
    entity_type: entityType,
    entity_id: entityId,
    payload_json: json(payload),
    created_at: now(),
  });
}
