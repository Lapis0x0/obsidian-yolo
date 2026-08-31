import type { BoardNode } from './fileFormat'
import {
  GROUP_SELECTION_PADDING,
  groupRectForNodes,
  nodesInsideGroup,
  nodesToDragWith,
  rectContains,
} from './groups'

function group(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
): BoardNode {
  return { id, type: 'group', x, y, w, h, extra: {} }
}

function card(id: string, x: number, y: number, w = 50, h = 50): BoardNode {
  return { id, type: 'text', x, y, w, h, text: '', extra: {} }
}

describe('rectContains', () => {
  const outer = { x: 0, y: 0, w: 100, h: 100 }

  it('accepts a rect wholly inside', () => {
    expect(rectContains(outer, { x: 10, y: 10, w: 20, h: 20 })).toBe(true)
  })

  it('accepts a rect flush with the boundary', () => {
    expect(rectContains(outer, { x: 0, y: 0, w: 100, h: 100 })).toBe(true)
  })

  it('rejects a rect hanging out on one side — containment, not intersection', () => {
    expect(rectContains(outer, { x: 90, y: 10, w: 20, h: 20 })).toBe(false)
  })

  it('rejects a rect whose centre is inside but whose body is not', () => {
    // Centre-point containment would accept this one; Canvas's rule does not.
    expect(rectContains(outer, { x: 80, y: 40, w: 60, h: 20 })).toBe(false)
  })

  it('rejects a rect entirely outside', () => {
    expect(rectContains(outer, { x: 200, y: 200, w: 10, h: 10 })).toBe(false)
  })
})

describe('nodesInsideGroup', () => {
  const frame = group('g', 0, 0, 200, 200)
  const inside = card('inside', 20, 20)
  const straddling = card('straddling', 180, 20)
  const outside = card('outside', 400, 400)

  it('returns only the wholly contained nodes', () => {
    expect(
      nodesInsideGroup(frame, [frame, inside, straddling, outside]),
    ).toEqual(['inside'])
  })

  it('never returns the group itself', () => {
    expect(nodesInsideGroup(frame, [frame])).toEqual([])
  })

  it('counts a nested group as contained', () => {
    const inner = group('inner', 10, 10, 50, 50)
    expect(nodesInsideGroup(frame, [frame, inner])).toEqual(['inner'])
  })
})

describe('nodesToDragWith', () => {
  const frame = group('g', 0, 0, 200, 200)
  const inside = card('inside', 20, 20)
  const outside = card('outside', 400, 400)
  const nodes = [frame, inside, outside]

  it('carries a group’s contents along with it', () => {
    expect(nodesToDragWith(new Set(['g']), nodes).sort()).toEqual([
      'g',
      'inside',
    ])
  })

  it('carries nothing extra for a plain card', () => {
    expect(nodesToDragWith(new Set(['inside']), nodes)).toEqual(['inside'])
  })

  it('does not duplicate a node that is both selected and contained', () => {
    expect(nodesToDragWith(new Set(['g', 'inside']), nodes).sort()).toEqual([
      'g',
      'inside',
    ])
  })

  it('carries a nested group’s contents too', () => {
    const inner = group('inner', 10, 10, 100, 100)
    const deep = card('deep', 20, 20, 10, 10)
    const all = [frame, inner, deep, outside]
    expect(nodesToDragWith(new Set(['g']), all).sort()).toEqual([
      'deep',
      'g',
      'inner',
    ])
  })

  it('returns nothing for an empty selection', () => {
    expect(nodesToDragWith(new Set(), nodes)).toEqual([])
  })
})

describe('groupRectForNodes', () => {
  it('encloses the union with padding on every side', () => {
    const rect = groupRectForNodes([
      card('a', 0, 0, 50, 50),
      card('b', 100, 80, 50, 50),
    ])
    expect(rect).toEqual({
      x: -GROUP_SELECTION_PADDING,
      y: -GROUP_SELECTION_PADDING,
      w: 150 + GROUP_SELECTION_PADDING * 2,
      h: 130 + GROUP_SELECTION_PADDING * 2,
    })
  })

  it('produces a rect that actually contains what it was built from', () => {
    const nodes = [card('a', 0, 0, 50, 50), card('b', 100, 80, 50, 50)]
    const rect = groupRectForNodes(nodes)
    if (!rect) throw new Error('expected a rect')
    for (const node of nodes) expect(rectContains(rect, node)).toBe(true)
  })

  it('returns null when there is nothing to enclose', () => {
    expect(groupRectForNodes([])).toBeNull()
  })
})
