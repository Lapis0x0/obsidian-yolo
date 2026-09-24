import { RESIZE_HANDLES, rectOfCard, resizeRect } from './resize'

const start = { x: 100, y: 50, w: 260, h: 180 }
const min = { w: 52, h: 39 }

describe('resizeRect', () => {
  it('grows from the right edge without moving the card', () => {
    expect(resizeRect(start, 'right', 40, 0, min)).toEqual({
      x: 100,
      y: 50,
      w: 300,
      h: 180,
    })
  })

  it('grows from the left edge by moving x, keeping the right edge pinned', () => {
    const next = resizeRect(start, 'left', -40, 0, min)
    expect(next).toEqual({ x: 60, y: 50, w: 300, h: 180 })
    expect(next.x + next.w).toBe(start.x + start.w)
  })

  it('leaves the other axis untouched for an edge handle', () => {
    expect(resizeRect(start, 'top', 999, -30, min)).toEqual({
      x: 100,
      y: 20,
      w: 260,
      h: 210,
    })
    expect(resizeRect(start, 'right', 30, 999, min)).toEqual({
      x: 100,
      y: 50,
      w: 290,
      h: 180,
    })
  })

  it('applies both axes for a corner handle', () => {
    expect(resizeRect(start, 'bottomright', 40, 20, min)).toEqual({
      x: 100,
      y: 50,
      w: 300,
      h: 200,
    })
    const topleft = resizeRect(start, 'topleft', 40, 20, min)
    expect(topleft).toEqual({ x: 140, y: 70, w: 220, h: 160 })
    expect(topleft.x + topleft.w).toBe(start.x + start.w)
    expect(topleft.y + topleft.h).toBe(start.y + start.h)
  })

  it('clamps to the minimum size', () => {
    const next = resizeRect(start, 'bottomright', -1000, -1000, min)
    expect(next).toEqual({ x: 100, y: 50, w: 52, h: 39 })
  })

  // The reason resizeAxis derives position from the clamped size: a card held
  // at its minimum must stay put, not walk across the board as the pointer
  // keeps travelling.
  it('keeps the pinned edge fixed once the minimum is reached', () => {
    const atMin = resizeRect(start, 'topleft', 1000, 1000, min)
    expect(atMin.w).toBe(min.w)
    expect(atMin.h).toBe(min.h)
    expect(atMin.x + atMin.w).toBe(start.x + start.w)
    expect(atMin.y + atMin.h).toBe(start.y + start.h)

    const further = resizeRect(start, 'topleft', 5000, 5000, min)
    expect(further).toEqual(atMin)
  })

  it('is the identity for a zero delta, on every handle', () => {
    for (const handle of RESIZE_HANDLES) {
      expect(resizeRect(start, handle, 0, 0, min)).toEqual(start)
    }
  })

  // What measuring from the gesture's origin buys, and why the canvas keeps
  // the start rect for the whole drag: a pointer that overshoots the minimum
  // and comes back restores the original size exactly. Accumulating frame to
  // frame would have thrown that size away at the clamp.
  it('recovers the original size after the pointer passes the minimum and returns', () => {
    for (const handle of RESIZE_HANDLES) {
      // One of these two directions shrinks, whichever edges this handle
      // moves; neither may cross the floor.
      for (const delta of [-5000, 5000]) {
        const extreme = resizeRect(start, handle, delta, delta, min)
        expect(extreme.w).toBeGreaterThanOrEqual(min.w)
        expect(extreme.h).toBeGreaterThanOrEqual(min.h)
      }
      expect(resizeRect(start, handle, 0, 0, min)).toEqual(start)
    }
  })

  it('grows about the centre with fromCenter, mirroring the pulled edge', () => {
    const next = resizeRect(start, 'right', 40, 0, min, { fromCenter: true })
    expect(next).toEqual({ x: 60, y: 50, w: 340, h: 180 })
    expect(next.x + next.w / 2).toBe(start.x + start.w / 2)
  })

  it('keeps the proportions on a corner, following the axis pulled further', () => {
    const next = resizeRect(start, 'bottomright', 130, 10, min, {
      keepAspect: true,
    })
    expect(next.w).toBe(390)
    expect(next.h).toBeCloseTo(270)
    expect(next.x).toBe(start.x)
    expect(next.y).toBe(start.y)
  })

  it('pins the opposite corner when a top-left corner keeps its proportions', () => {
    const next = resizeRect(start, 'topleft', -130, 0, min, {
      keepAspect: true,
    })
    expect(next.x + next.w).toBe(start.x + start.w)
    expect(next.y + next.h).toBeCloseTo(start.y + start.h)
    expect(next.w / next.h).toBeCloseTo(start.w / start.h)
  })

  it('grows the other axis about its middle for an aspect-locked side handle', () => {
    const next = resizeRect(start, 'right', 130, 0, min, { keepAspect: true })
    expect(next.w).toBe(390)
    expect(next.h).toBeCloseTo(270)
    expect(next.y + next.h / 2).toBeCloseTo(start.y + start.h / 2)
  })

  it('holds the proportions at the minimum size', () => {
    const next = resizeRect(start, 'bottomright', -1000, -1000, min, {
      keepAspect: true,
    })
    expect(next.w).toBeGreaterThanOrEqual(min.w)
    expect(next.h).toBeGreaterThanOrEqual(min.h)
    expect(next.w / next.h).toBeCloseTo(start.w / start.h)
  })
})

describe('rectOfCard', () => {
  it('drops the id', () => {
    expect(rectOfCard({ id: 'c-1', x: 1, y: 2, w: 3, h: 4 })).toEqual({
      x: 1,
      y: 2,
      w: 3,
      h: 4,
    })
  })
})

describe('RESIZE_HANDLES', () => {
  it('covers all four edges and all four corners, without duplicates', () => {
    expect(new Set(RESIZE_HANDLES).size).toBe(8)
  })
})
