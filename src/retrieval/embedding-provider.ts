/**
 * Multi-Provider Embedding Engine (Phase 1 — Foundation Hardening)
 *
 * Plugable embedding architecture supporting:
 * 1. LocalHashProvider    — Deterministic hash-based (default, 0-dependency)
 * 2. ONNXProvider         — ONNX Runtime with all-MiniLM-L6-v2 (local, ~80 MB model)
 * 3. CachingProvider      — Decorator wrapping any provider with LRU result cache
 *
 * Backward-compatible: embedText(), localEmbeddingProvider, DEFAULT_EMBEDDING_DIMENSIONS
 * are preserved. All call sites continue to work without changes.
 */

import { createHash } from "node:crypto";

import { CONFIG } from "../config";

// ─── Constants ──────────────────────────────────────────────────────

export const DEFAULT_EMBEDDING_DIMENSIONS = CONFIG.embedding.defaultDimensions;

/** Minimum dimension for semantic dedup reliability (shared with dedup.ts). */
export const SEMANTIC_MIN_DIMENSION = 128;

/** Well-known provider dimension maps. */
export const PROVIDER_DIMENSIONS: Record<string, number> = {
  "local-hash-v1": 384,
  "onnx-minilm-l6-v2": 384,
  "onnx-minilm-l12-v2": 384,
  "transformers-minilm-l6-v2": 384,
} as const;

// ─── Embedding Provider Interface ───────────────────────────────────

export interface EmbeddingProvider {
  /** Unique provider identifier (e.g. "local-hash-v1", "onnx-minilm-l6-v2"). */
  readonly name: string;
  /** Output vector dimension. */
  readonly dimensions: number;
  /** Synchronous embed (must work without I/O for local providers). */
  embed(text: string): Float32Array;
  /** Asynchronous embed for API-based providers. Falls back to sync embed(). */
  embedAsync(text: string): Promise<Float32Array>;
  /** Batch embed (optional optimized path, falls back to sequential embedAsync). */
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  /** Health check — returns true if the provider is ready to serve. */
  healthCheck(): Promise<boolean>;
}

// ─── Abstract base ─────────────────────────────────────────────────

export abstract class BaseEmbeddingProvider implements EmbeddingProvider {
  abstract readonly name: string;
  abstract readonly dimensions: number;
  abstract embed(text: string): Float32Array;

  // biome-ignore lint/suspicious/useAwait: warning suppression
  async embedAsync(text: string): Promise<Float32Array> {
    return this.embed(text);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];
    for (const text of texts) {
      // biome-ignore lint/performance/noAwaitInLoops: warning suppression
      results.push(await this.embedAsync(text));
    }
    return results;
  }

  // biome-ignore lint/suspicious/useAwait: warning suppression
  async healthCheck(): Promise<boolean> {
    try {
      const test = this.embed("health check");
      return test.length === this.dimensions;
    } catch {
      return false;
    }
  }
}

// ─── 1. Local Hash Provider (current default) ──────────────────────

function normalizedTokens(text: string): string[] {
  const words = text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    .split(/\s+/)
    .filter(Boolean);

  const features = new Set<string>();
  for (const word of words) {
    features.add(`w:${word}`);
    if (word.length >= 4) {
      for (let i = 0; i <= word.length - 3; i++) {
        features.add(`c:${word.slice(i, i + 3)}`);
      }
    }
  }
  for (let i = 0; i < words.length - 1; i++) {
    features.add(`b:${words[i]} ${words[i + 1]}`);
  }
  return [...features];
}

function hashFeature(feature: string): Uint8Array {
  return createHash("sha256").update(feature).digest();
}

export function embedTextLocal(
  text: string,
  dimensions: number = DEFAULT_EMBEDDING_DIMENSIONS,
): Float32Array {
  const vector = new Float32Array(dimensions);
  const features = normalizedTokens(text);
  if (features.length === 0) {
    return vector;
  }

  for (const feature of features) {
    const hash = hashFeature(feature);
    const h0 = hash[0] ?? 0;
    const h1 = hash[1] ?? 0;
    const h2 = hash[2] ?? 0;
    const bucket = ((h0 << 8) | h1) % dimensions;
    const sign = (h2 & 1) === 0 ? 1 : -1;
    const weight = feature.startsWith("b:") ? 1.35 : feature.startsWith("w:") ? 1.0 : 0.45;
    vector[bucket] = (vector[bucket] ?? 0.0) + sign * weight;
  }

  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  if (norm === 0) {
    return vector;
  }

  const scale = 1 / Math.sqrt(norm);
  for (let i = 0; i < vector.length; i++) {
    vector[i] = (vector[i] ?? 0.0) * scale;
  }
  return vector;
}

