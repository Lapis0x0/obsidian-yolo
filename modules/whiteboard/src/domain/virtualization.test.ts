import {
  type VirtualCardRect,
  VirtualizationEngine,
  type WorldRect,
  computeWorldViewportRect,
} from './virtualization'

function card(
  id: string,
  x: number,
  y: number,
  w = 100,
  h = 100,
): VirtualCardRect {
  return { id, x, y, w, h }
}

const NO_PINS = new Set<string>()

describe('computeWorldViewportRect', () => {
  it('projects the screen viewport into world space at scale 1 with no pan', () => {
    const rect = computeWorldViewportRect(
      800,
      600,
      { tx: 0, ty: 0, scale: 1 },
      0,
    )
    // Normalize -0 (from `-tx / scale` with tx=0): equal to 0, distinct only
    // under Object.is, which toEqual uses.
    expect({
      left: rect.left || 0,
      top: rect.top || 0,
      right: rect.right,
      bottom: rect.bottom,
    }).toEqual({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
    })
  })

  it('adds a buffer band in screen pixels, converted to world space by dividing by scale', () => {
    const rect = computeWorldViewportRect(
      800,
      600,
      { tx: 0, ty: 0, scale: 2 },
      400,
    )
    // buffer 400px / scale 2 = 200 world units on every side
    expect(rect).toEqual({ left: -200, top: -200, right: 600, bottom: 500 })
  })

  it('accounts for pan (tx, ty)', () => {
    const rect = computeWorldViewportRect(
      800,
      600,
      { tx: 100, ty: -50, scale: 1 },
      0,
    )
    expect(rect).toEqual({ left: -100, top: 50, right: 700, bottom: 650 })
  })
})

