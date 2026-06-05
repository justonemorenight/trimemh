import { beforeEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_TOOL_LIMITS,
  RateLimiter,
  getRateLimiter,
  resetRateLimiter,
} from "../src/infrastructure/rate-limit";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(DEFAULT_TOOL_LIMITS);
  });

  test("allows first request", () => {
    const result = limiter.check("memory_search");
    expect(result.allowed).toBe(true);
    expect(result.retryAfter).toBe(0);
  });

  test("allows up to capacity burst requests", () => {
    // biome-ignore lint/style/noNonNullAssertion: warning suppression
    const config = DEFAULT_TOOL_LIMITS.memory_search!;
    for (let i = 0; i < config.capacity; i++) {
      const result = limiter.check("memory_search");
      expect(result.allowed).toBe(true);
    }
  });

  test("denies request once bucket is empty", () => {
    // biome-ignore lint/style/noNonNullAssertion: warning suppression
    const config = DEFAULT_TOOL_LIMITS.memory_search!;
    // Exhaust the bucket
    for (let i = 0; i < config.capacity; i++) {
      limiter.check("memory_search");
    }
    const result = limiter.check("memory_search");
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  test("retryAfter is reasonable", () => {
    // biome-ignore lint/style/noNonNullAssertion: warning suppression
    const config = DEFAULT_TOOL_LIMITS.memory_search!;
    // Exhaust the bucket
    for (let i = 0; i < config.capacity; i++) {
      limiter.check("memory_search");
    }
    const result = limiter.check("memory_search");
    expect(result.allowed).toBe(false);
    // retryAfter should be roughly 1 / refillRate seconds
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(result.retryAfter).toBeLessThanOrEqual(1.0);
  });

  test("each tool has independent buckets", () => {
    // biome-ignore lint/style/noNonNullAssertion: warning suppression
    const searchConfig = DEFAULT_TOOL_LIMITS.memory_search!;
    // Exhaust memory_search bucket
    for (let i = 0; i < searchConfig.capacity; i++) {
      limiter.check("memory_search");
    }
    const searchResult = limiter.check("memory_search");
    expect(searchResult.allowed).toBe(false);

    // memory_stats should still work
    const statsResult = limiter.check("memory_stats");
    expect(statsResult.allowed).toBe(true);
  });

  test("snapshot returns token counts", () => {
    limiter.check("memory_search");
    limiter.check("memory_get");
    const snap = limiter.snapshot();
    expect(snap.memory_search).toBeDefined();
    expect(snap.memory_get).toBeDefined();
    expect(snap.memory_search?.capacity).toBe(DEFAULT_TOOL_LIMITS.memory_search?.capacity);
  });

  test("reset clears all buckets", () => {
    limiter.check("memory_search");
    limiter.reset();
    // After reset, first request should be allowed
    const result = limiter.check("memory_search");
    expect(result.allowed).toBe(true);
    // Should have full capacity
    expect(result.remainingTokens).toBe(DEFAULT_TOOL_LIMITS.memory_search?.capacity - 1);
  });

  test("remainingTokens decreases with each request", () => {
    // biome-ignore lint/style/noNonNullAssertion: warning suppression
    const config = DEFAULT_TOOL_LIMITS.memory_search!;
    const result1 = limiter.check("memory_search");
    expect(result1.remainingTokens).toBe(config.capacity - 1);
    const result2 = limiter.check("memory_search");
    expect(result2.remainingTokens).toBe(config.capacity - 2);
  });

  test("unknown tools use default config", () => {
    const result = limiter.check("unknown_tool");
    expect(result.allowed).toBe(true);
  });
});

describe("getRateLimiter singleton", () => {
  beforeEach(() => {
    resetRateLimiter();
  });

  test("returns the same instance on subsequent calls", () => {
    const a = getRateLimiter();
    const b = getRateLimiter();
    expect(a).toBe(b);
  });

  test("merges overrides with defaults", () => {
    const limiter = getRateLimiter({
      memory_search: { capacity: 5 },
    });
    const result = limiter.check("memory_search");
    expect(result.allowed).toBe(true);
    // Override capacity = 5, so after 1 request remaining = 4
    expect(result.remainingTokens).toBe(4);
  });
});
