import { SPREAD_DEAL_MAX_DELAY_MS, SPREAD_DEAL_STAGGER_MS } from './constants'
import { groupFoldMotions, sheetMotion, spreadMotions } from './foldMotion'

const card = { x: 100, y: 200, w: 390 }
const sheet = (page: number, x: number, y: number, w = 390) => ({
  id: `p${page}`,
  page,
  x,
  y,
  w,
})

describe('sheetMotion', () => {
  it('carries the page the card shows whole, on top and at once', () => {
    for (const direction of ['in', 'out'] as const) {
      const motion = sheetMotion(sheet(3, 900, 600), card, 3, direction)
      expect(motion).toEqual({
        offset: { x: -800, y: -400 },
        scale: 1,
        fade: false,
        delay: 0,
        onTop: true,
      })
    }
  })

  it('fades every other page under it', () => {
    const motion = sheetMotion(sheet(1, 100, 200), card, 3, 'in')
    expect(motion.fade).toBe(true)
    expect(motion.onTop).toBe(false)
    expect(motion.offset).toEqual({ x: 0, y: 0 })
  })

  it('makes each sheet as wide as the card at the card’s end', () => {
    expect(sheetMotion(sheet(2, 0, 0, 780), card, 1, 'out').scale).toBe(0.5)
  })

  it('deals the others out in page order, capped, and gathers them together', () => {
    expect(sheetMotion(sheet(1, 0, 0), card, 5, 'in').delay).toBe(0)
    expect(sheetMotion(sheet(4, 0, 0), card, 1, 'in').delay).toBe(
      3 * SPREAD_DEAL_STAGGER_MS,
    )
    expect(sheetMotion(sheet(10_000, 0, 0), card, 1, 'in').delay).toBe(
      SPREAD_DEAL_MAX_DELAY_MS,
    )
    expect(sheetMotion(sheet(4, 0, 0), card, 1, 'out').delay).toBe(0)
  })
})

describe('spreadMotions', () => {
  it('puts the page the card shows last, so it is drawn over the rest', () => {
    const sheets = [sheet(1, 0, 0), sheet(2, 400, 0), sheet(3, 800, 0)]
    const order = spreadMotions(sheets, card, 2, 'out').map(
      (move) => move.node.id,
    )
    expect(order).toEqual(['p1', 'p3', 'p2'])
  })

  it('has nothing on top when the page the card shows is not there', () => {
    const moves = spreadMotions([sheet(1, 0, 0)], card, 7, 'in')
    expect(moves.some((move) => move.motion.onTop)).toBe(false)
  })
})

describe('groupFoldMotions', () => {
  const place = {
    id: 'a',
    extent: { x: 100, y: 100, w: 200, h: 100 },
    scale: 0.25,
    x: 10,
    y: 20,
    more: false,
  }

  it('carries the thing and what it carries under one map, whole', () => {
    const nodes = [
      { id: 'a', x: 100, y: 100 },
      { id: 'a/p1', x: 200, y: 140 },
    ]
    const moves = groupFoldMotions([place], () => nodes)
    expect(moves.map((move) => move.motion)).toEqual([
      {
        offset: { x: -90, y: -80 },
        scale: 0.25,
        fade: false,
        delay: 0,
        onTop: false,
      },
      {
        // Folded at (10 + 100 * .25, 20 + 40 * .25): the same picture,
        // smaller, wherever in it a node is.
        offset: { x: 35 - 200, y: 30 - 140 },
        scale: 0.25,
        fade: false,
        delay: 0,
        onTop: false,
      },
    ])
  })

  it('fades what goes into the cell saying how many more', () => {
    const moves = groupFoldMotions([{ ...place, more: true }], () => [
      { id: 'a', x: 100, y: 100 },
    ])
    expect(moves[0]?.motion.fade).toBe(true)
  })
})
