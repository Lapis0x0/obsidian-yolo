import {
  approachScale,
  approachView,
  cameraFromView,
  clampScale,
  dragPan,
  fitViewToBounds,
  panByWheel,
  scaleAfterWheel,
  screenToWorld,
  unionRect,
  viewAnchoredAt,
  viewFromCamera,
  viewSettled,
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

describe('approachView', () => {
  const start = { tx: 0, ty: 0, scale: 1 }
  const target = { tx: -900, ty: -400, scale: 0.25 }

  it('converges on the whole target view, pan and zoom together', () => {
    let view = start
    for (let i = 0; i < 400; i++) view = approachView(view, target, 16.7, 63)
    expect(view.scale).toBeCloseTo(target.scale, 6)
    expect(view.tx).toBeCloseTo(target.tx, 4)
    expect(view.ty).toBeCloseTo(target.ty, 4)
  })

  it('eases the zoom on the same curve as approachScale', () => {
    const next = approachView(start, target, 160, 160)
    expect(next.scale).toBeCloseTo(
      approachScale(start.scale, target.scale, 160, 160),
      10,
    )
  })

  // The pan's parameter is the scale, not the clock: whatever fraction of the
  // zoom a frame covered, the translation covered the same fraction.
  it('keeps the translation linear in the scale it reached', () => {
    const next = approachView(start, target, 160, 160)
    const progress = (next.scale - start.scale) / (target.scale - start.scale)
    expect(next.tx).toBeCloseTo(start.tx + (target.tx - start.tx) * progress, 8)
    expect(next.ty).toBeCloseTo(start.ty + (target.ty - start.ty) * progress, 8)
  })

  it('moves the same distance per unit time whatever the frame rate', () => {
    let slow = start
    for (let i = 0; i < 30; i++) slow = approachView(slow, target, 16, 160)
    let fast = start
    for (let i = 0; i < 60; i++) fast = approachView(fast, target, 8, 160)
    expect(fast.scale).toBeCloseTo(slow.scale, 10)
    expect(fast.tx).toBeCloseTo(slow.tx, 8)
    expect(fast.ty).toBeCloseTo(slow.ty, 8)
  })

  /**
   * The property the linear-in-scale pan exists for, and the one Obsidian
   * Canvas's own law fails: framing something already centred is a pure zoom,
   * with the subject pinned for every intermediate frame rather than sweeping
   * out and back.
   */
  it('holds a centred subject still while zooming out to frame it', () => {
    const viewport = { x: 400, y: 300 }
    const centred = { tx: 0, ty: 0, scale: 1 }
    const world = screenToWorld(centred, viewport)
    const framed = {
      tx: viewport.x - world.x * 0.2,
      ty: viewport.y - world.y * 0.2,
      scale: 0.2,
    }
    let view = centred
    for (let i = 0; i < 60; i++) {
      view = approachView(view, framed, 16.7, 63)
      const at = screenToWorld(view, viewport)
      expect(at.x).toBeCloseTo(world.x, 6)
      expect(at.y).toBeCloseTo(world.y, 6)
    }
  })

  it('arrives immediately when there is no time constant to spread it over', () => {
    expect(approachView(start, target, 16, 0)).toBe(target)
  })
})

describe('viewSettled', () => {
  const target = { tx: 100, ty: 200, scale: 0.5 }

  it('is settled at the target itself', () => {
    expect(viewSettled(target, target, 0.01, 0.5)).toBe(true)
  })

  it('is not settled while the pan is still short, however exact the zoom', () => {
    expect(viewSettled({ ...target, tx: 101 }, target, 0.01, 0.5)).toBe(false)
  })

  it('is not settled while the zoom is still off, however exact the pan', () => {
    expect(viewSettled({ ...target, scale: 0.51 }, target, 0.01, 0.5)).toBe(
      false,
    )
  })

  it('tolerates sub-threshold error on both axes at once', () => {
    expect(
      viewSettled(
        { tx: 100.4, ty: 199.6, scale: 0.5 * 2 ** 0.005 },
        target,
        0.01,
        0.5,
      ),
    ).toBe(true)
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

describe('unionRect', () => {
  it('returns null for no rects', () => {
    expect(unionRect([])).toBeNull()
  })

  it('covers rects that are far apart', () => {
    expect(
      unionRect([
        { x: -300, y: -160, w: 180, h: 200 },
        { x: 43000, y: 47280, w: 446, h: 1104 },
      ]),
    ).toEqual({ x: -300, y: -160, w: 43746, h: 48544 })
  })
})

describe('fitViewToBounds', () => {
  const scaleBounds = { min: 0.08, max: 2.5 }
  const viewport = { width: 1000, height: 800 }

  it('centers the bounds and picks the tighter axis', () => {
    const view = fitViewToBounds(
      { x: 0, y: 0, w: 2000, h: 400 },
      viewport,
      48,
      scaleBounds,
    )
    // Width is the tight axis: (1000 - 96) / 2000.
    expect(view.scale).toBeCloseTo(0.452, 10)
    // Content center lands on the viewport center.
    expect(view.tx + 1000 * view.scale).toBeCloseTo(500, 10)
    expect(view.ty + 200 * view.scale).toBeCloseTo(400, 10)
  })

  it('never zooms in past 1:1 for small content', () => {
    const view = fitViewToBounds(
      { x: 10, y: 10, w: 100, h: 80 },
      viewport,
      48,
      scaleBounds,
    )
    expect(view.scale).toBe(1)
  })

  it('goes below the wheel-zoom floor when that is what fitting takes', () => {
    const view = fitViewToBounds(
      { x: 0, y: 0, w: 1e6, h: 1e6 },
      viewport,
      48,
      scaleBounds,
    )
    expect(view.scale).toBeCloseTo((800 - 96) / 1e6, 10)
    expect(view.scale).toBeLessThan(scaleBounds.min)
  })
})
