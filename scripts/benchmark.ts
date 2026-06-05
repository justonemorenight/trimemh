/**
 * Token Savings Benchmark — triMemh Compression Pipeline
 *
 * Replicates headroom's benchmark methodology across 4+ real-world scenarios.
 * Dual-mode: auto-detect content type + forced optimal type.
 *
 * Usage: bun run scripts/benchmark.ts
 */

import { compressDetail } from "../src/context/ccr";
import { renderDetailSmart, resetCcrStore } from "../src/context/compiler";
import type { MemoryContentType } from "../src/context/content-router";
import { contentTypeLabel, renderContentByType } from "../src/context/content-router";
import type { MemoryItem, MemoryKind } from "../src/domain/schema";

// ═══════════════════════════════════════════════════════════════════════
// Token counting — matches compiler's own estimateTokens (length/4)
// This is what LLMs approximate for most text (~4 chars per token)
// ═══════════════════════════════════════════════════════════════════════

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function fmt(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}K`;
  }
  return String(n);
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

function mi(id: string, kind: MemoryKind, text: string): MemoryItem {
  return {
    id,
    project_id: "bench",
    kind,
    status: "active",
    text,
    metadata_json: "{}",
    evidence_json: "[]",
    content_hash: "",
    embedding: null,
    visibility: "team",
    source: "benchmark",
    confidence: 0.9,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    expires_at: null,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// FIXTURE 1: Code Search (100 results) — JSON output from code search
// ═══════════════════════════════════════════════════════════════════════

function makeCodeSearchFixture(): MemoryItem[] {
  const results: Array<{
    file: string;
    line: number;
    column: number;
    symbol: string;
    kind: string;
    snippet: string;
    repo: string;
  }> = [];
  const symbols = [
    "fetchUserData",
    "validateSession",
    "handleRequest",
    "applyRateLimit",
    "matchRoute",
    "logRequest",
    "createUser",
    "updateProfile",
    "deleteSession",
    "refreshToken",
  ];

  for (let i = 0; i < 100; i++) {
    const sym = symbols[i % symbols.length] ?? "unknown";
    results.push({
      file: `src/${["api", "services", "middleware", "hooks", "utils", "controllers"][i % 6]}/${sym}.ts`,
      line: 10 + ((i * 17) % 300),
      column: 1 + ((i * 23) % 60),
      symbol: sym,
      kind: ["function", "class", "method", "interface", "type"][i % 5],
      snippet: `export ${i % 3 === 0 ? "async " : ""}${["function", "class", "const"][i % 3]} ${sym}(${i % 2 === 0 ? "opts: Options" : "id: string, ctx: Context"}): ${["Promise<User>", "Response", "boolean", "void", "string"][i % 5]} { /* ${30 + i * 3} lines */ }`,
      repo: ["api-gateway", "auth-service", "shared-lib"][i % 3],
    });
  }

  const jsonText = JSON.stringify(
    {
      tool: "code_search",
      query: "fetchUserData OR validateSession OR handleRequest",
      total_results: 100,
      repositories_searched: 3,
      results,
    },
    null,
    2,
  );

  return [mi("bench-code-001", "code_context", jsonText)];
}

// ═══════════════════════════════════════════════════════════════════════
// FIXTURE 2: SRE Incident Debugging — Production logs from outage
// ═══════════════════════════════════════════════════════════════════════

function makeSreFixture(): MemoryItem[] {
  const lines: string[] = [];
  const svcs = ["api-gateway", "auth-service", "user-service", "payment-worker", "redis-cache"];
  const levels = ["INFO", "INFO", "INFO", "WARN", "ERROR", "DEBUG", "DEBUG", "TRACE"];
  const rids = Array.from({ length: 50 }, () => `req-${Math.random().toString(36).slice(2, 10)}`);

  for (let i = 0; i < 800; i++) {
    const ts = new Date(
      2026,
      5,
      4,
      14,
      30 + Math.floor(i / 40),
      (i * 2) % 60,
      (i * 7) % 60,
    ).toISOString();
    const svc = svcs[i % svcs.length] ?? "unknown-service";
    const lvl = levels[i % levels.length] ?? "INFO";
    const rid = rids[i % rids.length] ?? "req-unknown";
    const lat = Math.floor(Math.random() * 5000) + (i > 500 ? 5000 : 0);

    if (lvl === "ERROR" || (lvl === "WARN" && i > 600)) {
      lines.push(`${ts} [${lvl}] ${svc} requestId=${rid} latency=${lat}ms`);
      lines.push(`${ts} [${lvl}] ${svc} Stack trace:`);
      lines.push(`  at UserService.fetchUserData (src/services/user-service.ts:147:22)`);
      lines.push(`  at AuthMiddleware.validateSession (src/middleware/auth.ts:89:15)`);
      lines.push(`  at ApiGateway.handleRequest (src/gateway/handler.ts:234:10)`);
      if (i > 650) {
        lines.push(`  at DatabasePool.acquire (node_modules/pg-pool/index.js:56:12)`);
        lines.push(`  at Timeout._onTimeout (node:timers:567:20)`);
      }
      lines.push(`  Caused by: ConnectionTimeoutError: Connection pool exhausted after 30s`);
    } else if (lvl === "WARN") {
      lines.push(
        `${ts} [WARN] ${svc} requestId=${rid} Slow query (${lat}ms): SELECT * FROM users WHERE email = ?`,
      );
    } else if (lvl === "INFO") {
      lines.push(
        `${ts} [INFO] ${svc} requestId=${rid} GET /api/users/${rid.slice(0, 4)} 200 ${lat}ms`,
      );
    } else if (lvl === "DEBUG") {
      lines.push(
        `${ts} [DEBUG] ${svc} requestId=${rid} Cache hit: users:${rid.slice(0, 6)} ttl=287s`,
      );
    } else {
      lines.push(
        `${ts} [TRACE] ${svc} requestId=${rid} SQL: SELECT id,name,email FROM users WHERE id=$1`,
      );
    }
  }

  lines.push("\n=== SYSTEM METRICS (last 5 min) ===");
  lines.push("CPU: 94% [CRITICAL]  Memory: 8.2/16GB [WARN]  DB Connections: 98/100 [CRITICAL]");
  lines.push("Redis Memory: 1.2/1.5GB [WARN]  Request Queue: 847 pending [CRITICAL]");
  lines.push("P50: 234ms  P95: 1892ms  P99: 12847ms [CRITICAL]");
  lines.push("Error Rate: 12.7% [CRITICAL]  5xx: 847/min  4xx: 234/min");

  return [mi("bench-sre-001", "procedure", lines.join("\n"))];
}

// ═══════════════════════════════════════════════════════════════════════
// FIXTURE 3: GitHub Issue Triage — Bug report with investigation
// ═══════════════════════════════════════════════════════════════════════

function makeIssueTriageFixture(): MemoryItem[] {
  const proseBody = `Bug Report: User authentication fails intermittently with "Invalid token" error

