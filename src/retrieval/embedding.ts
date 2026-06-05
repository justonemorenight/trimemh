/**
 * Vector Embedding Serialization (SDD-02 §2)
 *
 * Converts Float32Array ↔ SQLite BLOB with alignment-safe handling.
 *
 * SDD-02 §2.1: Binary BLOB storage is 4× more compact than JSON string
 * serialization (6 KB vs 15-20 KB for 1536-dim vectors).
 *
 * SDD-02 §2.3: Bun's SQLite bridge may return Uint8Array at unaligned
 * byte offsets. We MUST check alignment before constructing a zero-copy
 * Float32Array view, or copy to a fresh aligned buffer if needed.
 */

/**
 * Convert a Float32Array vector into a Uint8Array for SQLite BLOB storage.
 * This is a zero-copy operation that views the same underlying ArrayBuffer.
 *
 * SDD-02 §2.2
 */
export function serializeEmbedding(embedding: Float32Array): Uint8Array {
  return new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Safely deserialize a SQLite BLOB (Uint8Array) back into a Float32Array.
 *
 * SDD-02 §2.3 — The Alignment Constraint:
 * JavaScript Float32Array requires 4-byte alignment. Bun's SQLite bridge
 * may return buffers at unaligned offsets. We check alignment first:
 *
 * 1. If the buffer IS aligned (byteOffset % 4 === 0): return zero-copy view
 * 2. If the buffer is NOT aligned: copy bytes to a fresh aligned ArrayBuffer
 *
 * Failing to check will throw: "RangeError: start offset of Float32Array
 * must be a multiple of 4"
 */
export function deserializeEmbedding(blob: Uint8Array): Float32Array {
  const bytesPerElement = Float32Array.BYTES_PER_ELEMENT; // 4

  // Fast path: buffer is already 4-byte aligned → zero-copy view
  if (blob.byteOffset % bytesPerElement === 0) {
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / bytesPerElement);
  }

  // Slow path: copy to an aligned buffer (SDD-02 §2.3 mitigation)
  const alignedBuffer = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return new Float32Array(alignedBuffer);
}

/**
 * Check if two embeddings have the same dimension.
 * Returns null if either is null, or the dimension if they match.
 * Throws on dimension mismatch.
 */
export function validateDimensions(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `Embedding dimension mismatch: ${a.length} vs ${b.length}. ` +
        `Cannot compute similarity across different embedding models.`,
    );
  }
  return a.length;
}

/**
 * Cosine similarity computed in pure JavaScript.
 *
 * SDD-02 §3.2 formula:
 *   cos(A, B) = Σ(Aᵢ × Bᵢ) / (√ΣAᵢ² × √ΣBᵢ²)
 *
 * Edge cases (SDD-02 §3.2):
 * - Zero-vector norm → returns 0.0 (not NaN)
 * - Result clamped to [-1.0, 1.0] to prevent floating-point overshoot
 * - Returns 0.0 if either Float32Array is empty
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = validateDimensions(a, b);
  if (len === 0) {
    return 0.0;
  }

  let dotProduct = 0.0;
  let normASquared = 0.0;
  let normBSquared = 0.0;

  for (let i = 0; i < len; i++) {
    const va = a[i] ?? 0.0;
    const vb = b[i] ?? 0.0;
    dotProduct += va * vb;
    normASquared += va * va;
    normBSquared += vb * vb;
  }

  // Division-by-zero prevention (SDD-02 §3.2)
  if (normASquared === 0.0 || normBSquared === 0.0) {
    return 0.0;
  }

  const similarity = dotProduct / (Math.sqrt(normASquared) * Math.sqrt(normBSquared));

  // Precision clamping to [-1.0, 1.0] (SDD-02 §3.2)
  return Math.max(-1.0, Math.min(1.0, similarity));
}
