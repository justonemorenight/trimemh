/**
 * LRU Memory Cache & Query Result Cache (Phase 1 — Foundation Hardening)
 *
 * Two-tier caching:
 * 1. MemoryItemCache — LRU cache for hot memory items, keyed by memory ID.
 * 2. QueryCache — TTL-based cache for search/query results, keyed by
 *    deterministic cache key derived from (projectId, query, limit, mode).
 *
 * Both caches are in-process only (no Redis dependency for local-first).
 * Typical memory footprint: <50 MB for 10K cached items.
 */

import { CONFIG } from "../config";
import type { MemoryItem } from "../domain/schema";

// ─── LRU Node ────────────────────────────────────────────────────────

interface LruNode<T> {
  key: string;
  value: T;
  prev: LruNode<T> | null;
  next: LruNode<T> | null;
}

// ─── Memory Item Cache ──────────────────────────────────────────────

export class MemoryItemCache {
  private map = new Map<string, LruNode<MemoryItem>>();
  private head: LruNode<MemoryItem> | null = null;
  private tail: LruNode<MemoryItem> | null = null;
  private maxSize: number;
  private hits = 0;
  private misses = 0;

  constructor(maxSize = CONFIG.cache.memoryItemMaxSize) {
    this.maxSize = maxSize;
  }

  get(id: string): MemoryItem | null {
    const node = this.map.get(id);
    if (!node) {
      this.misses++;
      return null;
    }
    this.hits++;
    this.moveToHead(node);
    return node.value;
  }

  set(item: MemoryItem): void {
    const existing = this.map.get(item.id);
    if (existing) {
      existing.value = item;
      this.moveToHead(existing);
      return;
    }

    const node: LruNode<MemoryItem> = {
      key: item.id,
      value: item,
      prev: null,
      next: this.head,
    };

    if (this.head) {
      this.head.prev = node;
    }
    this.head = node;

    if (!this.tail) {
      this.tail = node;
    }

    this.map.set(item.id, node);

    // Evict oldest if over capacity
    if (this.map.size > this.maxSize) {
      this.evictTail();
    }
  }

  invalidate(id: string): boolean {
    const node = this.map.get(id);
    if (!node) {
      return false;
    }
    this.removeNode(node);
    this.map.delete(id);
    return true;
  }

  clear(): void {
    this.map.clear();
    this.head = null;
    this.tail = null;
    this.hits = 0;
    this.misses = 0;
  }

  get size(): number {
    return this.map.size;
  }

  get hitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }

  stats(): { size: number; maxSize: number; hits: number; misses: number; hitRate: number } {
    return {
      size: this.map.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hitRate,
    };
  }

  // ─── Private ────────────────────────────────────────────────────

  private moveToHead(node: LruNode<MemoryItem>): void {
    if (node === this.head) {
      return;
    }
    this.removeNode(node);
    node.next = this.head;
    node.prev = null;
    if (this.head) {
      this.head.prev = node;
    }
    this.head = node;
    if (!this.tail) {
      this.tail = node;
    }
  }

  private removeNode(node: LruNode<MemoryItem>): void {
    if (node.prev) {
      node.prev.next = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    }
    if (node === this.head) {
      this.head = node.next;
    }
    if (node === this.tail) {
      this.tail = node.prev;
    }
  }

  private evictTail(): void {
    if (!this.tail) {
      return;
    }
    const evicted = this.tail;
    this.removeNode(evicted);
    this.map.delete(evicted.key);
  }
}

// ─── Query Cache ─────────────────────────────────────────────────────

export interface QueryCacheEntry<T> {
  result: T;
  createdAt: number;
  ttl: number; // ms
}

export class QueryCache {
  private cache = new Map<string, QueryCacheEntry<unknown>>();
  private defaultTTL: number;
  private hits = 0;
  private misses = 0;

  constructor(defaultTTLMs = CONFIG.cache.queryDefaultTtlMs) {
    this.defaultTTL = defaultTTLMs;
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (Date.now() - entry.createdAt > entry.ttl) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }
    this.hits++;
    return entry.result as T;
  }

  set<T>(key: string, result: T, ttl?: number): void {
    this.cache.set(key, {
      result,
      createdAt: Date.now(),
      ttl: ttl ?? this.defaultTTL,
    });
  }

  invalidate(key: string): boolean {
    return this.cache.delete(key);
  }

  /** Invalidate all entries matching a prefix (e.g., all queries for a project). */
  invalidatePrefix(prefix: string): number {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /** Remove expired entries. Call periodically or before stats. */
  expire(): number {
    let expired = 0;
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.createdAt > entry.ttl) {
        this.cache.delete(key);
        expired++;
      }
    }
    return expired;
  }

  get size(): number {
    return this.cache.size;
  }

  get hitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }

  stats(): { size: number; hits: number; misses: number; hitRate: number; defaultTTL: number } {
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hitRate,
      defaultTTL: this.defaultTTL,
    };
  }
}

// ─── Cache Key Builders ──────────────────────────────────────────────

export function searchCacheKey(
  projectId: string,
  query: string,
  mode: string,
  limit: number,
  kind?: string,
): string {
  return `search:${projectId}:${mode}:${query.slice(0, 100)}:${limit}:${kind ?? ""}`;
}

export function statsCacheKey(projectId: string): string {
  return `stats:${projectId}`;
}

export function relatedCacheKey(projectId: string, memoryId: string, depth: number): string {
  return `related:${projectId}:${memoryId}:${depth}`;
}

export function codeSearchCacheKey(projectId: string, path: string, symbol?: string): string {
  return `code:${projectId}:${path}:${symbol ?? ""}`;
}

// ─── Singleton instances ─────────────────────────────────────────────

let memoryCacheInstance: MemoryItemCache | null = null;
let queryCacheInstance: QueryCache | null = null;

export function getMemoryCache(maxSize?: number): MemoryItemCache {
  if (!memoryCacheInstance) {
    memoryCacheInstance = new MemoryItemCache(maxSize ?? CONFIG.cache.memoryItemMaxSize);
  }
  return memoryCacheInstance;
}

export function getQueryCache(defaultTTLMs?: number): QueryCache {
  if (!queryCacheInstance) {
    queryCacheInstance = new QueryCache(defaultTTLMs ?? CONFIG.cache.queryDefaultTtlMs);
  }
  return queryCacheInstance;
}

export function resetCaches(): void {
  if (memoryCacheInstance) {
    memoryCacheInstance.clear();
  }
  if (queryCacheInstance) {
    queryCacheInstance.clear();
  }
  memoryCacheInstance = null;
  queryCacheInstance = null;
}
