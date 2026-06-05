import { beforeEach, describe, expect, test } from "bun:test";

import type { MemoryItem } from "../src/domain/schema";
import {
  MemoryItemCache,
  QueryCache,
  codeSearchCacheKey,
  getMemoryCache,
  getQueryCache,
  relatedCacheKey,
  resetCaches,
  searchCacheKey,
  statsCacheKey,
} from "../src/infrastructure/cache";

function makeMemory(id: string, text = "test memory"): MemoryItem {
  return {
    id,
    project_id: "test-project",
    kind: "fact",
    text,
    status: "active",
    visibility: "private",
    confidence: 0.8,
    source: "test",
    content_hash: `hash-${id}`,
    evidence_json: "[]",
    metadata_json: "{}",
    embedding: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    expires_at: null,
  };
}

describe("MemoryItemCache", () => {
  let cache: MemoryItemCache;

  beforeEach(() => {
    cache = new MemoryItemCache(10);
  });

  test("stores and retrieves items", () => {
    const item = makeMemory("mem-1");
    cache.set(item);
    const retrieved = cache.get("mem-1");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe("mem-1");
    expect(retrieved?.text).toBe("test memory");
  });

  test("returns null for missing items", () => {
    const retrieved = cache.get("nonexistent");
    expect(retrieved).toBeNull();
  });

  test("evicts oldest item when over capacity", () => {
    // Fill cache to capacity
    for (let i = 0; i < 10; i++) {
      cache.set(makeMemory(`mem-${i}`, `text ${i}`));
    }
    // Access mem-0 to make it recently used
    cache.get("mem-0");
    // Add one more to trigger eviction (mem-1 should be evicted, not mem-0)
    cache.set(makeMemory("mem-new", "new text"));

    expect(cache.get("mem-0")).not.toBeNull(); // recently accessed → kept
    expect(cache.get("mem-new")).not.toBeNull();
    expect(cache.size).toBe(10);
  });

  test("invalidates item by id", () => {
    cache.set(makeMemory("mem-1"));
    expect(cache.get("mem-1")).not.toBeNull();

    cache.invalidate("mem-1");
    expect(cache.get("mem-1")).toBeNull();
  });

  test("clear removes all items", () => {
    cache.set(makeMemory("mem-1"));
    cache.set(makeMemory("mem-2"));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("mem-1")).toBeNull();
  });

  test("tracks hit/miss stats", () => {
    cache.set(makeMemory("mem-1"));
    cache.get("mem-1"); // hit
    cache.get("mem-1"); // hit
    cache.get("mem-2"); // miss

    const stats = cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(2 / 3);
  });

  test("updates existing item on set", () => {
    cache.set(makeMemory("mem-1", "original"));
    cache.set(makeMemory("mem-1", "updated"));
    const item = cache.get("mem-1");
    expect(item?.text).toBe("updated");
  });
});

describe("QueryCache", () => {
  let cache: QueryCache;

  beforeEach(() => {
    cache = new QueryCache(1000); // 1s TTL
  });

  test("stores and retrieves results", () => {
    cache.set("key1", { data: "hello" });
    const result = cache.get<{ data: string }>("key1");
    expect(result).not.toBeNull();
    expect(result?.data).toBe("hello");
  });

  test("returns null for expired entries", async () => {
    cache.set("key1", { data: "hello" }, 10); // 10ms TTL
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = cache.get("key1");
    expect(result).toBeNull();
  });

  test("invalidates by key", () => {
    cache.set("key1", { data: "hello" });
    cache.invalidate("key1");
    expect(cache.get("key1")).toBeNull();
  });

  test("invalidates by prefix", () => {
    cache.set("search:proj1:query1", "r1");
    cache.set("search:proj1:query2", "r2");
    cache.set("stats:proj1", "r3");

    const count = cache.invalidatePrefix("search:proj1");
    expect(count).toBe(2);
    expect(cache.get("search:proj1:query1")).toBeNull();
    expect(cache.get("search:proj1:query2")).toBeNull();
    expect(cache.get("stats:proj1")).not.toBeNull();
  });

  test("tracks hit/miss stats", () => {
    cache.set("key1", "val1");
    cache.get("key1"); // hit
    cache.get("key2"); // miss

    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });

  test("expire removes stale entries", async () => {
    cache.set("key1", "val1", 10); // 10ms TTL
    await new Promise((resolve) => setTimeout(resolve, 20));
    const expired = cache.expire();
    expect(expired).toBeGreaterThanOrEqual(1);
    expect(cache.size).toBe(0);
  });

  test("clear removes all entries", () => {
    cache.set("key1", "val1");
    cache.set("key2", "val2");
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe("Cache key builders", () => {
  test("searchCacheKey produces deterministic keys", () => {
    const key1 = searchCacheKey("p1", "error handling", "hybrid", 10, "procedure");
    const key2 = searchCacheKey("p1", "error handling", "hybrid", 10, "procedure");
    expect(key1).toBe(key2);
  });

  test("searchCacheKey differs by mode", () => {
    const ftsKey = searchCacheKey("p1", "query", "fts", 10);
    const hybridKey = searchCacheKey("p1", "query", "hybrid", 10);
    expect(ftsKey).not.toBe(hybridKey);
  });

  test("statsCacheKey includes projectId", () => {
    const key = statsCacheKey("project-a");
    expect(key).toContain("project-a");
  });

  test("relatedCacheKey includes memoryId and depth", () => {
    const key = relatedCacheKey("p1", "mem-123", 2);
    expect(key).toContain("mem-123");
    expect(key).toContain("2");
  });

  test("codeSearchCacheKey includes path and optional symbol", () => {
    const key1 = codeSearchCacheKey("p1", "/src/app.ts", "MyClass");
    const key2 = codeSearchCacheKey("p1", "/src/app.ts");
    expect(key1).not.toBe(key2);
    expect(key2).not.toContain("MyClass");
  });
});

describe("Cache singletons", () => {
  beforeEach(() => {
    resetCaches();
  });

  test("getMemoryCache returns singleton", () => {
    const a = getMemoryCache();
    const b = getMemoryCache();
    expect(a).toBe(b);
  });

  test("getQueryCache returns singleton", () => {
    const a = getQueryCache();
    const b = getQueryCache();
    expect(a).toBe(b);
  });

  test("resetCaches clears and creates new instances", () => {
    const a = getMemoryCache();
    a.set(makeMemory("mem-1"));
    resetCaches();
    const b = getMemoryCache();
    expect(b.size).toBe(0);
    expect(a).not.toBe(b); // new instance
  });
});
