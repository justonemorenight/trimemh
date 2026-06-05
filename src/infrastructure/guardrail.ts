import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type { MemoryKind, RiskLevel } from "../domain/schema";
import { KIND_RISK_MAP } from "../domain/schema";
import { insertAuditEvent } from "../persistence/repository";
import {
  MAX_REQUEST_BYTES,
  MAX_STRING_BYTES,
  hashArguments,
  sanitizeOutput,
  sanitizeXmlPayload,
  validateStringSize,
} from "./sanitize";

export const MAX_MCP_SEARCH_RESULTS = 5;
export const MAX_HTTP_SEARCH_RESULTS = 100;
export const MAX_OUTPUT_WORDS = 200;

export type GuardrailSurface = "service" | "cli" | "mcp" | "api" | "compiler";

export class GuardrailViolation extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "GuardrailViolation";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  {
    name: "openai_api_key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[REDACTED_OPENAI_KEY]",
  },
  {
    name: "aws_access_key",
    pattern: /\bA(?:KIA|SIA)[A-Z0-9]{16}\b/g,
    replacement: "[REDACTED_AWS_KEY]",
  },
  {
    name: "github_token",
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    name: "database_url",
    pattern: /\b(?:postgres|postgresql|mysql|mongodb):\/\/[^\s"'<>]+/gi,
    replacement: "[REDACTED_DATABASE_URL]",
  },
  {
    name: "bearer_token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi,
    replacement: "Bearer [REDACTED_TOKEN]",
  },
];

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function riskForKind(kind: MemoryKind): RiskLevel {
  return KIND_RISK_MAP[kind];
}

export function isEscalatedRisk(kind: MemoryKind): boolean {
  const risk = riskForKind(kind);
  return risk === "high" || risk === "critical";
}

export function assertDirectWriteAllowed(input: {
  kind: MemoryKind;
  actor: string;
  surface: GuardrailSurface;
  allowExplicitUser?: boolean;
}): void {
  if (!isEscalatedRisk(input.kind)) {
    return;
  }
  if (input.allowExplicitUser && input.actor === "cli:user:explicit") {
    return;
  }
  const risk = riskForKind(input.kind);
  throw new GuardrailViolation(
    "direct_write_escalated_risk_blocked",
    `Cannot directly write ${risk} risk memory of kind "${input.kind}". Direct write blocked; use proposal flow.`,
    403,
  );
}

export function guardString(
  value: string,
  fieldName: string,
  opts: { maxBytes?: number; maxChars?: number } = {},
): string {
  const maxBytes = opts.maxBytes ?? MAX_STRING_BYTES;
  const sizeError = validateStringSize(value, maxBytes, fieldName);
  if (sizeError) {
    throw new GuardrailViolation("input_string_too_large", sizeError, 413);
  }
  if (opts.maxChars !== undefined && value.length > opts.maxChars) {
    throw new GuardrailViolation(
      "input_string_too_long",
      `Field "${fieldName}" exceeds maximum length of ${opts.maxChars} characters.`,
      413,
    );
  }
  return maskSensitiveText(value);
}

export function guardRequestPayload(input: {
  payload: unknown;
  surface: GuardrailSurface;
  maxBytes?: number;
}): unknown {
  const serialized = JSON.stringify(input.payload ?? {});
  const maxBytes = input.maxBytes ?? MAX_REQUEST_BYTES;
  const size = byteLength(serialized);
  if (size > maxBytes) {
    throw new GuardrailViolation(
      "request_payload_too_large",
      `${input.surface} request payload exceeds ${maxBytes} bytes (received ${size} bytes).`,
      413,
    );
  }
  return guardValue(input.payload, "payload");
}

export function guardValue(value: unknown, fieldPath = "value"): unknown {
  if (typeof value === "string") {
    return guardString(value, fieldPath);
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => guardValue(entry, `${fieldPath}[${index}]`));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = guardValue(entry, `${fieldPath}.${key}`);
    }
    return output;
  }
  return value;
}

export function maskSensitiveText(text: string): string {
  let masked = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    masked = masked.replace(pattern, replacement);
  }
  return masked;
}

export function guardOutput(text: string, maxWords: number = MAX_OUTPUT_WORDS): string {
  return sanitizeOutput(maskSensitiveText(text), maxWords);
}

export function guardXmlPayload(text: string): string {
  return sanitizeXmlPayload(maskSensitiveText(text));
}

export function capSearchLimit(limit: number | undefined, surface: "mcp" | "api" = "mcp"): number {
  const max = surface === "mcp" ? MAX_MCP_SEARCH_RESULTS : MAX_HTTP_SEARCH_RESULTS;
  if (!Number.isFinite(limit ?? NaN)) {
    return max;
  }
  return Math.max(1, Math.min(Math.trunc(limit as number), max));
}

export function guardedArgumentsHash(args: Record<string, unknown>): string {
  const guarded = guardRequestPayload({ payload: args, surface: "service" }) as Record<
    string,
    unknown
  >;
  return hashArguments(guarded);
}

export function handleSecurityViolation(input: {
  db?: Database;
  projectId?: string;
  actor: string;
  violationCode: string;
  detail: string;
  surface?: GuardrailSurface;
  entityId?: string;
}): void {
  const timestamp = new Date().toISOString();
  console.error(
    `[SECURITY ALERT] [${timestamp}] ACTOR: ${input.actor} | EVENT: ${input.violationCode} | DETAILS: ${input.detail}`,
  );

  if (!(input.db && input.projectId)) {
    return;
  }

  insertAuditEvent(input.db, {
    id: randomUUID(),
    project_id: input.projectId,
    actor: input.actor,
    event_type: "security_violation",
    entity_type: "security_guardrail",
    entity_id: input.entityId ?? input.violationCode,
    payload_json: JSON.stringify({
      code: input.violationCode,
      detail: maskSensitiveText(input.detail),
      surface: input.surface ?? "service",
      timestamp,
    }),
    created_at: timestamp,
  });
}

export function logAndThrowViolation(input: {
  db?: Database;
  projectId?: string;
  actor: string;
  violation: GuardrailViolation;
  surface?: GuardrailSurface;
}): never {
  handleSecurityViolation({
    db: input.db,
    projectId: input.projectId,
    actor: input.actor,
    violationCode: input.violation.code,
    detail: input.violation.message,
    surface: input.surface,
  });
  throw input.violation;
}
