import {
  approachScale,
  cameraFromView,
  clampScale,
  dragPan,
  panByWheel,
  scaleAfterWheel,
  screenToWorld,
  viewAnchoredAt,
  viewFromCamera,
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

describe('scaleAfterWheel', () => {
  const bounds = { min: 0.08, max: 2.5 }

  it('doubles the scale over exactly one delta-per-doubling of travel', () => {
    expect(scaleAfterWheel(1, -300, 300, bounds)).toBeCloseTo(2, 10)
    expect(scaleAfterWheel(1, 300, 300, bounds)).toBeCloseTo(0.5, 10)
  })

  it('is proportional in doublings, so the same delta means the same zoom at any scale', () => {
    const atOne = scaleAfterWheel(1, -150, 300, bounds) / 1
    const atQuarter = scaleAfterWheel(0.25, -150, 300, bounds) / 0.25
    expect(atQuarter).toBeCloseTo(atOne, 10)
  })

  it('splits into the same total as one large step', () => {
    const once = scaleAfterWheel(1, -200, 300, bounds)
    const twice = scaleAfterWheel(
      scaleAfterWheel(1, -100, 300, bounds),
      -100,
      300,
      bounds,
    )
    expect(twice).toBeCloseTo(once, 10)
  })

  it('clamps to bounds', () => {
    expect(scaleAfterWheel(2.4, -10000, 300, bounds)).toBe(bounds.max)
    expect(scaleAfterWheel(0.1, 10000, 300, bounds)).toBe(bounds.min)
  })
})

describe('viewAnchoredAt', () => {
  it('puts the anchored world point exactly under its screen point', () => {
    const screen = { x: 400, y: 300 }
    const world = { x: 120, y: -40 }
    for (const scale of [0.08, 0.5, 1, 1.7, 2.5]) {
      const view = viewAnchoredAt(screen, world, scale)
      expect(screenToWorld(view, screen).x).toBeCloseTo(world.x, 10)
      expect(screenToWorld(view, screen).y).toBeCloseTo(world.y, 10)
    }
  })

  // Why the glide re-derives from the anchor every frame instead of stepping.
  it('holds the anchor across a whole sequence of intermediate scales', () => {
    const screen = { x: 250, y: 180 }
    const world = { x: -33.5, y: 91.25 }
    for (const scale of [1, 1.1, 1.35, 1.62, 1.9, 2]) {
      expect(
        screenToWorld(viewAnchoredAt(screen, world, scale), screen).x,
      ).toBeCloseTo(world.x, 10)
    }
  })
})

describe('approachScale', () => {
  it('covers ~63% of the remaining doublings in one time constant', () => {
    const next = approachScale(1, 4, 160, 160) // 1 -> 4 is two doublings
    expect(Math.log2(next)).toBeCloseTo(2 * (1 - Math.exp(-1)), 6)
  })

  it('converges toward the target without overshooting it', () => {
    let scale = 1
    for (let i = 0; i < 200; i++) scale = approachScale(scale, 2.5, 16.7, 160)
    expect(scale).toBeCloseTo(2.5, 6)
    expect(scale).toBeLessThanOrEqual(2.5)
  })

  // Frame times chosen to sum to exactly the same 480ms both ways, so any
  // difference is the function's and not the test's arithmetic.
  it('moves the same distance per unit time whatever the frame rate', () => {
    let slow = 1
    for (let i = 0; i < 30; i++) slow = approachScale(slow, 4, 16, 160)
    let fast = 1
    for (let i = 0; i < 60; i++) fast = approachScale(fast, 4, 8, 160)
    expect(fast).toBeCloseTo(slow, 10)
  })

  it('is symmetric in log space: zooming out mirrors zooming in', () => {
    const inward = Math.log2(approachScale(1, 2, 50, 160))
    const outward = Math.log2(approachScale(1, 0.5, 50, 160))
    expect(outward).toBeCloseTo(-inward, 10)
  })

  it('arrives immediately when there is no time constant to spread it over', () => {
    expect(approachScale(1, 2, 16, 0)).toBe(2)
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
    expect(screenToWorld({ tx: 0, ty: 0, scale: 1 }, { x: 42, y: 17 })).toEqual(
      { x: 42, y: 17 },
    )
  })

  it('accounts for pan and scale', () => {
    expect(
      screenToWorld({ tx: 100, ty: -50, scale: 2 }, { x: 300, y: 150 }),
    ).toEqual({ x: 100, y: 100 })
  })

  it('inverts viewAnchoredAt: the cursor world point matches before and after a zoom', () => {
    const view = { tx: 10, ty: -5, scale: 1.25 }
    const cursor = { x: 200, y: 120 }
    const before = screenToWorld(view, cursor)
    const scale = scaleAfterWheel(view.scale, -50, 300, { min: 0.08, max: 2.5 })
    const after = viewAnchoredAt(cursor, before, scale)
    expect(screenToWorld(after, cursor).x).toBeCloseTo(before.x, 10)
    expect(screenToWorld(after, cursor).y).toBeCloseTo(before.y, 10)
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