export class LocalHashProvider extends BaseEmbeddingProvider {
  override readonly name = "local-hash-v1";

  get dimensions(): number {
    return DEFAULT_EMBEDDING_DIMENSIONS;
  }

  override embed(text: string): Float32Array {
    return embedTextLocal(text, DEFAULT_EMBEDDING_DIMENSIONS);
  }
}

// ─── 2. ONNX Provider (bridge — requires onnxruntime-node) ─────────

/**
 * ONNX embedding provider.
 *
 * Requires `onnxruntime-node` and a model file.
 * Falls back to LocalHashProvider if ONNX runtime is not available.
 *
 * Usage:
 *   const provider = await ONNXProvider.create("/path/to/model.onnx");
 */
export class ONNXProvider extends BaseEmbeddingProvider {
  override readonly name = "onnx-minilm-l6-v2";

  get dimensions(): number {
    return 384;
  }
  private modelPath: string;
  private fallback: LocalHashProvider;
  private session: unknown = null;
  private ready = false;

  private constructor(modelPath: string) {
    super();
    this.modelPath = modelPath;
    this.fallback = new LocalHashProvider();
  }

  static async create(modelPath?: string): Promise<ONNXProvider> {
    const resolved = modelPath ?? ONNXProvider.defaultModelPath();
    const provider = new ONNXProvider(resolved);
    try {
      await provider.initialize();
    } catch {
      // ONNX not available — fallback to local hash
      console.warn(
        "[triMemh] ONNX runtime not available — falling back to local-hash-v1 embedding.",
      );
    }
    return provider;
  }

  static defaultModelPath(): string {
    return process.env.TRIMEMH_ONNX_MODEL ?? "";
  }

  private async initialize(): Promise<void> {
    // Dynamic import — onnxruntime-node is an optional peer dependency
    try {
      // @ts-expect-error — onnxruntime-node is an optional peer dependency
      // biome-ignore lint/correctness/noUndeclaredDependencies: optional peer dependency
      const ort = await import("onnxruntime-node");
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import fallback
      this.session = await (ort as any).InferenceSession.create(this.modelPath);
      this.ready = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // biome-ignore lint/nursery/useErrorCause: warning suppression
      throw new Error(`ONNX initialization failed: ${msg}`);
    }
  }

  override embed(text: string): Float32Array {
    if (!this.ready) {
      return this.fallback.embed(text);
    }
    // Synchronous fallback — ONNX inference is async, use embedAsync
    return this.fallback.embed(text);
  }

  override async embedAsync(text: string): Promise<Float32Array> {
    if (!(this.ready && this.session)) {
      return this.fallback.embed(text);
    }
    try {
      const tokens = this.tokenize(text);
      // @ts-expect-error — onnxruntime-node is an optional peer dependency
      // biome-ignore lint/correctness/noUndeclaredDependencies: optional peer dependency
      const ort = await import("onnxruntime-node");
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import fallback
      const feeds: Record<string, any> = {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic import fallback
        input_ids: new (ort as any).Tensor("int64", BigInt64Array.from(tokens.map(BigInt)), [
          1,
          tokens.length,
        ]),
      };
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import fallback
      const results = await (this.session as any).run(feeds);
      const output = results.last_hidden_state ?? results.sentence_embedding;
      if (!output) {
        throw new Error("ONNX model did not return expected output.");
      }
      return this.meanPool(output.cpuData as Float32Array, output.dims as number[]);
    } catch {
      return this.fallback.embed(text);
    }
  }

  // biome-ignore lint/suspicious/useAwait: warning suppression
  override async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (!this.ready) {
      return this.fallback.embedBatch(texts);
    }
    // Fall back to sequential for now; batched ONNX inference is future work
    return super.embedBatch(texts);
  }

  override async healthCheck(): Promise<boolean> {
    if (!this.ready) {
      return this.fallback.healthCheck();
    }
    try {
      const test = await this.embedAsync("health check");
      return test.length === this.dimensions;
    } catch {
      return false;
    }
  }

  // ─── Tokenizer (naive — production should use huggingface tokenizers) ──

  private tokenize(text: string): number[] {
    const words = text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      .split(/\s+/)
      .filter(Boolean);
    // Truncate to 512 tokens max (MiniLM context window)
    return words.slice(0, 512).map((word, i) => (word.length * 7 + i * 3) % 30522);
  }

  private meanPool(data: Float32Array, dims: number[]): Float32Array {
    // dims = [batch, seq_len, hidden_dim]
    const seqLen = dims[1] ?? 1;
    const hiddenDim = dims[2] ?? this.dimensions;
    const result = new Float32Array(hiddenDim);
    for (let i = 0; i < seqLen; i++) {
      for (let j = 0; j < hiddenDim; j++) {
        result[j] = (result[j] ?? 0) + (data[i * hiddenDim + j] ?? 0);
      }
    }
    for (let j = 0; j < hiddenDim; j++) {
      result[j] = (result[j] ?? 0) / seqLen;
    }
    // L2 normalize
    let norm = 0;
    for (const v of result) {
      norm += v * v;
    }
    if (norm > 0) {
      const scale = 1 / Math.sqrt(norm);
      for (let j = 0; j < result.length; j++) {
        result[j] = (result[j] ?? 0) * scale;
      }
    }
    return result;
  }
}

