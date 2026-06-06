/**
 * Token Bucket Rate Limiter (Phase 1 — Foundation Hardening)
 *
 * Provides per-tool rate limiting for MCP, API, and CLI surfaces.
 * Uses the token-bucket algorithm: each tool has a bucket that refills
 * at a configurable rate. Requests consume tokens; when the bucket is
 * empty the request is denied with a 429-style error.
 *
 * Thread-safe for single-process Bun runtime (no multi-threading).
 */

import { CONFIG } from "../config";

// ─── Types ──────────────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Maximum tokens the bucket can hold (burst capacity). */
  capacity: number;
  /** Tokens refilled per second (sustained rate). */
  refillRate: number;
  /** Human-readable label for error messages. */
  label?: string;
}

export interface RateLimitState {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until next token is available (0 if allowed). */
  retryAfter: number;
  /** Current token count for observability. */
  remainingTokens: number;
}

export const DEFAULT_TOOL_LIMITS: Record<string, RateLimitConfig> = CONFIG.rateLimit.tools;

// ─── Rate limiter implementation ────────────────────────────────────

export class RateLimiter {
  private buckets = new Map<string, RateLimitState>();
  private configs: Record<string, RateLimitConfig>;

  constructor(configs: Record<string, RateLimitConfig> = {}) {
    this.configs = configs;
  }

  /**
   * Check whether a request for the given tool is allowed.
   * Consumes one token if allowed.
   */
  check(toolName: string): RateLimitResult {
    const config = this.configs[toolName] ?? CONFIG.rateLimit.defaultConfig;
    const state = this.getOrCreateBucket(toolName, config);
    const now = nowSeconds();

    // Refill tokens based on elapsed time
    const elapsed = now - state.lastRefill;
    const refill = elapsed * config.refillRate;
    state.tokens = Math.min(config.capacity, state.tokens + refill);
    state.lastRefill = now;

    if (state.tokens >= 1.0) {
      state.tokens -= 1.0;
      return {
        allowed: true,
        retryAfter: 0,
        remainingTokens: Math.floor(state.tokens),
      };
    }

    // Not enough tokens — compute retry-after
    const retryAfter = (1.0 - state.tokens) / config.refillRate;
    return {
      allowed: false,
      retryAfter: Math.ceil(retryAfter * 100) / 100,
      remainingTokens: 0,
    };
  }

  /**
   * Reset all buckets — useful for testing.
   */
  reset(): void {
    this.buckets.clear();
  }

  /**
   * Get current token counts for all tools (observability).
   */
  snapshot(): Record<string, { tokens: number; capacity: number }> {
    const result: Record<string, { tokens: number; capacity: number }> = {};
    for (const [tool, state] of this.buckets) {
      const config = this.configs[tool] ?? CONFIG.rateLimit.defaultConfig;
      result[tool] = {
        tokens: Math.floor(state.tokens),
        capacity: config.capacity,
      };
    }
    return result;
  }

  // ─── Private helpers ────────────────────────────────────────────

  private getOrCreateBucket(toolName: string, config: RateLimitConfig): RateLimitState {
    const existing = this.buckets.get(toolName);
    if (existing) {
      return existing;
    }

    const state: RateLimitState = {
      tokens: config.capacity, // start full
      lastRefill: nowSeconds(),
    };
    this.buckets.set(toolName, state);
    return state;
  }
}

// ─── Singleton instance ─────────────────────────────────────────────

let defaultInstance: RateLimiter | null = null;

export function getRateLimiter(overrides?: Record<string, Partial<RateLimitConfig>>): RateLimiter {
  if (!overrides && defaultInstance) {
    return defaultInstance;
  }

  const merged: Record<string, RateLimitConfig> = {};
  for (const [tool, defaults] of Object.entries(CONFIG.rateLimit.tools)) {
    const override = overrides?.[tool];
    merged[tool] = {
      capacity: override?.capacity ?? defaults.capacity,
      refillRate: override?.refillRate ?? defaults.refillRate,
      label: override?.label ?? defaults.label,
    };
  }

  const instance = new RateLimiter(merged);
  if (!overrides) {
    defaultInstance = instance;
  }
  return instance;
}

export function resetRateLimiter(): void {
  if (defaultInstance) {
    defaultInstance.reset();
  }
  defaultInstance = null;
}

// ─── Helpers ────────────────────────────────────────────────────────

function nowSeconds(): number {
  return Date.now() / 1000;
}
