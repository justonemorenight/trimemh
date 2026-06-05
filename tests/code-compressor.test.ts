import { describe, expect, it } from "bun:test";

import { compressCodeWithAst } from "../src/context/code-compressor";
import { getCcrStore, renderDetailSmart, resetCcrStore } from "../src/context/compiler";
import { renderContentByType } from "../src/context/content-router";
import type { MemoryItem } from "../src/domain/schema";

function item(
  id: string,
  text: string,
  metadata: Record<string, unknown> = {},
  kind: MemoryItem["kind"] = "code_context",
): MemoryItem {
  const now = new Date().toISOString();
  return {
    id,
    project_id: "code-compressor-test",
    kind,
    text,
    status: "active",
    visibility: "private",
    confidence: 0.8,
    source: "test",
    content_hash: `hash-${id}`,
    evidence_json: "[]",
    metadata_json: JSON.stringify(metadata),
    embedding: null,
    created_at: now,
    updated_at: now,
    expires_at: null,
  };
}

const TS_CODE = `
import { Database } from "bun:sqlite";

/** Service docs */
@sealed
export class MemoryService<T> extends BaseService {
  constructor(private db: Database) {
    super();
    this.db.exec("select 1");
  }

  async remember(text: string): Promise<string> {
    const normalize = (value: string) => value.trim().toLowerCase();
    function nestedHelper(input: string): string {
      return normalize(input);
    }
    return nestedHelper(text);
  }
}

export interface MemoryRecord {
  id: string;
  text: string;
}

export type MemoryMode = "fast" | "safe";

export const buildMemory = async (input: string): Promise<MemoryRecord> => {
  const secretImplementation = input.repeat(10);
  return { id: "id", text: secretImplementation };
};

export const config = {
  port: 3000,
  secret: "do-not-include-body-values",
};
`;

describe("compressCodeWithAst", () => {
  it("compresses TS/JS code to signatures and line ranges", () => {
    const result = compressCodeWithAst(TS_CODE, { path: "src/service.ts" });

    expect(result).not.toBeNull();
    expect(result?.compressed).toBe(true);
    expect(result?.display).toContain("TypeScript AST summary");
    expect(result?.display).toContain("export class MemoryService<T> extends BaseService");
    expect(result?.display).toContain("remember(text: string): Promise<string>;");
    expect(result?.display).toContain("export interface MemoryRecord");
    expect(result?.display).toContain("export const buildMemory");
    expect(result?.display).toContain("nestedHelper");
    expect(result?.display).toContain("normalize");
    expect(result?.display).toContain("L");
    expect(result?.display).not.toContain("secretImplementation");
    expect(result?.display).not.toContain("do-not-include-body-values");
  });

  it("returns null for unsupported language-like code", () => {
    const python = "def hello(name):\n    return f'hello {name}'\n";
    expect(compressCodeWithAst(python, { path: "hello.py" })).toBeNull();
  });

  it("returns null on syntax errors so callers can fallback", () => {
    const invalid = "export function broken( {";
    expect(compressCodeWithAst(invalid, { path: "broken.ts" })).toBeNull();
  });

  it("uses partial AST when a file has enough valid structure before syntax errors", () => {
    const partial = [
      "export function okHandler(): string {",
      "  return '/api/ok';",
      "}",
      "export function broken( {",
    ].join("\n");

    const result = compressCodeWithAst(partial, { path: "src/routes.ts" });

    expect(result).not.toBeNull();
    expect(result?.display).toContain("partial TypeScript AST summary");
    expect(result?.display).toContain("okHandler");
    expect(result?.display).toContain("routes=/api/ok");
  });

  it("prioritizes exported API symbols under a tight summary budget", () => {
    const code = [
      "function boringHelperA() { return 1; }",
      "function boringHelperB() { return 2; }",
      "function boringHelperC() { return 3; }",
      "function boringHelperD() { return 4; }",
      "export function routeHandler(request: Request): Response {",
      "  return new Response('ok');",
      "}",
      "export const securityPolicy = { role: 'admin' };",
    ].join("\n");

    const result = compressCodeWithAst(code, { path: "src/routes.ts", maxLines: 5 });

    expect(result).not.toBeNull();
    expect(result?.display).toContain("routeHandler");
    expect(result?.display).toContain("securityPolicy");
    expect(result?.display).not.toContain("boringHelperA");
  });

  it("keeps important literals without leaking arbitrary body string values", () => {
    const code = [
      "export async function handler() {",
      "  const route = '/api/memories/:id';",
      "  const db = process.env.DATABASE_URL;",
      "  const sql = 'select * from memory_items join memory_edges on memory_edges.source_memory_id = memory_items.id';",
      "  const code = 'ERR_TRIMEMH_FORBIDDEN';",
      "  const secret = 'do-not-preserve-body-value';",
      "  return { route, db, sql, code, secret };",
      "}",
    ].join("\n");

    const result = compressCodeWithAst(code, { path: "src/api.ts" });

    expect(result).not.toBeNull();
    expect(result?.display).toContain("routes=/api/memories/:id");
    expect(result?.display).toContain("env=DATABASE_URL");
    expect(result?.display).toContain("codes=ERR_TRIMEMH_FORBIDDEN");
    expect(result?.display).toContain("sql_tables=memory_items,memory_edges");
    expect(result?.display).not.toContain("do-not-preserve-body-value");
  });
});