DESCRIPTION
We're seeing intermittent authentication failures in production affecting approximately 5% of users. The error manifests as InvalidTokenError with message "Token signature verification failed" on the client side. Users are unexpectedly logged out during active sessions after 5-30 minutes of normal usage, despite JWT tokens being configured with a 24-hour lifetime.

STEPS TO REPRODUCE
First, login with valid email and password credentials. Then navigate between pages normally for 5-10 minutes. After this period, API calls start returning HTTP 401 Unauthorized responses. The user is redirected to the login page, and after re-login, the issue may recur within 30 minutes.

ENVIRONMENT
The problem occurs in production running version 2.14.3 on Node.js 22.11.0. We use Redis 7.2 for session storage with JWT RS256 algorithm for token signing. The infrastructure runs on AWS behind an ELB configured with 60-second idle timeout.

INVESTIGATION FINDINGS
We investigated three theories. Theory one was Redis connection pool exhaustion, but pool utilization peaks at only 45% which is well below the 80% warning threshold, so this was ruled out. Theory two was JWT clock skew between instances, but we verified NTP synchronization and maximum drift is only 12 milliseconds with a 30-second tolerance configured, which ruled this out as well. Theory three is our current working hypothesis involving ELB timeout causing socket resets. The ELB idle timeout of 60 seconds appears to be silently dropping Redis connections that use keepalive. When the next request arrives on a stale connection, the session lookup fails entirely, which triggers a new login flow instead of gracefully reconnecting.

IMPACT ASSESSMENT
This issue affects approximately 2,500 users per day which represents about 5% of our daily active users. The estimated revenue impact is $12,000 per day in abandoned shopping carts. We have classified this as a P1 severity issue since it is a customer-facing authentication problem that directly impacts revenue.

ADDITIONAL CONTEXT
We migrated from self-hosted Redis to AWS ElastiCache on June 1st, and the issue started appearing approximately two days later. While the correlation is strong, we have not yet confirmed actual causation. Related issues include number 3421 about Redis connection drops after an ELB upgrade which was resolved, and number 3892 about session loss during high traffic which remains open and may be related to this same root cause.`;

  const codeBlock = `// Current Redis connection configuration — suspect keepalive mismatch
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: 6379,
  retryStrategy: (times) => Math.min(times * 50, 2000),
  // Missing: explicit keepalive configuration
  // The ELB drops idle connections after 60s, but Redis
  // client doesn't know the connection is dead until it tries to use it
});

// Proposed immediate fix — add keepalive to prevent ELB from dropping
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: 6379,
  retryStrategy: (times) => Math.min(times * 50, 2000),
  keepAlive: 30000,          // Send TCP keepalive every 30 seconds
  connectTimeout: 10000,     // Fail fast on initial connection
  maxRetriesPerRequest: 3,   // Limit retries to prevent cascading failures
  enableReadyCheck: true,    // Verify connection is usable before using
  lazyConnect: false,        // Connect immediately, not on first command
});

