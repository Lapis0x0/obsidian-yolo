import {
  ARROW_DIRECTIONS,
  EDGE_CONTROL_MAX_PX,
  anchorPoint,
  arrowDirection,
  arrowEnds,
  autoEdgeSides,
  buildEdge,
  buildEdgePathD,
  computeEdgeGeometry,
  distanceToEdgeCurve,
  edgeAtPoint,
  findConnectTarget,
  oppositeSide,
  rectAnchoredAt,
  resolveEdgeSides,
} from './edges'
import type { Edge } from './fileFormat'
import type { VirtualCardRect } from './virtualization'

function rect(
  id: string,
  x: number,
  y: number,
  w = 100,
  h = 100,
): VirtualCardRect {
  return { id, x, y, w, h }
}

describe('anchorPoint', () => {
  const card = rect('a', 0, 0, 100, 50)

  it('returns the midpoint of each side', () => {
    expect(anchorPoint(card, 'top')).toEqual({ x: 50, y: 0 })
    expect(anchorPoint(card, 'right')).toEqual({ x: 100, y: 25 })
    expect(anchorPoint(card, 'bottom')).toEqual({ x: 50, y: 50 })
    expect(anchorPoint(card, 'left')).toEqual({ x: 0, y: 25 })
  })
})

describe('autoEdgeSides', () => {
  it('anchors right->left when the target card is mostly to the right', () => {
    const from = rect('a', 0, 0)
    const to = rect('b', 500, 10)
    expect(autoEdgeSides(from, to)).toEqual({
      fromSide: 'right',
      toSide: 'left',
    })
  })

  it('anchors left->right when the target card is mostly to the left', () => {
    const from = rect('a', 500, 0)
    const to = rect('b', 0, 10)
    expect(autoEdgeSides(from, to)).toEqual({
      fromSide: 'left',
      toSide: 'right',
    })
  })

  it('anchors bottom->top when the target card is mostly below', () => {
    const from = rect('a', 0, 0)
    const to = rect('b', 10, 500)
    expect(autoEdgeSides(from, to)).toEqual({
      fromSide: 'bottom',
      toSide: 'top',
    })
  })

  it('anchors top->bottom when the target card is mostly above', () => {
    const from = rect('a', 0, 500)
    const to = rect('b', 10, 0)
    expect(autoEdgeSides(from, to)).toEqual({
      fromSide: 'top',
      toSide: 'bottom',
    })
  })

  it('breaks a tie (equal |dx| and |dy|) in favor of the horizontal axis', () => {
    const from = rect('a', 0, 0)
    const to = rect('b', 300, 300)
    expect(autoEdgeSides(from, to)).toEqual({
      fromSide: 'right',
      toSide: 'left',
    })
  })
})

describe('resolveEdgeSides', () => {
  const from = rect('a', 0, 0)
  const to = rect('b', 500, 10)

  it('falls back to autoEdgeSides when both sides are omitted', () => {
    expect(resolveEdgeSides(from, to)).toEqual({
      fromSide: 'right',
      toSide: 'left',
    })
  })

  it('honors both explicit sides, overriding the auto pick', () => {
    expect(resolveEdgeSides(from, to, 'top', 'bottom')).toEqual({
      fromSide: 'top',
      toSide: 'bottom',
    })
  })

  it('honors an explicit side while auto-filling the omitted one', () => {
    expect(resolveEdgeSides(from, to, 'top')).toEqual({
      fromSide: 'top',
      toSide: 'left',
    })
    expect(resolveEdgeSides(from, to, undefined, 'bottom')).toEqual({
      fromSide: 'right',
      toSide: 'bottom',
    })
  })
})

describe('computeEdgeGeometry', () => {
  it('anchors start/end at the resolved sides midpoints', () => {
    const from = rect('a', 0, 0, 100, 100)
    const to = rect('b', 500, 0, 100, 100)
    const geometry = computeEdgeGeometry(from, to, 'right', 'left')
    expect(geometry.start).toEqual({ x: 100, y: 50 })
    expect(geometry.end).toEqual({ x: 500, y: 50 })
  })

  it('pushes control points out along the anchor sides outward normal', () => {
    const from = rect('a', 0, 0, 100, 100)
    const to = rect('b', 500, 0, 100, 100)
    const geometry = computeEdgeGeometry(from, to, 'right', 'left')
    // fromSide 'right' -> control point pushed further right (+x); toSide
    // 'left' -> control point pushed further left (-x, i.e. back toward the
    // "from" card), producing the characteristic S-curve.
    expect(geometry.c1.x).toBeGreaterThan(geometry.start.x)
    expect(geometry.c1.y).toBeCloseTo(geometry.start.y, 10)
    expect(geometry.c2.x).toBeLessThan(geometry.end.x)
    expect(geometry.c2.y).toBeCloseTo(geometry.end.y, 10)
  })

  it('caps the extrapolation distance for very far apart cards', () => {
    const from = rect('a', 0, 0, 100, 100)
    const to = rect('b', 100000, 0, 100, 100)
    const geometry = computeEdgeGeometry(from, to, 'right', 'left')
    expect(geometry.c1.x - geometry.start.x).toBe(EDGE_CONTROL_MAX_PX)
    expect(geometry.end.x - geometry.c2.x).toBe(EDGE_CONTROL_MAX_PX)
  })

  it('places the label at the curve midpoint (t=0.5), not the straight-line midpoint', () => {
    const from = rect('a', 0, 0, 100, 100)
    const to = rect('b', 500, 0, 100, 100)
    const geometry = computeEdgeGeometry(from, to, 'right', 'left')
    const straightMidpointY = (geometry.start.y + geometry.end.y) / 2
    // The curve's control points share the same y as start/end in this
    // horizontal case, so the midpoint y coincides with the straight-line
    // midpoint y (sanity check on the symmetric setup) while x is still
    // exactly between the two anchors given the symmetric control points.
    expect(geometry.label.y).toBeCloseTo(straightMidpointY, 10)
    expect(geometry.label.x).toBeCloseTo(
      (geometry.start.x + geometry.end.x) / 2,
      10,
    )
  })
})

