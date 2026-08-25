import {
  cameraFromView,
  clampScale,
  dragPan,
  panByWheel,
  screenToWorld,
  viewFromCamera,
  zoomAtPoint,
} from './camera'

describe('clampScale', () => {
  const bounds = { min: 0.08, max: 2.5 }

  it('passes through a value already in range', () => {
    expect(clampScale(1, bounds)).toBe(1)
  })

  it('clamps above max', () => {
    expect(clampScale(10, bounds)).toBe(2.5)
  })

  it('clamps below min', () => {
    expect(clampScale(0.001, bounds)).toBe(0.08)
  })

  it('falls back to min for a non-finite input rather than propagating it', () => {
    expect(clampScale(Number.NaN, bounds)).toBe(0.08)
    expect(clampScale(Number.POSITIVE_INFINITY, bounds)).toBe(0.08)
  })
})

describe('zoomAtPoint', () => {
  const bounds = { min: 0.08, max: 2.5 }

  it('keeps the world point under the cursor fixed on screen across a zoom', () => {
    const view = { tx: 0, ty: 0, scale: 1 }
    const cursor = { x: 400, y: 300 }
    const worldXBefore = (cursor.x - view.tx) / view.scale
    const worldYBefore = (cursor.y - view.ty) / view.scale

    const next = zoomAtPoint(view, cursor, -100, bounds)

    const worldXAfter = (cursor.x - next.tx) / next.scale
    const worldYAfter = (cursor.y - next.ty) / next.scale
    expect(worldXAfter).toBeCloseTo(worldXBefore, 10)
    expect(worldYAfter).toBeCloseTo(worldYBefore, 10)
  })

  it('zooms in for a negative deltaY and out for a positive one', () => {
    const view = { tx: 0, ty: 0, scale: 1 }
    const zoomedIn = zoomAtPoint(view, { x: 0, y: 0 }, -100, bounds)
    const zoomedOut = zoomAtPoint(view, { x: 0, y: 0 }, 100, bounds)
    expect(zoomedIn.scale).toBeGreaterThan(1)
    expect(zoomedOut.scale).toBeLessThan(1)
  })

  it('clamps the resulting scale to bounds', () => {
    const view = { tx: 0, ty: 0, scale: 2.4 }
    const next = zoomAtPoint(view, { x: 0, y: 0 }, -10000, bounds)
    expect(next.scale).toBe(bounds.max)
  })
})

describe('panByWheel', () => {
  it('subtracts screen deltas from the translation, scale unchanged', () => {
    const view = { tx: 10, ty: 20, scale: 1.5 }
    expect(panByWheel(view, 5, -5)).toEqual({ tx: 5, ty: 25, scale: 1.5 })
  })
})

describe('dragPan', () => {
  it('accumulates against the fixed drag-start origin, not incrementally', () => {
    const origin = { tx: 100, ty: 50, scale: 1 }
    const start = { x: 10, y: 10 }
    const mid = dragPan(origin, start, { x: 30, y: 5 })
    const end = dragPan(origin, start, { x: 60, y: -5 })
    // Both derived from the same origin/start, so a jittery pointer path
    // (mid then end) can't drift the result — end depends only on (origin,
    // start, end), not on having passed through mid.
    expect(mid).toEqual({ tx: 120, ty: 45, scale: 1 })
    expect(end).toEqual({ tx: 150, ty: 35, scale: 1 })
  })

  it('leaves scale untouched', () => {
    const origin = { tx: 0, ty: 0, scale: 0.42 }
    const next = dragPan(origin, { x: 0, y: 0 }, { x: 100, y: 100 })
    expect(next.scale).toBe(0.42)
  })
})

describe('screenToWorld', () => {
  it('is the identity at scale 1 with no pan', () => {
    expect(screenToWorld({ tx: 0, ty: 0, scale: 1 }, { x: 42, y: 17 })).toEqual({ x: 42, y: 17 })
  })

  it('accounts for pan and scale', () => {
    expect(screenToWorld({ tx: 100, ty: -50, scale: 2 }, { x: 300, y: 150 })).toEqual({ x: 100, y: 100 })
  })

  it('inverts zoomAtPoint: the cursor world point matches before and after a zoom', () => {
    const view = { tx: 10, ty: -5, scale: 1.25 }
    const cursor = { x: 200, y: 120 }
    const before = screenToWorld(view, cursor)
    const after = zoomAtPoint(view, cursor, -50, { min: 0.08, max: 2.5 })
    expect(screenToWorld(after, cursor)).toEqual(before)
  })
})

describe('viewFromCamera / cameraFromView round-trip', () => {
  it('round-trips a camera through a view and back unchanged', () => {
    const camera = { x: 12.5, y: -7, scale: 1.75 }
    expect(cameraFromView(viewFromCamera(camera))).toEqual(camera)
  })

  it('maps camera.x/y to view.tx/ty', () => {
    expect(viewFromCamera({ x: 1, y: 2, scale: 3 })).toEqual({
      tx: 1,
      ty: 2,
      scale: 3,
    })
  })
})
