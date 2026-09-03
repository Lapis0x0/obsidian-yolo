import type { BoardNode } from './fileFormat'
import { PLACEMENT_GAP, collectObstacles, placeCard } from './placement'

const SIZE = { w: 100, h: 100 }

function card(id: string, x: number, y: number): BoardNode {
  return { id, type: 'text', x, y, w: 100, h: 100, text: '', extra: {} }
}

describe('collectObstacles', () => {
  it('leaves group frames out — a card landing inside one is how it joins', () => {
    const nodes: BoardNode[] = [
      card('c-1', 0, 0),
      { id: 'g-1', type: 'group', x: 0, y: 0, w: 900, h: 900, extra: {} },
    ]
    expect(collectObstacles(nodes)).toEqual([{ x: 0, y: 0, w: 100, h: 100 }])
  })
})

describe('placeCard', () => {
  it('puts the first card of an empty board at the origin', () => {
    expect(placeCard([], SIZE)).toEqual({ x: 0, y: 0 })
  })

  it('places beside what is already there, not on top of it', () => {
    const obstacles = collectObstacles([card('c-1', 0, 0)])
    expect(placeCard(obstacles, SIZE)).toEqual({
      x: 100 + PLACEMENT_GAP,
      y: 0,
    })
  })

  it('follows the card it was told to follow', () => {
    const previous = { x: 500, y: 300, w: 100, h: 100 }
    expect(placeCard([previous], SIZE, previous)).toEqual({
      x: 600 + PLACEMENT_GAP,
      y: 300,
    })
  })

  it('steps further along rather than pushing an occupant aside', () => {
    const previous = { x: 0, y: 0, w: 100, h: 100 }
    const blocker = { x: 140, y: 0, w: 100, h: 100 }
    const point = placeCard([previous, blocker], SIZE, previous)
    expect(point.y).toBe(0)
    expect(point.x).toBeGreaterThanOrEqual(blocker.x + blocker.w)
  })

  it('never lands behind what it follows', () => {
    const previous = { x: 0, y: 0, w: 100, h: 100 }
    const wall = Array.from({ length: 5 }, (_, index) => ({
      x: 140 + index * 140,
      y: 0,
      w: 100,
      h: 100,
    }))
    const point = placeCard([previous, ...wall], SIZE, previous)
    expect(point.x).toBeGreaterThan(previous.x)
  })
})
