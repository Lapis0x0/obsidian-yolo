import { VectorIndex } from './vectorIndex'

const meta = { startLine: 1, endLine: 1 }

/** Dequantizes a single-dimension row back to its approximate float value. */
function dequantizeRow(index: VectorIndex, rowIndex: number): number {
  return (index.matrix[rowIndex] * index.scales[rowIndex]) / 127
}

describe('VectorIndex', () => {
  it('appends rows and tracks them by path', () => {
    const index = new VectorIndex(2)
    index.append({
      id: 1,
      path: 'a.md',
      metadata: meta,
      vector: new Float32Array([1, 0]),
    })
    index.append({
      id: 2,
      path: 'a.md',
      metadata: meta,
      vector: new Float32Array([0, 1]),
    })
    index.append({
      id: 3,
      path: 'b.md',
      metadata: meta,
      vector: new Float32Array([1, 1]),
    })

    expect(index.size).toBe(3)
    expect(index.ids).toEqual([1, 2, 3])
    expect(index.paths).toEqual(['a.md', 'a.md', 'b.md'])
    expect(index.pathToRows.get('a.md')).toEqual([0, 1])
    expect(index.pathToRows.get('b.md')).toEqual([2])
    // [1, 0] quantizes exactly: scale 1, components +-127/0.
    expect([...index.matrix.subarray(0, 2)]).toEqual([127, 0])
    expect(index.scales[0]).toBe(1)
  })

  it('is idempotent when the same id is appended twice', () => {
    const index = new VectorIndex(1)
    index.append({
      id: 1,
      path: 'a.md',
      metadata: meta,
      vector: new Float32Array([1]),
    })
    index.append({
      id: 1,
      path: 'a.md',
      metadata: meta,
      vector: new Float32Array([1]),
    })
    expect(index.size).toBe(1)
  })

  it('throws when a row vector does not match the index dimension', () => {
    const index = new VectorIndex(2)
    expect(() =>
      index.append({
        id: 1,
        path: 'a.md',
        metadata: meta,
        vector: new Float32Array([1]),
      }),
    ).toThrow(/dimension mismatch/)
  })

  it('grows capacity beyond the initial allocation without losing existing rows', () => {
    const index = new VectorIndex(1)
    for (let i = 0; i < 2000; i++) {
      index.append({
        id: i,
        path: `f${i}.md`,
        metadata: meta,
        vector: new Float32Array([i]),
      })
    }
    expect(index.size).toBe(2000)
    expect(index.matrix[0]).toBe(0)
    expect(index.scales[1999]).toBeCloseTo(1999)
    expect(dequantizeRow(index, 1999)).toBeCloseTo(1999, 0)
  })

  describe('tombstoneById', () => {
    it('removes the row from pathToRows and reports success once', () => {
      // Use enough rows that tombstoning one stays under the 25% compaction
      // threshold, so the row is genuinely tombstoned rather than compacted
      // away outright (compaction is covered separately below).
      const index = new VectorIndex(1)
      for (let i = 0; i < 10; i++) {
        index.append({
          id: i,
          path: `f${i}.md`,
          metadata: meta,
          vector: new Float32Array([i]),
        })
      }
      expect(index.tombstoneById(0)).toBe(true)
      expect(index.pathToRows.has('f0.md')).toBe(false)
      expect(index.isTombstoned(0)).toBe(true)
      expect(index.tombstoneById(0)).toBe(false)
    })

    it('returns false for an id that was never indexed', () => {
      const index = new VectorIndex(1)
      expect(index.tombstoneById(999)).toBe(false)
    })
  })

  describe('tombstoneByPath', () => {
    it('removes every row for a path and returns their ids', () => {
      const index = new VectorIndex(1)
      index.append({
        id: 1,
        path: 'a.md',
        metadata: meta,
        vector: new Float32Array([1]),
      })
      index.append({
        id: 2,
        path: 'a.md',
        metadata: meta,
        vector: new Float32Array([1]),
      })
      index.append({
        id: 3,
        path: 'b.md',
        metadata: meta,
        vector: new Float32Array([1]),
      })

      const removed = index.tombstoneByPath('a.md')
      expect([...removed].sort()).toEqual([1, 2])
      expect(index.pathToRows.has('a.md')).toBe(false)
      // Tombstoning alone never compacts (see `maybeCompact`); the caller
      // must ask for it explicitly once its whole delete batch is done.
      expect(index.tombstoneCount).toBe(2)
      index.maybeCompact()
      // Removing 2/3 rows crosses the compaction threshold, so b.md's row
      // may have been remapped to a new index — check by id, not position.
      const bRows = index.pathToRows.get('b.md')
      expect(bRows).toHaveLength(1)
      expect(index.ids[bRows![0]]).toBe(3)
    })

    it('is a no-op for an unknown path', () => {
      const index = new VectorIndex(1)
      expect(index.tombstoneByPath('missing.md')).toEqual([])
    })
  })

  describe('compaction', () => {
    it('does not compact on tombstone alone; maybeCompact reclaims rows past 25% and preserves live data', () => {
      const index = new VectorIndex(1)
      const total = 20
      for (let i = 0; i < total; i++) {
        index.append({
          id: i,
          path: `f${i}.md`,
          metadata: meta,
          vector: new Float32Array([i]),
        })
      }
      // Tombstone 6/20 = 30% > 25% threshold, but tombstoning alone never
      // compacts anymore (see Codex finding 1.1/2.6 — compaction is deferred
      // to an explicit `maybeCompact()` call so it can never fire mid-scan).
      for (let i = 0; i < 6; i++) {
        index.tombstoneById(i)
      }
      expect(index.tombstoneCount).toBe(6)
      expect(index.size).toBe(total)

      index.maybeCompact()
      expect(index.tombstoneCount).toBe(0) // compacted away
      expect(index.size).toBe(total - 6)

      // Surviving rows keep their id/path/vector (and scale) association.
      for (let i = 6; i < total; i++) {
        const rows = index.pathToRows.get(`f${i}.md`)
        expect(rows).toBeDefined()
        const rowIndex = rows![0]
        expect(index.ids[rowIndex]).toBe(i)
        expect(dequantizeRow(index, rowIndex)).toBeCloseTo(i, 0)
      }

      // Further tombstoning by id still works after compaction re-indexed rows.
      expect(index.tombstoneById(6)).toBe(true)
    })

    it('maybeCompact is a no-op below the tombstone ratio threshold', () => {
      const index = new VectorIndex(1)
      for (let i = 0; i < 20; i++) {
        index.append({
          id: i,
          path: `f${i}.md`,
          metadata: meta,
          vector: new Float32Array([i]),
        })
      }
      // 4/20 = 20% < 25% threshold.
      for (let i = 0; i < 4; i++) {
        index.tombstoneById(i)
      }
      index.maybeCompact()
      expect(index.tombstoneCount).toBe(4)
      expect(index.size).toBe(20)
    })
  })

  describe('beginScan / endScan', () => {
    it('defers compaction while a scan is active, then compacts once it ends', () => {
      const index = new VectorIndex(1)
      const total = 20
      for (let i = 0; i < total; i++) {
        index.append({
          id: i,
          path: `f${i}.md`,
          metadata: meta,
          vector: new Float32Array([i]),
        })
      }

      index.beginScan()
      for (let i = 0; i < 6; i++) {
        index.tombstoneById(i)
      }
      index.maybeCompact()
      // A scan is active: maybeCompact must not touch the matrix, even
      // though the tombstone ratio (30%) is past the threshold — otherwise
      // the scan's captured matrix/scales/ids arrays would be remapped out
      // from under it (Codex finding 1.1).
      expect(index.tombstoneCount).toBe(6)
      expect(index.size).toBe(total)

      index.endScan()
      // The last `endScan()` (active count back to 0) triggers the deferred
      // compaction automatically.
      expect(index.tombstoneCount).toBe(0)
      expect(index.size).toBe(total - 6)
    })

    it('only compacts once every nested scan has ended', () => {
      const index = new VectorIndex(1)
      for (let i = 0; i < 20; i++) {
        index.append({
          id: i,
          path: `f${i}.md`,
          metadata: meta,
          vector: new Float32Array([i]),
        })
      }
      index.beginScan()
      index.beginScan()
      for (let i = 0; i < 6; i++) index.tombstoneById(i)
      index.endScan()
      expect(index.tombstoneCount).toBe(6) // one scan still active
      index.endScan()
      expect(index.tombstoneCount).toBe(0) // now compacted
    })
  })

  describe('reserve', () => {
    it('pre-allocates capacity so subsequent appends never grow the matrix', () => {
      const index = new VectorIndex(2)
      index.reserve(100)
      const matrixBeforeAppends = index.matrix
      for (let i = 0; i < 100; i++) {
        index.append({
          id: i,
          path: `f${i}.md`,
          metadata: meta,
          vector: new Float32Array([i, i]),
        })
      }
      // Same underlying typed array identity: no `growTo` reallocation
      // happened during the appends, because `reserve` already sized it.
      expect(index.matrix).toBe(matrixBeforeAppends)
      expect(index.size).toBe(100)
    })

    it('is a no-op when the requested capacity is already available', () => {
      const index = new VectorIndex(1)
      index.append({
        id: 1,
        path: 'a.md',
        metadata: meta,
        vector: new Float32Array([1]),
      })
      const matrixBefore = index.matrix
      index.reserve(1) // already within the initial capacity
      expect(index.matrix).toBe(matrixBefore)
    })
  })

  describe('capacity growth strategy', () => {
    it('doubles capacity below the doubling ceiling', () => {
      const index = new VectorIndex(1)
      // INITIAL_CAPACITY_ROWS is 1024; appending past it should double to 2048.
      for (let i = 0; i < 1025; i++) {
        index.append({
          id: i,
          path: `f${i}.md`,
          metadata: meta,
          vector: new Float32Array([i]),
        })
      }
      expect(index.matrix.length).toBe(2048)
    })
  })
})
