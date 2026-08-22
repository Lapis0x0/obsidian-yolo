import { quantizeRowInt8 } from './quantization'
import { INT8_SCAN_SLACK, l2Normalize, topKSearch } from './topK'

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
})
