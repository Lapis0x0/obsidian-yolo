import { l2Normalize, topKSearch } from './topK'

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

function buildMatrix(rows: number[][]): {
  matrix: Float32Array
  dimension: number
} {
  const dimension = rows[0]?.length ?? 0
  const matrix = new Float32Array(rows.length * dimension)
  rows.forEach((row, i) => matrix.set(row, i * dimension))
  return { matrix, dimension }
}

describe('topKSearch', () => {
  it('ranks rows by descending dot product and truncates to limit', async () => {
    const { matrix, dimension } = buildMatrix([
      [1, 0], // identical to query -> score 1
      [0, 1], // orthogonal -> score 0
      [-1, 0], // opposite -> score -1
    ])
    const results = await topKSearch({
      matrix,
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

  it('excludes rows at or below minSimilarity (strict greater-than)', async () => {
    const { matrix, dimension } = buildMatrix([
      [1, 0],
      [0, 1],
    ])
    const results = await topKSearch({
      matrix,
      dimension,
      size: 2,
      isTombstoned: () => false,
      queryVector: new Float32Array([1, 0]),
      limit: 10,
      minSimilarity: 0, // row 1 scores exactly 0 -> excluded
    })
    expect(results.map((r) => r.rowIndex)).toEqual([0])
  })

  it('skips tombstoned rows', async () => {
    const { matrix, dimension } = buildMatrix([
      [1, 0],
      [1, 0],
    ])
    const results = await topKSearch({
      matrix,
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
    const { matrix, dimension } = buildMatrix([
      [1, 0],
      [1, 0],
      [1, 0],
    ])
    const results = await topKSearch({
      matrix,
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
    const { matrix, dimension } = buildMatrix(rows)
    const results = await topKSearch({
      matrix,
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
