import { marqueeRectFromPoints, nodeAtPoint, nodesInMarquee } from './selection'
import type { VirtualCardRect } from './virtualization'

function card(
  id: string,
  x: number,
  y: number,
  w = 100,
  h = 100,
): VirtualCardRect {
  return { id, x, y, w, h }
}

describe('marqueeRectFromPoints', () => {
  it('normalizes a drag that went down-right into a rect', () => {
    expect(marqueeRectFromPoints({ x: 10, y: 20 }, { x: 110, y: 220 })).toEqual(
      {
        left: 10,
        top: 20,
        right: 110,
        bottom: 220,
      },
    )
  })

  it('normalizes a drag that went up-left (reversed corners) the same way', () => {
    expect(marqueeRectFromPoints({ x: 110, y: 220 }, { x: 10, y: 20 })).toEqual(
      {
        left: 10,
        top: 20,
        right: 110,
        bottom: 220,
      },
    )
  })

  it('produces a zero-size rect for a click with no movement', () => {
    expect(marqueeRectFromPoints({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({
      left: 5,
      top: 5,
      right: 5,
      bottom: 5,
    })
  })
})

describe('nodesInMarquee', () => {
  it('selects a card fully inside the rect', () => {
    const rect = { left: 0, top: 0, right: 200, bottom: 200 }
    expect(nodesInMarquee([card('a', 10, 10)], rect)).toEqual(['a'])
  })

  it('selects a card that only partially intersects the rect', () => {
    const rect = { left: 0, top: 0, right: 50, bottom: 50 }
    expect(nodesInMarquee([card('a', 25, 25)], rect)).toEqual(['a'])
  })

  it('excludes a card entirely outside the rect', () => {
    const rect = { left: 0, top: 0, right: 50, bottom: 50 }
    expect(nodesInMarquee([card('a', 1000, 1000)], rect)).toEqual([])
  })

  it('excludes a card that only touches the rect edge (open interval, no false positive on a zero-size marquee)', () => {
    const rect = marqueeRectFromPoints({ x: 5, y: 5 }, { x: 5, y: 5 })
    expect(nodesInMarquee([card('a', 5, 5)], rect)).toEqual([])
  })

  it('preserves input order and includes every intersecting card', () => {
    const rect = { left: 0, top: 0, right: 1000, bottom: 1000 }
    const cards = [card('a', 0, 0), card('b', 500, 500), card('c', 2000, 2000)]
    expect(nodesInMarquee(cards, rect)).toEqual(['a', 'b'])
  })
})

describe('nodeAtPoint', () => {
  const a = card('a', 0, 0, 100, 100)
  const b = card('b', 50, 50, 100, 100)

  it('finds nothing on open canvas', () => {
    expect(nodeAtPoint([a, b], { x: 500, y: 500 })).toBeNull()
  })

  it('finds the card the point is inside', () => {
    expect(nodeAtPoint([a, b], { x: 10, y: 10 })).toBe('a')
    expect(nodeAtPoint([a, b], { x: 140, y: 140 })).toBe('b')
  })

  it('returns the topmost card where two overlap', () => {
    // Later cards paint over earlier ones.
    expect(nodeAtPoint([a, b], { x: 60, y: 60 })).toBe('b')
    expect(nodeAtPoint([b, a], { x: 60, y: 60 })).toBe('a')
  })

  it('counts the border as inside', () => {
    expect(nodeAtPoint([a], { x: 0, y: 50 })).toBe('a')
    expect(nodeAtPoint([a], { x: 100, y: 50 })).toBe('a')
  })
})