describe('VirtualizationEngine', () => {
  const viewport: WorldRect = { left: 0, top: 0, right: 100, bottom: 100 }

  it('queues an off-screen card for mount once it intersects the viewport', () => {
    const engine = new VirtualizationEngine()
    engine.recompute([card('a', 0, 0)], viewport, NO_PINS)
    expect(engine.isPendingMount('a')).toBe(true)
    expect(engine.mounted.has('a')).toBe(false)
  })

  it('does not queue a card entirely outside the viewport', () => {
    const engine = new VirtualizationEngine()
    engine.recompute([card('a', 1000, 1000)], viewport, NO_PINS)
    expect(engine.isPendingMount('a')).toBe(false)
    expect(engine.mounted.size).toBe(0)
  })

  it('treats a card exactly touching the buffered viewport edge as intersecting (open interval semantics)', () => {
    const engine = new VirtualizationEngine()
    // Card spans (90, 0)-(190, 100): x < right(100) is true (90 < 100), so it intersects.
    engine.recompute([card('edge', 90, 0)], viewport, NO_PINS)
    expect(engine.isPendingMount('edge')).toBe(true)
  })

  it('queues a mounted card for unmount once it leaves the viewport', () => {
    const engine = new VirtualizationEngine()
    engine.recompute([card('a', 0, 0)], viewport, NO_PINS)
    engine.drain(10, 10)
    expect(engine.mounted.has('a')).toBe(true)

    engine.recompute([card('a', 1000, 1000)], viewport, NO_PINS)
    const { toMount, toUnmount } = engine.drain(10, 10)
    expect(toMount).toEqual([])
    expect(toUnmount).toEqual(['a'])
    expect(engine.mounted.has('a')).toBe(false)
  })

  it('does not cancel a queued unmount just by finding the card visible again before draining', () => {
    // `recompute()` only clears a pending unmount from the branch that fires
    // for a currently-*unmounted* card becoming visible (see wantsVisible's
    // doc comment) — `mountedIds` itself is untouched by recompute(), so a
    // card that is still mounted stays `isMounted === true` across repeated
    // recompute() calls, and a queued unmount for it is never revisited
    // until drain() actually processes it. This is a one-frame flicker the
    // engine self-heals on the *next* recompute (see the following test),
    // not a bug to "fix" here — the algorithm is ported unchanged from the
    // spike.
    const engine = new VirtualizationEngine()
    engine.recompute([card('a', 0, 0)], viewport, NO_PINS)
    engine.drain(10, 10)

    engine.recompute([card('a', 1000, 1000)], viewport, NO_PINS) // queues unmount
    engine.recompute([card('a', 0, 0)], viewport, NO_PINS) // visible again, but still queued

    const { toMount, toUnmount } = engine.drain(10, 10)
    expect(toMount).toEqual([])
    expect(toUnmount).toEqual(['a'])
    expect(engine.mounted.has('a')).toBe(false)

    // Self-heals: the next recompute sees it unmounted-but-visible and re-queues it.
    engine.recompute([card('a', 0, 0)], viewport, NO_PINS)
    expect(engine.isPendingMount('a')).toBe(true)
  })

  it('cancels a queued mount for a card that leaves the viewport before it drains', () => {
    const engine = new VirtualizationEngine()
    engine.recompute([card('a', 0, 0)], viewport, NO_PINS)
    expect(engine.isPendingMount('a')).toBe(true)

    // Left before the quota reached it: mounting it now would build a card
    // that is not on screen, and the next tick would queue its unmount.
    engine.recompute([card('a', 1000, 1000)], viewport, NO_PINS)
    expect(engine.isPendingMount('a')).toBe(false)
    const { toMount, toUnmount } = engine.drain(10, 10)
    expect(toMount).toEqual([])
    expect(toUnmount).toEqual([])
    expect(engine.mounted.size).toBe(0)
  })

  it('leaves the rest of the mount queue in order when one entry is cancelled', () => {
    const engine = new VirtualizationEngine()
    engine.recompute(
      [card('a', 0, 0), card('b', 10, 0), card('c', 20, 0)],
      viewport,
      NO_PINS,
    )
    engine.recompute(
      [card('a', 0, 0), card('b', 1000, 1000), card('c', 20, 0)],
      viewport,
      NO_PINS,
    )
    expect(engine.drain(10, 10).toMount).toEqual(['a', 'c'])
  })

  it('exempts a pinned card from unmount even when it leaves the viewport', () => {
    const engine = new VirtualizationEngine()
    const pinned = new Set(['a'])
    engine.recompute([card('a', 0, 0)], viewport, pinned)
    engine.drain(10, 10)

    engine.recompute([card('a', 1000, 1000)], viewport, pinned)
    const { toUnmount } = engine.drain(10, 10)
    expect(toUnmount).toEqual([])
    expect(engine.mounted.has('a')).toBe(true)
  })

  it('does queue a mount for a pinned card that is off-screen (pinning feeds the same "wants visible" signal used for mounting)', () => {
    const engine = new VirtualizationEngine()
    const pinned = new Set(['a'])
    engine.recompute([card('a', 1000, 1000)], viewport, pinned)
    expect(engine.isPendingMount('a')).toBe(true)
  })

  it('drain respects independent mount/unmount quotas per call', () => {
    const engine = new VirtualizationEngine()
    const cards = Array.from({ length: 5 }, (_, i) => card(`c${i}`, 0, 0))
    engine.recompute(cards, viewport, NO_PINS)
    const first = engine.drain(2, 10)
    expect(first.toMount).toEqual(['c0', 'c1'])
    expect(engine.mounted.size).toBe(2)

    const second = engine.drain(2, 10)
    expect(second.toMount).toEqual(['c2', 'c3'])

    const third = engine.drain(2, 10)
    expect(third.toMount).toEqual(['c4'])
  })

  it('recomputeAllVisible force-queues every unmounted card and clears pending unmounts', () => {
    const engine = new VirtualizationEngine()
    engine.recompute([card('offscreen', 1000, 1000)], viewport, NO_PINS)
    expect(engine.isPendingMount('offscreen')).toBe(false)

    engine.recomputeAllVisible([
      card('offscreen', 1000, 1000),
      card('onscreen', 0, 0),
    ])
    expect(engine.isPendingMount('offscreen')).toBe(true)
    expect(engine.isPendingMount('onscreen')).toBe(true)
  })

  it('reset clears the queues and the mounted set alike', () => {
    const engine = new VirtualizationEngine()
    engine.recompute([card('a', 0, 0)], viewport, NO_PINS)
    engine.drain(10, 10)
    engine.recompute([card('a', 1000, 1000)], viewport, NO_PINS)
    expect(engine.mounted.has('a')).toBe(true)

    engine.reset()
    const { toMount, toUnmount } = engine.drain(10, 10)
    expect(toMount).toEqual([])
    expect(toUnmount).toEqual([])
    expect(engine.mounted.has('a')).toBe(false)
  })

  // The caller resets precisely because it has just destroyed every card's
  // DOM. An engine that still believed those cards were mounted would see
  // them as already-mounted on the next pass, queue nothing, and leave a
  // reloaded board empty.
  it('mounts everything again after a reset, as a torn-down view needs', () => {
    const engine = new VirtualizationEngine()
    const cards = [card('a', 0, 0), card('b', 10, 10)]
    engine.recompute(cards, viewport, NO_PINS)
    expect(engine.drain(10, 10).toMount).toEqual(['a', 'b'])

    engine.reset()
    engine.recompute(cards, viewport, NO_PINS)
    expect(engine.drain(10, 10).toMount).toEqual(['a', 'b'])
  })

  it('markMounted/markUnmounted let a caller bypass the normal diff', () => {
    const engine = new VirtualizationEngine()
    engine.markMounted('external')
    expect(engine.mounted.has('external')).toBe(true)

    engine.markUnmounted('external')
    expect(engine.mounted.has('external')).toBe(false)
  })
})
