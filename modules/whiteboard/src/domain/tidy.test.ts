import type { ArrangeRect } from './arrange'
import { tidyRects } from './tidy'

const STEP = 13

function rect(id: string, x: number, y: number, w = 100, h = 60): ArrangeRect {
  return { id, x, y, w, h }
}

/** Ids left to right, top to bottom — the order a reader would give them. */
function readingOrder(
  rects: readonly ArrangeRect[],
  positions: ReadonlyMap<string, { x: number; y: number }>,
): string[] {
  return rects
    .map((r) => ({ id: r.id, ...(positions.get(r.id) ?? r) }))
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((r) => r.id)
}

describe('tidyRects', () => {
  it('leaves a selection of one alone', () => {
    const only = [rect('a', 7, 9)]
    expect(tidyRects(only, STEP).get('a')).toEqual({ x: 7, y: 9 })
  })

  it('is total over its input', () => {
    const rects = [rect('a', 0, 0), rect('b', 400, 5)]
    expect(new Set(tidyRects(rects, STEP).keys())).toEqual(new Set(['a', 'b']))
  })

  it('keeps the bounding box anchored at its top-left corner', () => {
    const rects = [rect('a', 40, 30), rect('b', 400, 33), rect('c', 44, 300)]
    const positions = tidyRects(rects, STEP)
    expect(positions.get('a')).toEqual({ x: 40, y: 30 })
  })

  it('evens out the gaps in a row and tops the cards off level', () => {
    // Gaps of 20, 60 and 20 with a stray card sitting low: the median gap (20)
    // wins, and the low card comes up to the row's top edge.
    const rects = [
      rect('a', 0, 0),
      rect('b', 120, 12),
      rect('c', 280, 0),
      rect('d', 400, 4),
    ]
    // 20 rounds onto the 13px lattice as 26.
    const positions = tidyRects(rects, STEP)
    expect(positions.get('a')).toEqual({ x: 0, y: 0 })
    expect(positions.get('b')).toEqual({ x: 126, y: 0 })
    expect(positions.get('c')).toEqual({ x: 252, y: 0 })
    expect(positions.get('d')).toEqual({ x: 378, y: 0 })
  })

  it('evens out a column and lines its left edges up', () => {
    const rects = [rect('a', 0, 0), rect('b', 14, 100), rect('c', 3, 190)]
    const positions = tidyRects(rects, STEP)
    // Row gaps of 40 and 30 — median 35, which lands on 39.
    expect(positions.get('a')).toEqual({ x: 0, y: 0 })
    expect(positions.get('b')).toEqual({ x: 0, y: 99 })
    expect(positions.get('c')).toEqual({ x: 0, y: 198 })
  })

  it('keeps a grid a grid, one gap value throughout', () => {
    const rects = [
      rect('a', 0, 0),
      rect('b', 130, 4),
      rect('c', 6, 90),
      rect('d', 128, 96),
    ]
    const positions = tidyRects(rects, STEP)
    expect(positions.get('a')).toEqual({ x: 0, y: 0 })
    expect(positions.get('b')?.x).toBe(positions.get('d')?.x)
    expect(positions.get('a')?.y).toBe(positions.get('b')?.y)
    expect(positions.get('c')?.y).toBe(positions.get('d')?.y)
    expect(positions.get('c')?.x).toBe(0)
  })

  it('never reorders — the reading order survives', () => {
    const rects = [
      rect('a', 0, 0),
      rect('b', 300, 20),
      rect('c', 40, 200),
      rect('d', 260, 210),
      rect('e', 600, 400),
    ]
    const before = readingOrder(rects, new Map())
    const after = readingOrder(rects, tidyRects(rects, STEP))
    expect(after).toEqual(before)
  })

  it('never resizes: it only ever returns positions', () => {
    const rects = [rect('a', 0, 0, 100, 60), rect('b', 300, 0, 40, 200)]
    const positions = tidyRects(rects, STEP)
    for (const r of rects) {
      const point = positions.get(r.id)
      expect(Object.keys(point ?? {}).sort()).toEqual(['x', 'y'])
    }
  })

  it('does not chain rows: a diagonal drift breaks into rows', () => {
    // `b` overlaps the row head `a` and joins it; `c` overlaps `b` but not the
    // head, so it starts a new row. Chaining on "overlaps anything already in
    // the row" would swallow `c` too, and a long diagonal drift would collapse
    // into a single row — the layout re-decided, not tidied.
    const rects = [
      rect('a', 0, 0, 100, 60),
      rect('b', 200, 40, 100, 60),
      rect('c', 400, 80, 100, 60),
    ]
    const positions = tidyRects(rects, STEP)
    expect(positions.get('b')?.y).toBe(positions.get('a')?.y)
    expect(positions.get('c')?.y).not.toBe(positions.get('a')?.y)
  })

  it('groups a row by overlap with the row head, not by exact tops', () => {
    const rects = [
      rect('a', 0, 0, 100, 60),
      rect('b', 200, 30, 100, 60),
      rect('c', 400, 500, 100, 60),
    ]
    const positions = tidyRects(rects, STEP)
    expect(positions.get('a')?.y).toBe(positions.get('b')?.y)
    expect(positions.get('c')?.y).not.toBe(positions.get('a')?.y)
  })

  it('spreads a pile of stacked cards out to one cell apart', () => {
    const rects = [rect('a', 0, 0), rect('b', 4, 6), rect('c', 9, 3)]
    const positions = tidyRects(rects, STEP)
    expect(positions.get('a')).toEqual({ x: 0, y: 0 })
    expect(positions.get('b')).toEqual({ x: 113, y: 0 })
    expect(positions.get('c')).toEqual({ x: 226, y: 0 })
  })

  it('snaps every gap onto the grid', () => {
    const rects = [rect('a', 0, 0), rect('b', 137, 0), rect('c', 281, 0)]
    const positions = tidyRects(rects, STEP)
    const first = (positions.get('b')?.x ?? 0) - 100
    const second =
      (positions.get('c')?.x ?? 0) - (positions.get('b')?.x ?? 0) - 100
    expect(first % STEP).toBe(0)
    expect(second % STEP).toBe(0)
    expect(first).toBe(second)
  })

  it('leaves an already tidy selection exactly where it is', () => {
    const rects = [
      rect('a', 0, 0),
      rect('b', 126, 0),
      rect('c', 0, 86),
      rect('d', 126, 86),
    ]
    const positions = tidyRects(rects, STEP)
    for (const r of rects) {
      expect(positions.get(r.id)).toEqual({ x: r.x, y: r.y })
    }
  })

  it('lets a taller card set its own row height', () => {
    const rects = [
      rect('a', 0, 0, 100, 200),
      rect('b', 126, 0, 100, 60),
      rect('c', 0, 300, 100, 60),
    ]
    const positions = tidyRects(rects, STEP)
    expect(positions.get('c')?.y).toBe(200 + 104)
  })
})
