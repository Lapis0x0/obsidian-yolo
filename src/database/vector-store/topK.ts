import { yieldToMain } from '../../utils/common/yield-to-main'

/** How many rows to scan between yields to the main thread. */
const DEFAULT_YIELD_EVERY = 5000

export type TopKRow = Readonly<{
  rowIndex: number
  score: number
}>

export type TopKSearchParams = Readonly<{
  /** Row-major matrix: row `i`'s components live at `[i*dimension, (i+1)*dimension)`. */
  matrix: Float32Array
  dimension: number
  /** Number of populated rows (may be less than `matrix.length / dimension`). */
  size: number
  isTombstoned: (rowIndex: number) => boolean
  /** Optional extra predicate (e.g. scope.files/scope.folders). */
  filter?: (rowIndex: number) => boolean
  /** Already L2-normalized query vector. */
  queryVector: Float32Array
  limit: number
  /** Strict lower bound: a row must score `> minSimilarity` to qualify (matches the PGlite baseline's `gt`). */
  minSimilarity: number
  yieldEvery?: number
}>

/**
 * Linear dot-product scan over a flat, L2-normalized matrix (dot product of
 * two unit vectors is their cosine similarity). Pure and side-effect free
 * beyond yielding to the main thread, so it can be moved into a Worker later
 * without touching call sites.
 */
export async function topKSearch(params: TopKSearchParams): Promise<TopKRow[]> {
  const {
    matrix,
    dimension,
    size,
    isTombstoned,
    filter,
    queryVector,
    limit,
    minSimilarity,
    yieldEvery = DEFAULT_YIELD_EVERY,
  } = params

  const results: TopKRow[] = []
  let scannedSinceYield = 0

  for (let rowIndex = 0; rowIndex < size; rowIndex++) {
    if (!isTombstoned(rowIndex) && (!filter || filter(rowIndex))) {
      const offset = rowIndex * dimension
      let dot = 0
      for (let d = 0; d < dimension; d++) {
        dot += matrix[offset + d] * queryVector[d]
      }
      if (dot > minSimilarity) {
        results.push({ rowIndex, score: dot })
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
