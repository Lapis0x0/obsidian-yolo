import type { BoardNode } from './fileFormat'
import {
  PLACEMENT_GAP,
  collectObstacles,
  placeBeside,
  placeCard,
} from './placement'

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

describe('placeBeside', () => {
  const source = { x: 0, y: 0, w: 300, h: 400 }

  it('starts right of the source, top-aligned with it', () => {
    expect(placeBeside([source], SIZE, source)).toEqual({
      x: 300 + PLACEMENT_GAP,
      y: 0,
    })
  })

  it('stacks the next one under the last, not on it', () => {
    const first = { x: 300 + PLACEMENT_GAP, y: 0, w: 100, h: 100 }
    const second = { x: first.x, y: 100 + PLACEMENT_GAP, w: 100, h: 60 }
    expect(placeBeside([source, first], SIZE, source)).toEqual({
      x: first.x,
      y: second.y,
    })
    expect(placeBeside([source, first, second], SIZE, source)).toEqual({
      x: first.x,
      y: second.y + 60 + PLACEMENT_GAP,
    })
  })

  it('skips past an unrelated card in the column', () => {
    const other = { x: 300 + PLACEMENT_GAP + 50, y: 20, w: 400, h: 500 }
    expect(placeBeside([source, other], SIZE, source)).toEqual({
      x: 300 + PLACEMENT_GAP,
      y: 520 + PLACEMENT_GAP,
    })
  })

  it('fills a gap big enough for the card', () => {
    const top = { x: 300 + PLACEMENT_GAP, y: 0, w: 100, h: 100 }
    const low = { x: 300 + PLACEMENT_GAP, y: 400, w: 100, h: 100 }
    expect(placeBeside([source, top, low], SIZE, source)).toEqual({
      x: top.x,
      y: 100 + PLACEMENT_GAP,
    })
  })
})
