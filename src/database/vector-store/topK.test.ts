// Wraps the real `yieldToMain` in a jest.fn so individual tests can hook a
// specific yield call (see the "deferred compaction" describe block below) —
// used instead of a tiny `yieldEvery` timing race, per section A of
// `09-c3-codex-fixes.md`.
jest.mock('../../utils/common/yield-to-main', () => {
  const actual = jest.requireActual('../../utils/common/yield-to-main')
  return { ...actual, yieldToMain: jest.fn(actual.yieldToMain) }
})

import { yieldToMain } from '../../utils/common/yield-to-main'

import { quantizeRowInt8 } from './quantization'
import { INT8_SCAN_SLACK, l2Normalize, topKSearch } from './topK'
import { VectorIndex } from './vectorIndex'

const meta = { startLine: 1, endLine: 1 }

beforeEach(() => {
  // Reset call history only (not the wired-up real implementation) so each
  // test's `yieldToMain` assertions/hooks start from a clean slate.
  ;(yieldToMain as jest.Mock).mockClear()
})

describe('l2Normalize', () => {
  it('scales a vector to unit length', () => {
    const out = l2Normalize([3, 4])
    expect(out[0]).toBeCloseTo(0.6)
    expect(out[1]).toBeCloseTo(0.8)
    const norm = Math.sqrt(out[0] * out[0] + out[1] * out[1])
    expect(norm).toBeCloseTo(1)
  })

  it('returns the zero vector unchanged instead of dividing by zero', () => {
    const out = l2Normalize([0, 0, 0])
    expect([...out]).toEqual([0, 0, 0])
  })

  it('accepts a Float32Array input', () => {
    const out = l2Normalize(new Float32Array([1, 0]))
    expect(out[0]).toBeCloseTo(1)
    expect(out[1]).toBeCloseTo(0)
  })
})

/** Builds an int8 matrix (+ per-row scales) from float rows, via the same
 * quantization path `VectorIndex.append` uses. */
function buildMatrix(rows: number[][]): {
  matrix: Int8Array
  scales: Float32Array
  dimension: number
} {
  const dimension = rows[0]?.length ?? 0
  const matrix = new Int8Array(rows.length * dimension)
  const scales = new Float32Array(rows.length)
  rows.forEach((row, i) => {
    scales[i] = quantizeRowInt8(new Float32Array(row), matrix, i * dimension)
  })
  return { matrix, scales, dimension }
}

describe('topKSearch', () => {
  it('ranks rows by descending approximate score and truncates to limit', async () => {
    const { matrix, scales, dimension } = buildMatrix([
      [1, 0], // identical to query -> score 1
      [0, 1], // orthogonal -> score 0
      [-1, 0], // opposite -> score -1
    ])
    const results = await topKSearch({
      matrix,
      scales,
      dimension,
      size: 3,
      isTombstoned: () => false,
      queryVector: new Float32Array([1, 0]),
      limit: 2,
      minSimilarity: -2,
    })
    expect(results.map((r) => r.rowIndex)).toEqual([0, 1])
    expect(results[0].score).toBeCloseTo(1)
    expect(results[1].score).toBeCloseTo(0)
  })

  it('excludes rows scoring well below minSimilarity', async () => {
    const { matrix, scales, dimension } = buildMatrix([
      [1, 0], // score 1
      [0, 1], // score 0
    ])
    const results = await topKSearch({
      matrix,
      scales,
      dimension,
      size: 2,
      isTombstoned: () => false,
      queryVector: new Float32Array([1, 0]),
      limit: 10,
      // Row 1 scores 0, well below (minSimilarity - INT8_SCAN_SLACK) here.
      minSimilarity: 0.5,
    })
    expect(results.map((r) => r.rowIndex)).toEqual([0])
  })

  it('includes a row within INT8_SCAN_SLACK of minSimilarity as a scan candidate', async () => {
    // A row scoring exactly at minSimilarity would, pre-int8, sit right on
    // the strict `>` boundary. The int8 scan loosens its own filter by
    // INT8_SCAN_SLACK so approximation error can't drop a genuine
    // candidate before the caller's exact rescore gets to judge it.
    const { matrix, scales, dimension } = buildMatrix([[1, 0]])
    const results = await topKSearch({
      matrix,
      scales,
      dimension,
      size: 1,
      isTombstoned: () => false,
      queryVector: new Float32Array([1, 0]),
      limit: 10,
      minSimilarity: 1 + INT8_SCAN_SLACK / 2,
    })
    expect(results.map((r) => r.rowIndex)).toEqual([0])
  })

  it('still excludes a row just outside the INT8_SCAN_SLACK window', async () => {
    const { matrix, scales, dimension } = buildMatrix([[1, 0]])
    const results = await topKSearch({
      matrix,
      scales,
      dimension,
      size: 1,
      isTombstoned: () => false,
      queryVector: new Float32Array([1, 0]),
      limit: 10,
      minSimilarity: 1 + INT8_SCAN_SLACK * 2,
    })
    expect(results).toEqual([])
  })

  it('skips tombstoned rows', async () => {
    const { matrix, scales, dimension } = buildMatrix([
      [1, 0],
      [1, 0],
    ])
    const results = await topKSearch({
      matrix,
      scales,
      dimension,
      size: 2,
      isTombstoned: (rowIndex) => rowIndex === 0,
      queryVector: new Float32Array([1, 0]),
      limit: 10,
      minSimilarity: -1,
    })
    expect(results.map((r) => r.rowIndex)).toEqual([1])
  })

  it('applies an extra filter predicate (e.g. scope) before scoring', async () => {
    const { matrix, scales, dimension } = buildMatrix([
      [1, 0],
      [1, 0],
      [1, 0],
    ])
    const results = await topKSearch({
      matrix,
      scales,
      dimension,
      size: 3,
      isTombstoned: () => false,
      filter: (rowIndex) => rowIndex === 2,
      queryVector: new Float32Array([1, 0]),
      limit: 10,
      minSimilarity: -1,
    })
    expect(results.map((r) => r.rowIndex)).toEqual([2])
  })

  it('yields to the main thread periodically without dropping any rows', async () => {
    const rowCount = 23
    const rows = Array.from({ length: rowCount }, () => [1, 0])
    const { matrix, scales, dimension } = buildMatrix(rows)
    const results = await topKSearch({
      matrix,
      scales,
      dimension,
      size: rowCount,
      isTombstoned: () => false,
      queryVector: new Float32Array([1, 0]),
      limit: rowCount,
      minSimilarity: -1,
      yieldEvery: 5,
    })
    expect(results).toHaveLength(rowCount)
  })

  it('produces the same top set via the bounded heap (limit >= 0) as the unlimited collect-and-sort path', async () => {
    const rowCount = 40
    // Distinct, non-tied scores: row i's vector is [1, i/1000] against query
    // [1, 0] — dot product decreases monotonically as i increases, and no
    // int8 quantization collision occurs at this scale.
    const rows = Array.from({ length: rowCount }, (_, i) => [1, i / 1000])
    const { matrix, scales, dimension } = buildMatrix(rows)
    const params = {
      matrix,
      scales,
      dimension,
      size: rowCount,
      isTombstoned: () => false,
      queryVector: new Float32Array([1, 0]),
      minSimilarity: -2,
    }

    const bounded = await topKSearch({ ...params, limit: 5 })
    const unbounded = await topKSearch({ ...params, limit: -1 })

    expect(bounded.map((r) => r.rowIndex)).toEqual(
      unbounded.slice(0, 5).map((r) => r.rowIndex),
    )
  })

  it('returns nothing for limit 0 without scanning into the heap', async () => {
    const { matrix, scales, dimension } = buildMatrix([
      [1, 0],
      [1, 0],
    ])
    const results = await topKSearch({
      matrix,
      scales,
      dimension,
      size: 2,
      isTombstoned: () => false,
      queryVector: new Float32Array([1, 0]),
      limit: 0,
      minSimilarity: -1,
    })
    expect(results).toEqual([])
  })

  it('defaults yieldEvery from the component budget, scaling down as dimension grows', async () => {
    const dimension = 1536
    const rows = [Array.from({ length: dimension }, () => 1)]
    const { matrix, scales } = buildMatrix(rows)
    await topKSearch({
      matrix,
      scales,
      dimension,
      size: 1,
      isTombstoned: () => false,
      queryVector: new Float32Array(dimension).fill(1),
      limit: 1,
      minSimilarity: -2,
      // No explicit yieldEvery: with only 1 row, well under any dimension's
      // default, yieldToMain must never be called.
    })
    expect(yieldToMain).not.toHaveBeenCalled()
  })
})