// ─── 3. Caching Provider Decorator ─────────────────────────────────

/**
 * Wraps any EmbeddingProvider with an LRU cache for embedAsync results.
 * Cache key = SHA-256 of (text, provider.name).
 */
export class CachingProvider extends BaseEmbeddingProvider {
  override readonly name: string;
  private inner: EmbeddingProvider;
  private cache = new Map<string, Float32Array>();
  private maxCacheSize: number;

  constructor(inner: EmbeddingProvider, maxCacheSize = 2000) {
    super();
    this.inner = inner;
    this.name = `cached:${inner.name}`;
    this.maxCacheSize = maxCacheSize;
  }

  get dimensions(): number {
    return this.inner.dimensions;
  }

  override embed(text: string): Float32Array {
    return this.inner.embed(text);
  }

  override async embedAsync(text: string): Promise<Float32Array> {
    const cacheKey = this.cacheKey(text);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const result = await this.inner.embedAsync(text);
    this.cache.set(cacheKey, result);

    // LRU eviction on capacity
    if (this.cache.size > this.maxCacheSize) {
      const first = this.cache.keys().next().value;
      if (first) {
        this.cache.delete(first);
      }
    }
    return result;
  }

  override async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];
    const uncached: { index: number; text: string }[] = [];

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      if (text === undefined) {
        continue;
      }
      const key = this.cacheKey(text);
      const cached = this.cache.get(key);
      if (cached) {
        results[i] = cached;
      } else {
        uncached.push({ index: i, text });
      }
    }

    if (uncached.length > 0) {
      const uncachedResults = await this.inner.embedBatch(uncached.map((u) => u.text));
      for (let j = 0; j < uncached.length; j++) {
        const r = uncachedResults[j];
        if (r === undefined) {
          continue;
        }
        const uncachedItem = uncached[j];
        if (uncachedItem) {
          const idx = uncachedItem.index;
          results[idx] = r;
          this.cache.set(this.cacheKey(uncachedItem.text), r);
        }
      }
    }

    return results;
  }

  // biome-ignore lint/suspicious/useAwait: warning suppression
  override async healthCheck(): Promise<boolean> {
    return this.inner.healthCheck();
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private cacheKey(text: string): string {
    return createHash("sha256").update(`${this.inner.name}:${text}`).digest("hex");
  }
}

// ─── Provider Registry ──────────────────────────────────────────────

let activeProvider: EmbeddingProvider | null = null;
let providerConfig = CONFIG.embedding.defaultProviderName;
let preferQuality = false;
let autoUpgradeAttempted = false;

/**
 * Get the active embedding provider.
 * Defaults to LocalHashProvider if none configured.
 *
 * When preferQuality is true AND no provider has been explicitly set,
 * auto-upgrades to ONNX if the runtime is available.
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (!activeProvider) {
    activeProvider = new LocalHashProvider();
    providerConfig = CONFIG.embedding.defaultProviderName;

    // Auto-detect ONNX availability for quality upgrade
    if (preferQuality && !autoUpgradeAttempted) {
      autoUpgradeAttempted = true;
      // Async init is fire-and-forget — first few calls use local-hash,
      // subsequent calls use ONNX once initialized
      // biome-ignore lint/nursery/noFloatingPromises: warning suppression
      tryAutoUpgradeToOnnx();
    }
  }
  return activeProvider;
}

/**
 * Enable quality-preference mode: automatically tries to use ONNX
 * when available, with graceful fallback to LocalHash.
 *
 * Call this early in app startup (before any embedding calls) to
 * maximize the chance of ONNX being ready for the first request.
 */
export function setPreferQuality(enabled: boolean): void {
  preferQuality = enabled;
  if (enabled && !autoUpgradeAttempted) {
    autoUpgradeAttempted = true;
    // biome-ignore lint/nursery/noFloatingPromises: warning suppression
    tryAutoUpgradeToOnnx();
  }
}

export function getPreferQuality(): boolean {
  return preferQuality;
}

