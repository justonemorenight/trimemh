import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";
import { createServer } from "node:net";

import type { StreamableHTTPConfig } from "../src/mcp/transport";
import { createStreamableHTTPServer } from "../src/mcp/transport";
import { closeDb, getDb, runMigrations } from "../src/persistence/db";

const TEST_DB = "/tmp/memh-test-mcp-transport.sqlite";
const PROJECT = "mcp-transport-test-project";

let db: Database;
let server: ReturnType<typeof createStreamableHTTPServer>["server"] | null = null;
let baseUrl = "";

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

function rpcBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: "test-request",
    method: "memory_stats",
  });
}

async function responseJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const portFinder = createServer();
    portFinder.once("error", reject);
    portFinder.listen(0, "127.0.0.1", () => {
      const address = portFinder.address();
      if (!address || typeof address === "string") {
        portFinder.close(() => reject(new Error("Failed to find an available port.")));
        return;
      }
      portFinder.close(() => resolve(address.port));
    });
  });
}

async function startTransport(config?: Partial<StreamableHTTPConfig>): Promise<void> {
  const transport = createStreamableHTTPServer(db, PROJECT, {
    port: await getAvailablePort(),
    ...config,
  });
  server = transport.server;
  baseUrl = `http://127.0.0.1:${server.port}`;
}

function isLoopbackUnavailable(err: unknown): boolean {
  return (
    err instanceof Error && ("code" in err ? ["EPERM", "EACCES"].includes(String(err.code)) : false)
  );
}

async function withTransport(
  config: Partial<StreamableHTTPConfig> | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await startTransport(config);
  } catch (err) {
    if (isLoopbackUnavailable(err)) {
      console.warn("[triMemh:test] Skipping MCP transport assertions: loopback bind unavailable.");
      return;
    }
    throw err;
  }
  await fn();
}

beforeEach(() => {
  cleanupDb();
  db = getDb(TEST_DB);
  runMigrations(db);
});

afterEach(async () => {
  await server?.stop(true);
  server = null;
  closeDb();
  cleanupDb();
});

describe("MCP Streamable HTTP transport", () => {
  it("rejects POST requests with a non-JSON content type", async () => {
    await withTransport(undefined, async () => {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: rpcBody(),
      });

      expect(res.status).toBe(415);
      const body = await responseJson(res);
      expect((body.error as { message?: string }).message).toContain("application/json required");
    });
  });

  it("rejects POST requests without a content type", async () => {
    await withTransport(undefined, async () => {
      const res = await fetch(baseUrl, {
        method: "POST",
        body: new TextEncoder().encode(rpcBody()),
      });

      expect(res.status).toBe(415);
      const body = await responseJson(res);
      expect((body.error as { message?: string }).message).toContain("application/json required");
    });
  });

  it("accepts JSON content types with parameters", async () => {
    await withTransport(undefined, async () => {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: rpcBody(),
      });

      expect(res.status).toBe(200);
      const body = await responseJson(res);
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBe("test-request");
      expect(body.result).toBeTruthy();
    });
  });

  it("does not grant CORS preflight access to unknown browser origins", async () => {
    await withTransport(undefined, async () => {
      const res = await fetch(baseUrl, {
        method: "OPTIONS",
        headers: {
          Origin: "https://attacker.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(res.headers.get("Access-Control-Allow-Headers")).toBeNull();
    });
  });

  it("rejects a browser-simple form POST even from an allowed origin", async () => {
    await withTransport({ allowedOrigins: ["https://trusted.example"] }, async () => {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: {
          Origin: "https://trusted.example",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `payload=${encodeURIComponent(rpcBody())}`,
      });

      expect(res.status).toBe(415);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://trusted.example");
      const body = await responseJson(res);
      expect((body.error as { message?: string }).message).toContain("application/json required");
    });
  });

  it("allows preflight and JSON POST for an explicitly allowed browser origin", async () => {
    await withTransport({ allowedOrigins: ["https://trusted.example"] }, async () => {
      const preflight = await fetch(baseUrl, {
        method: "OPTIONS",
        headers: {
          Origin: "https://trusted.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });

      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("https://trusted.example");
      expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");

      const res = await fetch(baseUrl, {
        method: "POST",
        headers: {
          Origin: "https://trusted.example",
          "Content-Type": "application/json",
        },
        body: rpcBody(),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://trusted.example");
    });
  });
});