describe('topKSearch + VectorIndex: compaction stays deferred across a scan (Codex 1.1 / 2.6)', () => {
  it('keeps id correspondence correct and defers compaction across a delete that lands mid-scan yield', async () => {
    const index = new VectorIndex(1)
    const total = 20
    for (let i = 0; i < total; i++) {
      index.append({
        id: i,
        path: `f${i}.md`,
        metadata: meta,
        vector: new Float32Array([i + 1]),
      })
    }

    // Fires exactly once, at the scan's first yield boundary (yieldEvery: 2
    // below → after rows 0 and 1 are already scored). Simulates a concurrent
    // `deleteVectorsByIds`/`deleteVectorsByPaths` batch landing mid-scan:
    // tombstone past the 25% ratio, then call `maybeCompact()` exactly as
    // those methods do — which must be a no-op here because the scan below
    // is still active.
    ;(yieldToMain as jest.Mock).mockImplementationOnce(async () => {
      for (let i = 0; i < 6; i++) index.tombstoneById(i) // 6/20 = 30%
      index.maybeCompact()
      expect(index.tombstoneCount).toBe(6) // deferred: scan is still active
    })

    // Capture the ids array reference *before* the scan: `compact()` (once
    // it finally runs, at `endScan()` below) reassigns `index.ids` to a new
    // array rather than mutating this one in place, so this reference stays
    // exactly the pre-compaction row layout the scan actually saw.
    const idsDuringScan = index.ids

    index.beginScan()
    let results
    try {
      results = await topKSearch({
        matrix: index.matrix,
        scales: index.scales,
        dimension: index.dimension,
        size: index.size,
        isTombstoned: (rowIndex) => index.isTombstoned(rowIndex),
        queryVector: new Float32Array([1]),
        limit: -1,
        minSimilarity: -2,
        yieldEvery: 2,
      })
    } finally {
      index.endScan()
    }

    // Rows 0 and 1 were already scored before the mid-scan delete landed (no
    // corruption there); rows 2-5 were skipped (tombstoned by the time the
    // scan reached them); rows 6-19 scored normally. Every id below is read
    // through `idsDuringScan`, proving row-index-to-id correspondence held
    // throughout — the exact thing a mid-scan compact's remap would break.
    const returnedIds = results
      .map((r) => idsDuringScan[r.rowIndex])
      .sort((a, b) => a - b)
    expect(returnedIds).toEqual([
      0,
      1,
      ...Array.from({ length: total - 6 }, (_, i) => i + 6),
    ])

    // `endScan()` (active count back to 0) ran the deferred compaction.
    expect(index.tombstoneCount).toBe(0)
    expect(index.size).toBe(total - 6)
  })
})