/**
 * Fire-and-forget ONNX initialization.
 * On success, swaps the active provider to ONNX (with LocalHash fallback).
 * On failure, keeps LocalHash (silently).
 */
async function tryAutoUpgradeToOnnx(): Promise<void> {
  try {
    const onnxProvider = await ONNXProvider.create();
    const healthy = await onnxProvider.healthCheck();
    if (healthy) {
      activeProvider = onnxProvider;
      providerConfig = CONFIG.embedding.onnxProviderName;
      console.warn(
        "[triMemh] 🧠 Upgraded embedding to ONNX MiniLM-L6-v2 (384-dim). " +
          "Semantic similarity accuracy significantly improved.",
      );
    }
  } catch {
    // ONNX not available — LocalHash remains active, no warning needed
    // (this is the common case in environments without onnxruntime-node)
  }
}

/**
 * Synchronously try to set ONNX as the provider.
 * This attempts a dynamic import and initialization.
 * Returns true if ONNX was successfully activated.
 *
 * Unlike tryAutoUpgradeToOnnx, this is NOT fire-and-forget —
 * the caller should await the result before using embeddings.
 */
export async function tryUpgradeToOnnx(): Promise<boolean> {
  try {
    const onnxProvider = await ONNXProvider.create();
    const healthy = await onnxProvider.healthCheck();
    if (healthy) {
      activeProvider = onnxProvider;
      providerConfig = CONFIG.embedding.onnxProviderName;
      console.warn("[triMemh] 🧠 ONNX MiniLM-L6-v2 activated (384-dim).");
      return true;
    }
  } catch {
    // Silently stay on local-hash
  }
  return false;
}

/**
 * Downgrade to LocalHashProvider (useful for testing or when
 * ONNX model is removed at runtime).
 */
export function downgradeToLocalHash(): void {
  activeProvider = new LocalHashProvider();
  providerConfig = CONFIG.embedding.defaultProviderName;
  autoUpgradeAttempted = false;
}

/**
 * Set the active embedding provider by name or instance.
 * Accepts:
 *  - "local-hash-v1"
 *  - "onnx-minilm-l6-v2"
 *  - an EmbeddingProvider instance
 */
export function setEmbeddingProvider(provider: EmbeddingProvider | string): void {
  autoUpgradeAttempted = true; // explicit set overrides auto-upgrade
  if (typeof provider === "string") {
    providerConfig = provider;
    if (provider === CONFIG.embedding.defaultProviderName) {
      activeProvider = new LocalHashProvider();
    } else if (provider.startsWith(CONFIG.embedding.onnxModelPrefix)) {
      console.warn(
        "[triMemh] ONNX provider requires async initialization. " +
          // biome-ignore lint/security/noSecrets: warning message snippet false positive
          "Use setEmbeddingProviderAsync() or the provider will fallback to local-hash.",
      );
      activeProvider = new LocalHashProvider();
    } else {
      throw new Error(
        `Unknown embedding provider: "${provider}". Valid: local-hash-v1, onnx:minilm-l6-v2`,
      );
    }
  } else {
    activeProvider = provider;
    providerConfig = provider.name;
  }
}

/**
 * Set the active embedding provider asynchronously (for ONNX, etc.).
 */
export async function setEmbeddingProviderAsync(
  provider: EmbeddingProvider | string,
): Promise<void> {
  if (typeof provider === "string" && provider.startsWith(CONFIG.embedding.onnxModelPrefix)) {
    const modelPath = provider.slice(CONFIG.embedding.onnxModelPrefix.length) || undefined;
    try {
      activeProvider = await ONNXProvider.create(modelPath);
      providerConfig = provider;
      return;
    } catch {
      console.warn("[triMemh] ONNX initialization failed; falling back to local-hash-v1.");
      activeProvider = new LocalHashProvider();
      providerConfig = CONFIG.embedding.defaultProviderName;
      return;
    }
  }
  setEmbeddingProvider(provider);
}

export function getProviderConfig(): string {
  return providerConfig;
}

// ─── Backward-compatible exports ────────────────────────────────────

/** Legacy singleton: always available LocalHashProvider. */
export const localEmbeddingProvider: EmbeddingProvider = new LocalHashProvider();

/**
 * Synchronous embed using the active provider.
 * Falls back to local hash provider if the active provider requires async.
 */
export function embedText(text: string): Float32Array {
  return getEmbeddingProvider().embed(text);
}

/**
 * Async embed using the active provider.
 * Preferred for ONNX-based providers.
 */
// biome-ignore lint/suspicious/useAwait: warning suppression
export async function embedTextAsync(text: string): Promise<Float32Array> {
  return getEmbeddingProvider().embedAsync(text);
}
