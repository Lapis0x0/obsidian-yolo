import { yieldToMain } from '../../utils/common/yield-to-main'

/**
 * Yield budget in scanned dot-product *components* (rows × dimension)
 * rather than rows: a fixed row-count yield interval makes each slice's
 * wall-clock cost scale linearly with dimension (a 3072-dim slice does 2x
 * the multiply-adds of a 1536-dim one for the same row count), so higher-
 * dimension models would stall the renderer between yields for
 * proportionally longer. 4,000,000 components is about 2,600 rows at
 * 1536-dim or 1,300 rows at 3072-dim — comparable per-slice duration
 * either way.
 */
const YIELD_COMPONENT_BUDGET = 4_000_000
/** Floor on rows-per-slice regardless of dimension, so a pathological tiny dimension doesn't yield every row. */
const MIN_YIELD_EVERY_ROWS = 64

function defaultYieldEvery(dimension: number): number {
  return Math.max(
    MIN_YIELD_EVERY_ROWS,
    Math.floor(YIELD_COMPONENT_BUDGET / Math.max(dimension, 1)),
  )
}

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
 *
 * The theoretical worst case (`‖query‖₁ · scale / 254`, both vectors
 * unit-length) can exceed this fixed value at high dimension, but is not
 * reached in practice: per-component quantization errors are roughly
 * independent and mostly cancel in the dot-product sum rather than adding
 * in the same direction every time. Empirically the resulting score error
 * has a standard deviation on the order of 1e-3, so 0.02 is a conservative
 * margin of several dozen standard deviations, not a tight worst-case bound.
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
 * Bounded min-heap of the top `capacity` rows by score, so a scan with a
 * limited `limit` never allocates or sorts more candidates than it can
 * possibly return. `capacity <= 0` accepts nothing (matches `limit === 0`
 * returning no results).
 */
class BoundedTopKHeap {
  private readonly heap: TopKRow[] = []

  constructor(private readonly capacity: number) {}

  push(row: TopKRow): void {
    if (this.capacity <= 0) return
    if (this.heap.length < this.capacity) {
      this.heap.push(row)
      this.siftUp(this.heap.length - 1)
      return
    }
    if (row.score <= this.heap[0].score) return
    this.heap[0] = row
    this.siftDown(0)
  }

  /** Drains the heap into descending-score order. */
  toSortedDescending(): TopKRow[] {
    return [...this.heap].sort((a, b) => b.score - a.score)
  }

  private siftUp(index: number): void {
    let i = index
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.heap[parent].score <= this.heap[i].score) break
      ;[this.heap[parent], this.heap[i]] = [this.heap[i], this.heap[parent]]
      i = parent
    }
  }

  private siftDown(index: number): void {
    let i = index
    const n = this.heap.length
    for (;;) {
      const left = i * 2 + 1
      const right = i * 2 + 2
      let smallest = i
      if (left < n && this.heap[left].score < this.heap[smallest].score) {
        smallest = left
      }
      if (right < n && this.heap[right].score < this.heap[smallest].score) {
        smallest = right
      }
      if (smallest === i) break
      ;[this.heap[smallest], this.heap[i]] = [this.heap[i], this.heap[smallest]]
      i = smallest
    }
  }
}

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
 *
 * For a bounded `limit`, matching rows are kept in a `BoundedTopKHeap`
 * (capacity = `limit`) instead of an unbounded array, so a permissive
 * threshold over a large index never allocates/sorts more candidates than
 * `limit` can use. `limit < 0` (unlimited) still collects everything and
 * sorts once at the end, since there is no bound to size a heap to.
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
    yieldEvery = defaultYieldEvery(dimension),
  } = params

  // Scan-time-only threshold, loosened by INT8_SCAN_SLACK; see that
  // constant's doc for why the exact `minSimilarity` isn't applied here.
  const scanThreshold = minSimilarity - INT8_SCAN_SLACK

  const bounded = limit >= 0
  const heap = bounded ? new BoundedTopKHeap(limit) : null
  const unboundedResults: TopKRow[] = []
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
        if (heap) heap.push({ rowIndex, score })
        else unboundedResults.push({ rowIndex, score })
      }
    }

    scannedSinceYield += 1
    if (scannedSinceYield >= yieldEvery) {
      scannedSinceYield = 0
      await yieldToMain()
    }
  }

  if (heap) return heap.toSortedDescending()
  unboundedResults.sort((a, b) => b.score - a.score)
  return unboundedResults
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
