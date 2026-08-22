import { yieldToMain } from '../../utils/common/yield-to-main'

/** How many rows to scan between yields to the main thread. */
const DEFAULT_YIELD_EVERY = 5000

/**
 * How much to loosen the scan-time `minSimilarity` filter below the
 * caller's real threshold. Int8 dot products are approximate — per-row
 * quantization error bounds the per-component error at `scale/254`
 * (see `quantization.ts`), so a row whose *exact* score would clear
 * `minSimilarity` could still score marginally below it here. Widening
 * the scan filter by this much avoids dropping such a row before the
 * caller gets a chance to rescore it against the original float32
 * vector; it does not relax the final threshold, which callers must
 * still apply as a strict `> minSimilarity` after rescoring.
 */
export const INT8_SCAN_SLACK = 0.02

export type TopKRow = Readonly<{
  rowIndex: number
  score: number
}>

export type TopKSearchParams = Readonly<{
  /** Row-major int8 matrix: row `i`'s components live at `[i*dimension, (i+1)*dimension)`. */
  matrix: Int8Array
  /** Per-row dequantization scale: row `i`'s value ≈ `matrix[i*dimension+j] * scales[i] / 127`. */
  scales: Float32Array
  dimension: number
  /** Number of populated rows (may be less than `matrix.length / dimension`). */
  size: number
  isTombstoned: (rowIndex: number) => boolean
  /** Optional extra predicate (e.g. scope.files/scope.folders). */
  filter?: (rowIndex: number) => boolean
  /** Already L2-normalized query vector (not quantized — asymmetric distance computation). */
  queryVector: Float32Array
  limit: number
  /**
   * Strict lower bound for the *exact* score (matches the PGlite baseline's
   * `gt`). Because this scan only produces an approximate int8 score, it is
   * applied here loosened by {@link INT8_SCAN_SLACK} — see that constant's
   * doc. Callers needing the exact cut must reapply `minSimilarity` as a
   * strict `>` after rescoring against the original vectors.
   */
  minSimilarity: number
  yieldEvery?: number
}>

/**
 * Linear asymmetric dot-product scan over a flat, per-row int8-quantized
 * matrix: each row is `q_ij` with a per-row float32 `scale_i`, the query
 * stays float32, and `score ≈ (Σ_j q_ij * query_j) * scale_i / 127`. The
 * result is an *approximate* cosine similarity (both vectors are unit
 * length before quantization) — good enough to rank and to select a
 * candidate window, but not the exact score returned to callers of
 * `VectorStore.performSimilaritySearch`; see
 * `IndexedDbVectorStore.performSimilaritySearch` for the float32 rescore
 * pass that produces the exact value. Pure and side-effect free beyond
 * yielding to the main thread, so it can be moved into a Worker later
 * without touching call sites.
 */
export async function topKSearch(params: TopKSearchParams): Promise<TopKRow[]> {
  const {
    matrix,
    scales,
    dimension,
    size,
    isTombstoned,
    filter,
    queryVector,
    limit,
    minSimilarity,
    yieldEvery = DEFAULT_YIELD_EVERY,
  } = params

  // Scan-time-only threshold, loosened by INT8_SCAN_SLACK; see that
  // constant's doc for why the exact `minSimilarity` isn't applied here.
  const scanThreshold = minSimilarity - INT8_SCAN_SLACK

  const results: TopKRow[] = []
  let scannedSinceYield = 0

  for (let rowIndex = 0; rowIndex < size; rowIndex++) {
    if (!isTombstoned(rowIndex) && (!filter || filter(rowIndex))) {
      const offset = rowIndex * dimension
      let dot = 0
      for (let d = 0; d < dimension; d++) {
        dot += matrix[offset + d] * queryVector[d]
      }
      const score = (dot * scales[rowIndex]) / 127
      if (score > scanThreshold) {
        results.push({ rowIndex, score })
      }
    }

    scannedSinceYield += 1
    if (scannedSinceYield >= yieldEvery) {
      scannedSinceYield = 0
      await yieldToMain()
    }
  }

  results.sort((a, b) => b.score - a.score)
  return limit >= 0 ? results.slice(0, limit) : results
}

/** L2-normalizes a vector. The zero vector is returned unchanged (norm 0 would divide by zero). */
export function l2Normalize(
  vector: readonly number[] | Float32Array,
): Float32Array {
  const out = new Float32Array(vector.length)
  let sumSquares = 0
  for (let i = 0; i < vector.length; i++) {
    const value = vector[i]
    sumSquares += value * value
  }
  const norm = Math.sqrt(sumSquares)
  if (norm === 0) {
    for (let i = 0; i < vector.length; i++) out[i] = vector[i]
    return out
  }
  for (let i = 0; i < vector.length; i++) {
    out[i] = vector[i] / norm
  }
  return out
}