describe("ContentRouter code compression", () => {
  it("uses AST compression for TS metadata paths", () => {
    const rendered = renderContentByType(item("m-code", TS_CODE, { path: "src/service.ts" }), {
      forceType: "code",
    });

    expect(rendered.contentType).toBe("code");
    expect(rendered.compressed).toBe(true);
    expect(rendered.display).toContain("TypeScript AST summary");
    expect(rendered.display).not.toContain("secretImplementation");
  });

  it("falls back to regex rendering for non-TS code", () => {
    const python = [
      "def hello(name):",
      "    value = name.strip()",
      "    return value",
      "",
      "class Processor:",
      "    def run(self):",
      "        return hello('x')",
    ].join("\n");
    const rendered = renderContentByType(item("m-py", python, { path: "processor.py" }), {
      forceType: "code",
    });

    expect(rendered.contentType).toBe("code");
    expect(rendered.display).toContain("def hello");
    expect(rendered.display).toContain("class Processor");
  });

  it("registers deferred retrieval for compressed code", () => {
    resetCcrStore();
    const output = renderDetailSmart(item("m-deferred", TS_CODE, { path: "src/service.ts" }));
    const store = getCcrStore();

    expect(output.compressed).toBe(true);
    expect(output.deferred?.memoryId).toBe("m-deferred");
    expect(store.deferred.has("trimemh:m-deferred")).toBe(true);
    expect(store.deferred.get("trimemh:m-deferred")?.fullText).toContain("secretImplementation");
  });

  it("uses code_context as a hint for issue triage code snippets", () => {
    resetCcrStore();
    const issueSnippet = `
// Current Redis connection configuration - suspect keepalive mismatch
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: 6379,
  retryStrategy: (times) => Math.min(times * 50, 2000),
  // Missing: explicit keepalive configuration
});

// Proposed immediate fix - add keepalive to prevent ELB from dropping
const redisFixed = new Redis({
  host: process.env.REDIS_HOST,
  port: 6379,
  keepAlive: 30000,
  connectTimeout: 10000,
  maxRetriesPerRequest: 3,
});

async function getSessionWithHealthCheck(sessionId: string): Promise<Session | null> {
  try {
    await redis.ping();
    const data = await redis.get(\`session:\${sessionId}\`);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    if (error instanceof ConnectionClosedError) {
      await redis.connect();
      return null;
    }
    throw error;
  }
}
`;

    const output = renderDetailSmart(item("m-issue-code", issueSnippet));
    const store = getCcrStore();

    expect(output.contentType).toBe("code");
    expect(output.compressed).toBe(true);
    expect(output.deferred?.memoryId).toBe("m-issue-code");
    expect(store.deferred.has("trimemh:m-issue-code")).toBe(true);
    expect(output.displayContent).toContain("TypeScript AST summary");
    expect(output.displayContent).not.toContain("keepalive configuration");
  });

  it("does not misdetect prose bug reports that mention code and errors", () => {
    const prose = [
      "Bug Report: User authentication fails with InvalidTokenError.",
      "The client sees token signature verification failures after normal navigation.",
      "We checked the const token value in logs, but this is a prose investigation note, not a code snippet.",
      "Impact is about five percent of active users and the current hypothesis is stale Redis sessions.",
    ].join("\n\n");

    const rendered = renderContentByType(item("m-prose", prose, {}, "mistake"));

    expect(rendered.contentType).toBe("prose");
    expect(rendered.compressed).toBe(false);
  });

  it("detects fenced TypeScript snippets without metadata paths", () => {
    const fenced = [
      "```ts",
      "export async function loadSession(sessionId: string): Promise<Session | null> {",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: warning suppression
      "  const data = await redis.get(`session:${sessionId}`);",
      "  return data ? JSON.parse(data) : null;",
      "}",
      "```",
    ].join("\n");

    const rendered = renderContentByType(item("m-fenced", fenced, {}, "fact"));

    expect(rendered.contentType).toBe("code");
    expect(rendered.compressed).toBe(true);
    expect(rendered.display).toContain("TypeScript AST summary");
  });

  it("compacts short error-heavy triage logs into signatures", () => {
    const log = [
      "2026-06-05T14:32:11.234Z [ERROR] auth-service InvalidTokenError: Token signature verification failed requestId=req-x8k2m9n1 userId=usr_89f2a1b3",
      "    at JwtVerifier.verify (src/auth/jwt-verifier.ts:89:15)",
      "2026-06-05T14:32:11.456Z [ERROR] auth-service SessionLookupError: Redis connection closed requestId=req-x8k2m9n1",
      "    at RedisSessionStore.get (src/auth/session-store.ts:67:20)",
      "2026-06-05T14:32:11.678Z [ERROR] api-gateway RequestFailed: 500 Internal Server Error requestId=req-x8k2m9n1",
      "2026-06-05T14:33:01.234Z [ERROR] auth-service InvalidTokenError: Token signature verification failed requestId=req-y9l3n2o2 userId=usr_89f2a1b3",
      "2026-06-05T14:33:01.456Z [WARN] auth-service Repeated auth failure for user usr_89f2a1b3",
    ].join("\n");

    const rendered = renderContentByType(item("m-log", log, {}, "procedure"));

    expect(rendered.contentType).toBe("log");
    expect(rendered.compressed).toBe(true);
    expect(rendered.display).toContain("log error signatures");
    expect(rendered.display).toContain("auth-service: InvalidTokenError");
    expect(rendered.display).toContain("requestIds: req-x8k2m9n1, req-y9l3n2o2");
  });
});
