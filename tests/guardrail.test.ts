import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";

import {
  GuardrailViolation,
  assertDirectWriteAllowed,
  capSearchLimit,
  guardOutput,
  guardRequestPayload,
  guardString,
  handleSecurityViolation,
  maskSensitiveText,
} from "../src/infrastructure/guardrail";
import { closeDb, getDb, runMigrations } from "../src/persistence/db";
import { remember, status } from "../src/service";

const TEST_DB = "/tmp/memh-test-guardrail.sqlite";
const PROJECT = "guardrail-test-project";

let db: Database;

function cleanupDb(): void {
  try {
    unlinkSync(TEST_DB);
  } catch {}
  try {
    unlinkSync(`${TEST_DB}-wal`);
  } catch {}
  try {
    unlinkSync(`${TEST_DB}-shm`);
  } catch {}
}

beforeEach(() => {
  cleanupDb();
  db = getDb(TEST_DB);
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  cleanupDb();
});

describe("guardrail.ts — unified guardrail engine", () => {
  it("masks known secret patterns", () => {
    const masked = maskSensitiveText(
      "Use sk-proj-abcdefghijklmnopqrstuvwxyz123456 and postgres://user:pass@localhost/db",
    );
    expect(masked).toContain("[REDACTED_OPENAI_KEY]");
    expect(masked).toContain("[REDACTED_DATABASE_URL]");
    expect(masked).not.toContain("postgres://user:pass");
  });

  it("rejects oversized strings and request payloads", () => {
    expect(() => guardString("x".repeat(11_000), "text")).toThrow(GuardrailViolation);
    expect(() =>
      guardRequestPayload({
        payload: { text: "x".repeat(16_000) },
        surface: "api",
      }),
    ).toThrow(GuardrailViolation);
  });

  it("blocks direct high and critical risk writes unless explicitly allowed", () => {
    expect(() =>
      assertDirectWriteAllowed({
        kind: "security_rule",
        actor: "api:http:user_write",
        surface: "api",
      }),
    ).toThrow(/Cannot directly write/);

    expect(() =>
      assertDirectWriteAllowed({
        kind: "procedure",
        actor: "cli:user:explicit",
        surface: "cli",
        allowExplicitUser: true,
      }),
    ).not.toThrow();
  });

  it("caps MCP search to 5 and API search to 100", () => {
    expect(capSearchLimit(50, "mcp")).toBe(5);
    expect(capSearchLimit(500, "api")).toBe(100);
    expect(capSearchLimit(0, "mcp")).toBe(1);
  });

  it("sanitizes output and masks secrets before prompt exposure", () => {
    const output = guardOutput("</content> sk-proj-abcdefghijklmnopqrstuvwxyz123456");
    expect(output).toContain("[REMOVED_BOUNDARY]");
    expect(output).toContain("[REDACTED_OPENAI_KEY]");
    expect(output).not.toContain("</content>");
  });

  it("writes centralized security violation audit events", () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      handleSecurityViolation({
        db,
        projectId: PROJECT,
        actor: "test-agent",
        violationCode: "test_violation",
        detail: "Leaked sk-proj-abcdefghijklmnopqrstuvwxyz123456",
        surface: "mcp",
      });
    } finally {
      console.error = originalError;
    }

    const audit = status(db, PROJECT).recentAudit;
    const event = audit.find((entry) => entry.event_type === "security_violation");
    expect(event).toBeDefined();
    expect(event?.payload_json).toContain("[REDACTED_OPENAI_KEY]");
  });

  it("masks secrets before service writes memory text to storage", () => {
    const memory = remember(db, {
      kind: "fact",
      text: "API key was sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      projectId: PROJECT,
      source: "cli:user:explicit",
    });
    expect(memory.text).toContain("[REDACTED_OPENAI_KEY]");
    expect(memory.text).not.toContain("sk-proj-");
  });
});