// Short-term improvement: connection health check before session lookup
async function getSessionWithHealthCheck(sessionId: string): Promise<Session | null> {
  try {
    await redis.ping();
    const data = await redis.get(\`session:\${sessionId}\`);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    if (error instanceof ConnectionClosedError) {
      await redis.connect();
      const data = await redis.get(\`session:\${sessionId}\`);
      return data ? JSON.parse(data) : null;
    }
    throw error;
  }
}

// Long-term: circuit breaker for Redis with graceful degradation
class RedisCircuitBreaker {
  private failures = 0;
  private lastFailTime = 0;
  private state: "closed" | "open" | "half-open" = "closed";

  async execute<T>(fn: () => Promise<T>, fallback: () => T): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailTime > 30_000) {
        this.state = "half-open";
      } else {
        return fallback();
      }
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      return fallback();
    }
  }

  private onSuccess(): void { this.failures = 0; this.state = "closed"; }
  private onFailure(): void { this.failures++; this.lastFailTime = Date.now(); if (this.failures >= 5) this.state = "open"; }
}`;

  const logBlock = `2026-06-05T14:32:11.234Z [ERROR] auth-service InvalidTokenError: Token signature verification failed
    at JwtVerifier.verify (src/auth/jwt-verifier.ts:89:15)
    at AuthMiddleware.authenticate (src/middleware/auth.ts:123:10)
    at async ApiGateway.handleRequest (src/gateway/handler.ts:234:10)
    requestId=req-x8k2m9n1 userId=usr_89f2a1b3

2026-06-05T14:32:11.456Z [ERROR] auth-service SessionLookupError: Redis connection closed
    at RedisSessionStore.get (src/auth/session-store.ts:67:20)
    at AuthMiddleware.loadSession (src/middleware/auth.ts:56:14)
    requestId=req-x8k2m9n1

2026-06-05T14:32:11.678Z [ERROR] api-gateway RequestFailed: 500 Internal Server Error
    at ApiGateway.handleRequest (src/gateway/handler.ts:234:10)
    requestId=req-x8k2m9n1

2026-06-05T14:32:15.123Z [WARN] auth-service Rate limit exceeded for IP 203.0.113.42
2026-06-05T14:32:15.456Z [INFO] auth-service User login successful userId=usr_89f2a1b3

2026-06-05T14:33:01.234Z [ERROR] auth-service InvalidTokenError: Token signature verification failed
    at JwtVerifier.verify (src/auth/jwt-verifier.ts:89:15)
    requestId=req-y9l3n2o2 userId=usr_89f2a1b3

2026-06-05T14:33:01.456Z [WARN] auth-service Repeated auth failure for user usr_89f2a1b3 (3 attempts in 60s)`;

  return [
    mi("bench-issue-prose", "mistake", proseBody),
    mi("bench-issue-code", "code_context", codeBlock),
    mi("bench-issue-log", "procedure", logBlock),
  ];
}

// ═══════════════════════════════════════════════════════════════════════
// FIXTURE 4: Codebase Exploration — Multi-file code review
// ═══════════════════════════════════════════════════════════════════════

function makeCodebaseFixture(): MemoryItem[] {
  const config = `NODE_ENV=production
PORT=8080
REDIS_HOST=api-gateway-cache.u8ix3a.ng.0001.use1.cache.amazonaws.com
REDIS_PORT=6379
REDIS_TLS_ENABLED=true
REDIS_CONNECTION_POOL_MIN=5
REDIS_CONNECTION_POOL_MAX=50
REDIS_IDLE_TIMEOUT_MS=60000
REDIS_CONNECT_TIMEOUT_MS=10000
REDIS_KEEPALIVE_MS=30000
DB_HOST=api-gateway-db.cluster-c8ix3a.use1.rds.amazonaws.com
DB_PORT=5432
DB_NAME=api_gateway
DB_POOL_MIN=3
DB_POOL_MAX=20
DB_SSL_MODE=require
JWT_ALGORITHM=RS256
JWT_PUBLIC_KEY_PATH=/etc/secrets/jwt-public.pem
JWT_CLOCK_SKEW_SEC=30
JWT_MAX_AGE_SEC=86400
SESSION_TTL_SEC=86400
RATE_LIMIT_ENABLED=true
RATE_LIMIT_MAX_REQUESTS=1000
LOG_LEVEL=info
LOG_FORMAT=json
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.internal:4318
HEALTH_CHECK_PATH=/health`;

  const handler = `import { authenticate } from "./middleware/auth";
import { applyRateLimit } from "./middleware/rate-limit";
import { applyCors } from "./middleware/cors";
import { logRequest, logResponse } from "./middleware/logging";
import { matchRoute } from "./router";
import { Metrics } from "./metrics";
import { Logger } from "./logger";

export interface HandlerConfig {
  maxBodySize: number;
  rateLimitEnabled: boolean;
  corsOrigins: string[];
  requestTimeoutMs: number;
}

export interface RequestContext {
  requestId: string;
  startTime: number;
  route: RouteMatch | null;
  userId: string | null;
  sessionId: string | null;
  clientIp: string;
  userAgent: string;
}

type Middleware = (
  req: Request,
  ctx: RequestContext,
  config: HandlerConfig
) => Promise<Response | null>;

function buildPipeline(config: HandlerConfig): Middleware[] {
  const pipeline: Middleware[] = [
    applyCors,
    logRequest,
    authenticate,
  ];
  if (config.rateLimitEnabled) {
    pipeline.push(applyRateLimit);
  }
  return pipeline;
}

export async function handleRequest(
  req: Request,
  config: Partial<HandlerConfig> = {}
): Promise<Response> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const ctx = createRequestContext(req);
  const pipeline = buildPipeline(mergedConfig);

  Logger.info("Handling request", {
    requestId: ctx.requestId,
    method: req.method,
    path: req.url,
    clientIp: ctx.clientIp,
  });

  const timer = Metrics.startTimer("request_duration_ms");

  try {
    await validateBodySize(req, ctx, mergedConfig);

    for (const middleware of pipeline) {
      const result = await withTimeout(
        middleware(req, ctx, mergedConfig),
        mergedConfig.requestTimeoutMs,
        () => new RequestTimeoutError(ctx.requestId, mergedConfig.requestTimeoutMs)
      );

      if (result !== null) {
        logResponse(req, ctx, result);
        Metrics.incrementCounter("request_short_circuited", {
          middleware: middleware.name,
        });
        return result;
      }
    }

    ctx.route = matchRoute(req);
    if (!ctx.route) {
      const notFound = new Response(404, {
        error: "Not found",
        requestId: ctx.requestId,
      });
      logResponse(req, ctx, notFound);
      return notFound;
    }

    const response = await withTimeout(
      ctx.route.handler(req, ctx),
      mergedConfig.requestTimeoutMs,
      () => new RequestTimeoutError(ctx.requestId, mergedConfig.requestTimeoutMs)
    );

    logResponse(req, ctx, response);
    timer.stop({ status: response.status, route: ctx.route.pattern });
    return response;

  } catch (error) {
    Logger.error("Unhandled error in request pipeline", {
      requestId: ctx.requestId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    Metrics.incrementCounter("request_error", {
      error_type: error instanceof Error ? error.name : "Unknown",
    });

    timer.stop({ status: 500 });
    return new Response(500, {
      error: "Internal server error",
      requestId: ctx.requestId,
    });
  }
}

function createRequestContext(req: Request): RequestContext {
  return {
    requestId: req.headers["x-request-id"] ?? crypto.randomUUID(),
    startTime: Date.now(),
    route: null,
    userId: null,
    sessionId: null,
    clientIp: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ?? "unknown",
    userAgent: req.headers["user-agent"] ?? "unknown",
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorFactory: () => Error
): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(errorFactory()), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}`;

  const diff = `diff --git a/src/middleware/auth.ts b/src/middleware/auth.ts
index 8f3a2b1..c7d4e5f 100644
--- a/src/middleware/auth.ts
+++ b/src/middleware/auth.ts
@@ -12,6 +12,7 @@ import { JwtVerifier } from "../auth/jwt-verifier";
 import { SessionStore } from "../auth/session-store";
 import { Metrics } from "../metrics";
 import { Logger } from "../logger";
+import { CircuitBreaker } from "../infrastructure/circuit-breaker";

 export interface AuthConfig {
   jwtPublicKey: string;
@@ -45,7 +46,8 @@ export async function authenticate(
   req: Request,
   ctx: RequestContext
 ): Promise<Response | null> {
-  const token = extractBearerToken(req);
+  const breaker = new CircuitBreaker("redis-session", { threshold: 5, resetTimeout: 30000 });
+  const token = extractBearerToken(req);

   if (!token) {
     return new Response(401, { error: "Missing authorization token" });
@@ -78,7 +80,11 @@ export async function authenticate(
   }

   // Load session
-  const session = await sessionStore.get(sessionId);
+  const session = await breaker.execute(
+    () => sessionStore.get(sessionId),
+    () => null // Fallback: no session = force re-login
+  );
+
   if (!session) {
     Metrics.incrementCounter("session_not_found");
     return new Response(401, { error: "Session expired" });`;

  return [
    mi("bench-explore-config", "trade_rule", config),
    mi("bench-explore-handler", "code_context", handler),
    mi("bench-explore-diff", "code_context", diff),
  ];
}

// ═══════════════════════════════════════════════════════════════════════
// FIXTURE 5: Architecture Discussion (prose-heavy, bonus scenario)
// ═══════════════════════════════════════════════════════════════════════

function makeConversationFixture(): MemoryItem[] {
  const convo = `Discussion: Migration from REST to GraphQL for User Service API

Alice (Engineering Lead): I've been looking at the performance data from last quarter and the user service REST endpoints are showing significant over-fetching. The dashboard makes 14 separate API calls to render the user profile page, and mobile clients are worse because they're on slower connections. I think we should seriously consider migrating to GraphQL for the user service.

Bob (Senior Backend): I agree the over-fetching is a real problem, but I'm worried about the complexity cost. GraphQL introduces a whole new layer of infrastructure including schema stitching, query complexity analysis, and persisted queries to prevent abuse. Our team is already stretched thin maintaining the current REST APIs across three services.

Alice: That's a fair concern about complexity. But I think we can mitigate a lot of that by using a code-first approach with something like Pothos or type-graphql instead of schema-first. We already have TypeScript types for all our user models, so the GraphQL schema can be generated from those types automatically. This would save us from maintaining two separate type systems.

Charlie (Platform): From the platform side, I'm more worried about caching and rate limiting. Our current REST API uses CDN caching extensively with cache-control headers and ETags. GraphQL typically uses POST requests which bypass CDN caches entirely. We would need to implement something like persisted queries with GET support, or use a GraphQL-specific CDN like Fastly's GraphQL offering.

Alice: Good point on caching. We could use a hybrid approach where queries that don't require authentication are served as persisted GET requests through the CDN, while mutations and authenticated queries use POST. The GraphQL Foundation has a draft RFC for GraphQL over HTTP that specifically addresses this. Also, Apollo Server has built-in support for automatic persisted queries that would give us CDN caching for free on repeated queries.

Bob: What about the database impact? Our REST endpoints are optimized with specific SQL queries and indexes. With GraphQL, we'd need to implement a data loader pattern to avoid the N+1 problem. Every nested field in a GraphQL query could potentially trigger a separate database call if we're not careful.

Alice: That's where DataLoader comes in. We already use it in a few places for batching related data. For the user service specifically, the most common nested fields are user preferences, team memberships, and recent activity. All three can be batched into single queries with DataLoader. I've done a proof of concept and the worst-case query with five levels of nesting results in only three database round-trips when DataLoader is properly configured.

Charlie: I want to circle back to the rate limiting question. How do we prevent a malicious client from sending a deeply nested query that fetches the entire user graph? With REST, each endpoint has a known cost, but with GraphQL every query can have a different cost.

Alice: That's what query complexity analysis is for. We can assign a cost to each field and type, then calculate the total cost of a query before executing it. If the cost exceeds a threshold, we reject it. Libraries like graphql-query-complexity do this out of the box. We can also set a maximum query depth of, say, five levels. Combined with rate limiting by API key, this gives us pretty good protection against abuse.

Bob: Alright, I'm starting to come around on this. But I want to make sure we have a solid rollback plan. If we deploy GraphQL and something goes wrong, can we revert to REST without data loss or downtime?

Alice: Absolutely. The plan would be to deploy GraphQL alongside REST initially, with both pointing to the same underlying services. We'd route a percentage of traffic to GraphQL using feature flags, monitor for errors, and gradually increase. If anything goes wrong, we flip the flag back to zero. After a month of stable operation, we can start deprecating the REST endpoints with a three-month sunset period.

Charlie: One more thing — what about tooling and developer experience? Our frontend team uses React Query which works great with REST. Will they need to learn a whole new library?

Alice: Actually React Query works just as well with GraphQL, and there's also urql and Apollo Client. But I think the bigger DX win is that with GraphQL, the frontend team won't need to coordinate with the backend team every time they need a new field. They can just add it to their query. The GraphQL schema becomes a contract between teams, and each team can move at their own pace.

Bob: That's actually a compelling argument for our specific situation. The current process where frontend files a ticket for a new API field, backend implements it, deploys it, and then frontend can use it takes about a week end to end. With GraphQL, as long as the field exists in the data model, frontend can just query it.

Charlie: I'm sold on the benefits but I want to see numbers. Can we do a two-week spike to measure performance, complexity, and developer experience before committing to a full migration?

Alice: That's exactly what I was going to propose. I'll write up a spike proposal with specific success criteria including query performance, caching efficiency, developer satisfaction survey, and infrastructure cost impact. We can review it at next week's architecture meeting.

Bob: Sounds like a plan. I'll start looking into GraphQL schema design patterns and data loader best practices so I'm ready for the spike.

Charlie: And I'll research GraphQL CDN options and query complexity middlewares. Let's sync again next week with our findings.`;

  return [mi("bench-convo", "decision", convo)];
}

// ═══════════════════════════════════════════════════════════════════════
// Benchmark runner
// ═══════════════════════════════════════════════════════════════════════

interface ItemResult {
  id: string;
  beforeTokens: number;
  afterTokens: number;
  savingsPct: number;
  autoType: MemoryContentType;
  forcedType: MemoryContentType;
  compressed: boolean;
  retrievable: boolean;
  forcedAfterTokens: number;
  forcedSavingsPct: number;
}

interface ScenarioResult {
  name: string;
  scenario: string;
  description: string;
  items: ItemResult[];
  sumBefore: number;
  sumAfter: number;
  sumForcedAfter: number;
  savingsPct: number;
  forcedSavingsPct: number;
}

function benchItemAuto(item: MemoryItem): {
  afterTokens: number;
  detectedType: MemoryContentType;
  compressed: boolean;
  retrievable: boolean;
} {
  const smart = renderDetailSmart(item);
  return {
    afterTokens: estimateTokens(smart.displayContent),
    detectedType: smart.contentType,
    compressed: smart.compressed,
    retrievable: smart.deferred !== null,
  };
}

function benchItemForced(item: MemoryItem, forceType: MemoryContentType): number {
  const rendered = renderContentByType(item, { forceType });
  let displayText = rendered.display;

  if (forceType === "prose" && !rendered.compressed) {
    const ccrResult = compressDetail(item);
    displayText = ccrResult.display;
  }

  return estimateTokens(displayText);
}

function runFixture(
  name: string,
  scenario: string,
  description: string,
  items: { item: MemoryItem; expectedType: MemoryContentType }[],
): ScenarioResult {
  resetCcrStore();

  const results: ItemResult[] = [];
  let sumBefore = 0,
    sumAfter = 0,
    sumForcedAfter = 0;

  for (const { item, expectedType } of items) {
    const before = estimateTokens(item.text);
    const auto = benchItemAuto(item);
    const forcedAfter = benchItemForced(item, expectedType);

    const autoSavings =
      before > 0 ? Math.round(((before - auto.afterTokens) / before) * 1000) / 10 : 0;
    const forcedSavings =
      before > 0 ? Math.round(((before - forcedAfter) / before) * 1000) / 10 : 0;

    results.push({
      id: item.id,
      beforeTokens: before,
      afterTokens: auto.afterTokens,
      savingsPct: Math.max(0, autoSavings),
      autoType: auto.detectedType,
      forcedType: expectedType,
      compressed: auto.compressed,
      retrievable: auto.retrievable,
      forcedAfterTokens: forcedAfter,
      forcedSavingsPct: Math.max(0, forcedSavings),
    });

    sumBefore += before;
    sumAfter += auto.afterTokens;
    sumForcedAfter += forcedAfter;
  }

  return {
    name,
    scenario,
    description,
    items: results,
    sumBefore,
    sumAfter,
    sumForcedAfter,
    savingsPct: sumBefore > 0 ? Math.round(((sumBefore - sumAfter) / sumBefore) * 1000) / 10 : 0,
    forcedSavingsPct:
      sumBefore > 0 ? Math.round(((sumBefore - sumForcedAfter) / sumBefore) * 1000) / 10 : 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Display
// ═══════════════════════════════════════════════════════════════════════

const B = "\x1b[1m",
  G = "\x1b[32m",
  Y = "\x1b[33m",
  C = "\x1b[36m",
  R = "\x1b[31m",
  D = "\x1b[90m",
  N = "\x1b[0m";

function bar(percent: number, width = 18): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  let color = G;
  if (clamped < 30) {
    color = R;
  } else if (clamped < 60) {
    color = Y;
  }
  return `${color}${"█".repeat(filled)}${D}${"░".repeat(empty)}${N}`;
}

function printResults(all: ScenarioResult[]): void {
  console.log(`\n${B}${"═".repeat(100)}${N}`);
  console.log(`${B}  triMemh Token Compression Benchmark — ContentRouter → CCR Pipeline${N}`);
  console.log(`${B}${"═".repeat(100)}${N}\n`);

  const totalBefore = all.reduce((s, r) => s + r.sumBefore, 0);
  const totalAfter = all.reduce((s, r) => s + r.sumAfter, 0);
  const totalForcedAfter = all.reduce((s, r) => s + r.sumForcedAfter, 0);
  const totalSv = totalBefore > 0 ? ((totalBefore - totalAfter) / totalBefore) * 100 : 0;
  const totalFsv = totalBefore > 0 ? ((totalBefore - totalForcedAfter) / totalBefore) * 100 : 0;

  console.log(
    `  ${B}${D}Scenario                                 Before    After     Auto %   Forced%   Bar (auto)${N}`,
  );
  console.log(`  ${D}${"─".repeat(98)}${N}`);

  for (const s of all) {
    const label = s.name.padEnd(38);
    const b4 = fmt(s.sumBefore).padStart(8);
    const aft = fmt(s.sumAfter).padStart(8);
    const sv = `${s.savingsPct.toFixed(0)}%`.padStart(7);
    const fsv = `${s.forcedSavingsPct.toFixed(0)}%`.padStart(7);
    const b = bar(s.savingsPct);

    console.log(`  ${C}${label}${N} ${b4} ${aft} ${sv}  ${fsv}  ${b}`);

    if (s.items.length > 1) {
      for (const it of s.items) {
        const id = it.id.slice(-22).padStart(22);
        const ib = fmt(it.beforeTokens).padStart(8);
        const ia = fmt(it.afterTokens).padStart(8);
        const isv = `${it.savingsPct.toFixed(0)}%`.padStart(7);
        const ifv = `${it.forcedSavingsPct.toFixed(0)}%`.padStart(7);
        const match = it.autoType === it.forcedType ? `${G}✓${N}` : `${Y}✗→${it.forcedType}${N}`;
        console.log(`    ${D}└─ ${id}${N} ${ib} ${ia} ${isv}  ${ifv}  ${match}`);
      }
    }
  }

  console.log(`  ${D}${"─".repeat(98)}${N}`);
  console.log(
    `  ${B}${"TOTAL".padEnd(38)}${N} ${B}${fmt(totalBefore).padStart(8)}${N} ${B}${fmt(totalAfter).padStart(8)}${N} ${B}${totalSv.toFixed(0)}%${N}  ${B}${totalFsv.toFixed(0)}%${N}`,
  );
  console.log();
}

// ═══════════════════════════════════════════════════════════════════════
// Headroom comparison
// ═══════════════════════════════════════════════════════════════════════

// biome-ignore lint/nursery/noShadow: warning suppression
function printComparison(results: ScenarioResult[]): void {
  console.log(`  ${B}Comparison vs headroom benchmarks (real production workloads):${N}\n`);

  const baselines: Record<string, { savings: number; before: number; after: number }> = {
    code_search: { savings: 92, before: 17765, after: 1408 },
    sre_incident: { savings: 92, before: 65694, after: 5118 },
    issue_triage: { savings: 73, before: 54174, after: 14761 },
    codebase_exploration: { savings: 47, before: 78502, after: 41254 },
  };

  console.log(
    `  ${D}Scenario                          trimemh(auto)  trimemh(opt)  headroom   Δ (opt vs headroom)${N}`,
  );
  console.log(`  ${D}${"─".repeat(92)}${N}`);

  for (const r of results) {
    const base = baselines[r.scenario];
    if (!base) {
      continue;
    }

    const memhAuto = `${r.savingsPct.toFixed(0)}%`.padStart(4);
    const memhOpt = `${r.forcedSavingsPct.toFixed(0)}%`.padStart(4);
    const hr = `${base.savings}%`.padStart(4);
    const delta = r.forcedSavingsPct - base.savings;
    let deltaStr: string;
    if (Math.abs(delta) <= 8) {
      deltaStr = `${G}≈ parity (±8%)${N}`;
    } else if (delta > 0) {
      deltaStr = `${G}+${delta}% better${N}`;
    } else {
      deltaStr = `${R}${delta.toFixed(0)}% behind${N}`;
    }

    console.log(
      `  ${r.scenario.padEnd(32)} ${memhAuto}        ${memhOpt}       ${hr}     ${deltaStr}`,
    );
  }
  console.log();
  console.log(
    `  ${D}Note: headroom uses real production data + ML models (Kompress-base + AST code compressor).${N}`,
  );
  console.log(
    `  ${D}triMemh uses regex-based ContentRouter + sentence-based CCR. Fixtures are simulated.${N}`,
  );
  console.log();
}

// ═══════════════════════════════════════════════════════════════════════
// Diagnosis
// ═══════════════════════════════════════════════════════════════════════

// biome-ignore lint/nursery/noShadow: warning suppression
function printDiagnosis(results: ScenarioResult[]): void {
  console.log(`  ${B}Diagnosis & Priority Improvements:${N}\n`);

  // Find types with auto→forced misdetection gap
  const typeStats = new Map<
    string,
    { before: number; autoAfter: number; forcedAfter: number; count: number }
  >();
  for (const s of results) {
    for (const it of s.items) {
      const key = it.forcedType;
      const st = typeStats.get(key) ?? { before: 0, autoAfter: 0, forcedAfter: 0, count: 0 };
      st.before += it.beforeTokens;
      st.autoAfter += it.afterTokens;
      st.forcedAfter += it.forcedAfterTokens;
      st.count++;
      typeStats.set(key, st);
    }
  }

  const gaps = [...typeStats.entries()]
    .map(([type, st]) => {
      const autoSv = st.before > 0 ? ((st.before - st.autoAfter) / st.before) * 100 : 0;
      const forcedSv = st.before > 0 ? ((st.before - st.forcedAfter) / st.before) * 100 : 0;
      return { type, gap: forcedSv - autoSv, autoSv, forcedSv, tokens: st.before };
    })
    .sort((a, b) => b.gap - a.gap);

  for (const g of gaps) {
    if (g.gap <= 2) {
      console.log(
        `  ${G}✓${N} ${contentTypeLabel(g.type as MemoryContentType).padEnd(22)} auto=${g.autoSv.toFixed(0)}% optimal=${g.forcedSv.toFixed(0)}%  ${D}detection is optimal${N}`,
      );
    } else {
      const impact =
        g.tokens > 10000 ? `${R}HIGH${N}` : g.tokens > 3000 ? `${Y}MED${N}` : `${D}LOW${N}`;
      console.log(
        `  ${Y}⚠${N} ${contentTypeLabel(g.type as MemoryContentType).padEnd(22)} auto=${g.autoSv.toFixed(0)}% optimal=${g.forcedSv.toFixed(0)}%  gap=${g.gap.toFixed(0)}% impact:${impact} (${fmt(g.tokens)} tokens)`,
      );
    }
  }

  console.log();
  console.log(`  ${B}To close the gap with headroom:${N}`);
  console.log(
    `  1. ${Y}AST-aware code compression${N} — replace regex signatures with tree-sitter`,
  );
  console.log(`  2. ${Y}Prose ML compression${N} — train small local model like Kompress-base`);
  console.log(`  3. ${Y}Multi-item splitting${N} — detect mixed content and split before routing`);
  console.log(
    `  4. ${G}Already strong:${N} config (key-only), logs (error-filter+dedup), diffs (file stats)`,
  );
  console.log();
}

// ═══════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════

console.log(`${D}triMemh token compression benchmark${N}`);
console.log(`${D}Generating realistic fixtures...${N}`);

const codeSearchItems = makeCodeSearchFixture();
const sreItems = makeSreFixture();
const issueItems = makeIssueTriageFixture();
const codebaseItems = makeCodebaseFixture();
const convoItems = makeConversationFixture();

console.log(`${D}Running pipeline (ContentRouter → CCR → Deferred tracking)...${N}\n`);

const issue0 = issueItems[0];
const issue1 = issueItems[1];
const issue2 = issueItems[2];
if (!(issue0 && issue1 && issue2)) {
  throw new Error("Missing issue items");
}

const cb0 = codebaseItems[0];
const cb1 = codebaseItems[1];
const cb2 = codebaseItems[2];
if (!(cb0 && cb1 && cb2)) {
  throw new Error("Missing codebase items");
}

const results: ScenarioResult[] = [
  runFixture(
    "Code Search (100 results)",
    "code_search",
    "JSON output: 100 code search results with file paths, snippets, metadata",
    codeSearchItems.map((i) => ({ item: i, expectedType: "json" as MemoryContentType })),
  ),

  runFixture(
    "SRE Incident Debugging",
    "sre_incident",
    "800 production log lines during DB connection pool outage, with stack traces",
    sreItems.map((i) => ({ item: i, expectedType: "log" as MemoryContentType })),
  ),

  runFixture(
    "GitHub Issue Triage",
    "issue_triage",
    "Bug report: prose description + code fix + error logs (3 separate items)",
    [
      { item: issue0, expectedType: "prose" as MemoryContentType },
      { item: issue1, expectedType: "code" as MemoryContentType },
      { item: issue2, expectedType: "log" as MemoryContentType },
    ],
  ),

  runFixture(
    "Codebase Exploration",
    "codebase_exploration",
    ".env config (30 keys) + TypeScript handler (~150 lines) + git diff (~30 lines)",
    [
      { item: cb0, expectedType: "config" as MemoryContentType },
      { item: cb1, expectedType: "code" as MemoryContentType },
      { item: cb2, expectedType: "diff" as MemoryContentType },
    ],
  ),

  runFixture(
    "Architecture Discussion (prose)",
    "architecture_discussion",
    "Team discussion about REST→GraphQL migration (~1200 words pure prose)",
    convoItems.map((i) => ({ item: i, expectedType: "prose" as MemoryContentType })),
  ),
];

printResults(results);
printComparison(results);
printDiagnosis(results);

const allBefore = results.reduce((s, r) => s + r.sumBefore, 0);
const allAfter = results.reduce((s, r) => s + r.sumAfter, 0);
const allForced = results.reduce((s, r) => s + r.sumForcedAfter, 0);
const allSv = allBefore > 0 ? ((allBefore - allAfter) / allBefore) * 100 : 0;
const allFsv = allBefore > 0 ? ((allBefore - allForced) / allBefore) * 100 : 0;

console.log(
  `  ${B}${G}Benchmark complete.${N}  Total: ${fmt(allBefore)} → ${fmt(allAfter)} tokens (auto: ${allSv.toFixed(0)}%) | → ${fmt(allForced)} tokens (optimal: ${allFsv.toFixed(0)}%)`,
);
console.log(`  Run again: ${D}bun run scripts/benchmark.ts${N}\n`);