describe('distanceToEdgeCurve', () => {
  const from = rect('a', 0, 0, 100, 100)
  const to = rect('b', 500, 0, 100, 100)
  // A horizontal S-curve: start (100,50) -> end (500,50), control points on
  // the same y, so the whole curve lies on y = 50.
  const geometry = computeEdgeGeometry(from, to, 'right', 'left')

  it('is zero on the curve', () => {
    expect(distanceToEdgeCurve(geometry, { x: 300, y: 50 })).toBeCloseTo(0, 6)
    expect(distanceToEdgeCurve(geometry, geometry.start)).toBeCloseTo(0, 6)
    expect(distanceToEdgeCurve(geometry, geometry.end)).toBeCloseTo(0, 6)
  })

  it('measures the perpendicular offset from it', () => {
    expect(distanceToEdgeCurve(geometry, { x: 300, y: 70 })).toBeCloseTo(20, 6)
  })

  it('measures to the nearest end for a point past one of them', () => {
    expect(distanceToEdgeCurve(geometry, { x: 90, y: 50 })).toBeCloseTo(10, 6)
  })

  it('follows a curve that bows away from the straight line between its ends', () => {
    // Anchored top-to-top: the curve leaves both cards upward, so its middle
    // sits well above the straight line joining the two anchors.
    const bowed = computeEdgeGeometry(from, to, 'top', 'top')
    const straightMidpoint = {
      x: (bowed.start.x + bowed.end.x) / 2,
      y: (bowed.start.y + bowed.end.y) / 2,
    }
    expect(distanceToEdgeCurve(bowed, straightMidpoint)).toBeGreaterThan(50)
    expect(
      distanceToEdgeCurve(bowed, { ...straightMidpoint, y: bowed.label.y }),
    ).toBeCloseTo(0, 6)
  })
})

describe('edgeAtPoint', () => {
  const from = rect('a', 0, 0, 100, 100)
  const to = rect('b', 500, 0, 100, 100)
  const far = rect('c', 0, 2000, 100, 100)
  const nodes = new Map([
    [from.id, from],
    [to.id, to],
    [far.id, far],
  ])
  const edge = (id: string, fromNode: string, toNode: string): Edge => ({
    id,
    fromNode,
    toNode,
    fromSide: 'right',
    toSide: 'left',
    fromEnd: 'none',
    toEnd: 'arrow',
    extra: {},
  })

  it('finds the edge a point sits on', () => {
    expect(
      edgeAtPoint([edge('e1', 'a', 'b')], nodes, { x: 300, y: 52 }, 6),
    ).toBe('e1')
  })

  it('finds nothing past the tolerance', () => {
    expect(
      edgeAtPoint([edge('e1', 'a', 'b')], nodes, { x: 300, y: 70 }, 6),
    ).toBeNull()
  })

  it('takes the nearest edge, not the topmost one', () => {
    const straight = edge('straight', 'a', 'b')
    // Same two cards, anchored top-to-top: its curve bows far above the other.
    const bowed: Edge = {
      ...edge('bowed', 'a', 'b'),
      fromSide: 'top',
      toSide: 'top',
    }
    expect(edgeAtPoint([straight, bowed], nodes, { x: 300, y: 52 }, 6)).toBe(
      'straight',
    )
  })

  it('skips an edge whose endpoints are missing from the board', () => {
    expect(
      edgeAtPoint([edge('e1', 'a', 'gone')], nodes, { x: 300, y: 50 }, 6),
    ).toBeNull()
  })

  it('rejects a point outside the endpoints bounding box before measuring', () => {
    expect(
      edgeAtPoint([edge('e1', 'a', 'b')], nodes, { x: 300, y: 1000 }, 6),
    ).toBeNull()
  })
})

describe('buildEdgePathD', () => {
  it('formats a cubic-bezier SVG path "d" attribute', () => {
    const geometry = {
      start: { x: 0, y: 0 },
      c1: { x: 10, y: 0 },
      c2: { x: 40, y: 50 },
      end: { x: 50, y: 50 },
      label: { x: 25, y: 25 },
    }
    expect(buildEdgePathD(geometry)).toBe('M 0 0 C 10 0, 40 50, 50 50')
  })
})

