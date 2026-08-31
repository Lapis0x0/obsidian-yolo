import { type ArrangeRect, alignRects, distributeRects } from './arrange'

/** Three differently sized rects in a rough row — the case both operations
 * exist for, and the one where equal *gaps* and equal *pitch* differ. */
const ROW: readonly ArrangeRect[] = [
  { id: 'a', x: 0, y: 0, w: 100, h: 50 },
  { id: 'b', x: 150, y: 20, w: 40, h: 80 },
  { id: 'c', x: 400, y: 10, w: 60, h: 30 },
]

function pointOf(
  positions: ReadonlyMap<string, { x: number; y: number }>,
  id: string,
): { x: number; y: number } {
  const point = positions.get(id)
  if (!point) throw new Error(`expected a position for "${id}"`)
  return point
}

describe('alignRects', () => {
  it('pulls every node to the selection bounding box left edge', () => {
    const positions = alignRects(ROW, 'left')
    expect(pointOf(positions, 'a').x).toBe(0)
    expect(pointOf(positions, 'b').x).toBe(0)
    expect(pointOf(positions, 'c').x).toBe(0)
  })

  it('aligns right edges, not left edges, when aligning right', () => {
    const positions = alignRects(ROW, 'right')
    // The bounding box ends at c's right edge, 460.
    expect(pointOf(positions, 'a').x).toBe(360)
    expect(pointOf(positions, 'b').x).toBe(420)
    expect(pointOf(positions, 'c').x).toBe(400)
  })

  it('centres each node on the bounding box centre line', () => {
    const positions = alignRects(ROW, 'center')
    // Bounding box spans 0..460, centre 230.
    expect(pointOf(positions, 'a').x).toBe(180)
    expect(pointOf(positions, 'b').x).toBe(210)
    expect(pointOf(positions, 'c').x).toBe(200)
  })

  it('leaves the other axis untouched', () => {
    const positions = alignRects(ROW, 'left')
    expect(pointOf(positions, 'b').y).toBe(20)
    expect(pointOf(positions, 'c').y).toBe(10)
  })

  it('aligns tops, bottoms and middles on the vertical axis', () => {
    // Bounding box spans y 0..100.
    expect(pointOf(alignRects(ROW, 'top'), 'b').y).toBe(0)
    expect(pointOf(alignRects(ROW, 'bottom'), 'a').y).toBe(50)
    expect(pointOf(alignRects(ROW, 'middle'), 'a').y).toBe(25)
    expect(pointOf(alignRects(ROW, 'top'), 'b').x).toBe(150)
  })

  it('is a no-op for a single node, which is its own bounding box', () => {
    const positions = alignRects([ROW[1]], 'left')
    expect(pointOf(positions, 'b')).toEqual({ x: 150, y: 20 })
  })

  it('returns nothing for an empty selection', () => {
    expect(alignRects([], 'left').size).toBe(0)
  })
})

describe('distributeRects', () => {
  it('keeps the outermost nodes put and equalises the gaps between them', () => {
    const positions = distributeRects(ROW, 'horizontal')
    expect(pointOf(positions, 'a').x).toBe(0)
    expect(pointOf(positions, 'c').x).toBe(400)
    // Span 460, widths 100+40+60 = 200, so each of the two gaps is 130.
    expect(pointOf(positions, 'b').x).toBe(230)
    const gapBefore = pointOf(positions, 'b').x - (0 + 100)
    const gapAfter = 400 - (pointOf(positions, 'b').x + 40)
    expect(gapBefore).toBe(gapAfter)
  })

  it('equalises gaps rather than centre-to-centre pitch', () => {
    const positions = distributeRects(ROW, 'horizontal')
    const centreA = 0 + 100 / 2
    const centreB = pointOf(positions, 'b').x + 40 / 2
    const centreC = 400 + 60 / 2
    // Differently sized nodes make even gaps and even pitch disagree; this is
    // the branch that says which of the two we implement.
    expect(centreB - centreA).not.toBe(centreC - centreB)
  })

  it('leaves the cross axis alone', () => {
    const positions = distributeRects(ROW, 'horizontal')
    expect(pointOf(positions, 'b').y).toBe(20)
  })

  it('distributes vertically off the vertical bounding box', () => {
    const column: readonly ArrangeRect[] = [
      { id: 'a', x: 0, y: 0, w: 10, h: 40 },
      { id: 'b', x: 5, y: 100, w: 10, h: 20 },
      { id: 'c', x: 0, y: 300, w: 10, h: 60 },
    ]
    const positions = distributeRects(column, 'vertical')
    // Span 360, heights 40+20+60 = 120, so each gap is 120.
    expect(pointOf(positions, 'b').y).toBe(160)
    expect(pointOf(positions, 'a').y).toBe(0)
    expect(pointOf(positions, 'c').y).toBe(300)
    expect(pointOf(positions, 'b').x).toBe(5)
  })

  it('orders by current position, so a shuffled input still spreads in place', () => {
    const shuffled = [ROW[2], ROW[0], ROW[1]]
    expect(distributeRects(shuffled, 'horizontal')).toEqual(
      distributeRects(ROW, 'horizontal'),
    )
  })

  it('does nothing with fewer than three nodes', () => {
    const pair = [ROW[0], ROW[2]]
    const positions = distributeRects(pair, 'horizontal')
    expect(pointOf(positions, 'a')).toEqual({ x: 0, y: 0 })
    expect(pointOf(positions, 'c')).toEqual({ x: 400, y: 10 })
  })

  it('is total over its input even when it moves nothing', () => {
    expect(distributeRects([ROW[0]], 'horizontal').size).toBe(1)
    expect(distributeRects([], 'horizontal').size).toBe(0)
  })
})