describe('oppositeSide', () => {
  it('pairs each side with the one facing it', () => {
    expect(oppositeSide('top')).toBe('bottom')
    expect(oppositeSide('bottom')).toBe('top')
    expect(oppositeSide('left')).toBe('right')
    expect(oppositeSide('right')).toBe('left')
  })
})

describe('findConnectTarget', () => {
  const card = rect('a', 0, 0, 100, 100)

  it('finds nothing over open canvas', () => {
    expect(findConnectTarget({ x: 500, y: 500 }, [card], 12)).toBeNull()
  })

  it('anchors to the nearest side of the card the pointer is inside', () => {
    // Just inside the left border, vertically centered.
    expect(findConnectTarget({ x: 5, y: 50 }, [card], 12)).toEqual({
      nodeId: 'a',
      side: 'left',
    })
    expect(findConnectTarget({ x: 50, y: 5 }, [card], 12)).toEqual({
      nodeId: 'a',
      side: 'top',
    })
  })

  it('still anchors from just outside the card, within the snap band', () => {
    expect(findConnectTarget({ x: -10, y: 50 }, [card], 12)).toEqual({
      nodeId: 'a',
      side: 'left',
    })
    expect(findConnectTarget({ x: -13, y: 50 }, [card], 12)).toBeNull()
  })

  it('picks the near side of a wide card rather than the one the pointer drifted past', () => {
    const wide = rect('w', 0, 0, 400, 100)
    // Dropped on the far right half: the right connection point is nearest.
    expect(findConnectTarget({ x: 380, y: 50 }, [wide], 12)).toEqual({
      nodeId: 'w',
      side: 'right',
    })
  })

  it('prefers the card whose connection point is closest when two overlap', () => {
    // Both cards contain the point; 'near' has its left connection point at
    // x=90 against the other's right one at x=100.
    const near = rect('near', 90, 0, 100, 100)
    expect(findConnectTarget({ x: 92, y: 50 }, [card, near], 12)).toEqual({
      nodeId: 'near',
      side: 'left',
    })
  })
})

describe('rectAnchoredAt', () => {
  const size = { w: 100, h: 60 }

  it("places the card so the named side's connection point lands on the drop", () => {
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const placed = rectAnchoredAt({ x: 200, y: 300 }, side, size)
      expect(anchorPoint({ id: 'new', ...placed }, side)).toEqual({
        x: 200,
        y: 300,
      })
    }
  })

  it('keeps the requested size', () => {
    expect(rectAnchoredAt({ x: 0, y: 0 }, 'left', size)).toEqual({
      x: 0,
      y: -30,
      w: 100,
      h: 60,
    })
  })
})

describe('buildEdge', () => {
  const anchor = { nodeId: 'a', side: 'right' as const }
  const target = { nodeId: 'b', side: 'left' as const }

  it("puts anchor at 'from' and target at 'to' when the drag was moving the 'to' end", () => {
    expect(buildEdge('e1', anchor, 'to', target)).toEqual({
      id: 'e1',
      fromNode: 'a',
      toNode: 'b',
      fromSide: 'right',
      toSide: 'left',
      fromEnd: 'none',
      toEnd: 'arrow',
      extra: {},
    })
  })

  it("swaps them when the drag was moving the 'from' end (re-attaching an edge's start)", () => {
    expect(buildEdge('e2', anchor, 'from', target)).toEqual({
      id: 'e2',
      fromNode: 'b',
      toNode: 'a',
      fromSide: 'left',
      toSide: 'right',
      fromEnd: 'none',
      toEnd: 'arrow',
      extra: {},
    })
  })

  it('always defaults to an arrow at the end you pulled towards', () => {
    expect(buildEdge('e3', anchor, 'to', target)).toMatchObject({
      fromEnd: 'none',
      toEnd: 'arrow',
    })
  })
})

describe('arrow direction', () => {
  it('round-trips every direction through the JSON Canvas end pair', () => {
    for (const direction of ARROW_DIRECTIONS) {
      const ends = arrowEnds(direction)
      expect(arrowDirection(ends.fromEnd, ends.toEnd)).toBe(direction)
    }
  })

  it("offers JSON Canvas's default as one of the four", () => {
    // A brand-new edge is fromEnd 'none' / toEnd 'arrow' (fileFormat.ts's
    // parse defaults). If that did not map onto an option, the menu would
    // never tick anything for an untouched edge.
    expect(arrowDirection('none', 'arrow')).toBe('forward')
    expect(arrowEnds('forward')).toEqual({ fromEnd: 'none', toEnd: 'arrow' })
  })

  it('puts the arrow at the source for a reversed edge', () => {
    expect(arrowEnds('backward')).toEqual({ fromEnd: 'arrow', toEnd: 'none' })
  })

  it('strips both arrowheads for a plain line', () => {
    expect(arrowEnds('none')).toEqual({ fromEnd: 'none', toEnd: 'none' })
  })
})
