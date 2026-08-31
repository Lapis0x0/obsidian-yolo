// Pure-logic viewport virtualization engine, migrated from the S1/S2 spikes
// (docs/plans/08-25-yolo-whiteboard/p1-design.md §3; algorithm ported
// unchanged from `git show
// spike/s2-editor-lifecycle:src/features/whiteboard-spike/virtualization.ts`
// per that spike's "对正式实现的架构建议" #1 and #3):
//   - input is {cards, viewportRect, pinnedIds}, output is a
//     {toMount, toUnmount} diff — no DOM dependency, so swapping the mount
//     consumer (innerHTML -> MarkdownRenderer -> React, etc.) never requires
//     touching this module.
//   - "currently interacting" cards (dragged, edited, selected, ...) are
//     exempted from the unload decision via a generic `pinnedIds` set rather
//     than a one-off drag special-case.
//
// Recompute throttling (~70ms per p1-design §3) and per-frame drain quotas
// are *not* this module's job — those are host-loop concerns owned by the
// (not-yet-built) canvas UI, which calls `recompute()` on a debounce and
// `drain()` once per animation frame.

export type VirtualCardRect = Readonly<{
  id: string
  x: number
  y: number
  w: number
  h: number
}>

export type WorldRect = Readonly<{
  left: number
  top: number
  right: number
  bottom: number
}>

export type CanvasView = Readonly<{
  tx: number
  ty: number
  scale: number
}>

/**
 * Screen-space viewport (+ buffer) projected into world coordinates. Buffer
 * is defined in screen pixels and divided by `scale` here so its on-screen
 * visual width stays constant across zoom levels.
 */
export function computeWorldViewportRect(
  viewportWidthPx: number,
  viewportHeightPx: number,
  view: CanvasView,
  bufferPx: number,
): WorldRect {
  const buf = bufferPx / view.scale
  return {
    left: -view.tx / view.scale - buf,
    top: -view.ty / view.scale - buf,
    right: (viewportWidthPx - view.tx) / view.scale + buf,
    bottom: (viewportHeightPx - view.ty) / view.scale + buf,
  }
}

/** Whether a card's footprint overlaps a world rectangle — the viewport test
 * both virtualization and the canvas's alignment candidates are asking. */
export function intersectsViewport(
  card: VirtualCardRect,
  rect: WorldRect,
): boolean {
  return (
    card.x < rect.right &&
    card.x + card.w > rect.left &&
    card.y < rect.bottom &&
    card.y + card.h > rect.top
  )
}

/**
 * A card counts as "should be visible" if it geometrically intersects the
 * (buffered) viewport, OR it is pinned (currently being interacted with —
 * dragged, edited, selected). This single `vis` value feeds both the mount
 * and unmount branches in `recompute()` below, so a pinned off-screen card
 * does get queued for mount, not just protected from unmount — in practice
 * this rarely matters since a card is normally pinned only once it is
 * already on screen and being interacted with.
 */
function wantsVisible(
  card: VirtualCardRect,
  rect: WorldRect,
  pinnedIds: ReadonlySet<string>,
): boolean {
  return pinnedIds.has(card.id) || intersectsViewport(card, rect)
}

export class VirtualizationEngine {
  private readonly mountedIds = new Set<string>()
  private readonly mountQueue: string[] = []
  private readonly unmountQueue: string[] = []
  private readonly mountQueueSet = new Set<string>()
  private readonly unmountQueueSet = new Set<string>()

  get mounted(): ReadonlySet<string> {
    return this.mountedIds
  }

  isPendingMount(id: string): boolean {
    return this.mountQueueSet.has(id)
  }

  /**
   * Forgets everything: no card is mounted, nothing is queued.
   *
   * For the caller that has just torn down every card's DOM (canvas.ts's
   * `teardownAllCards`, on a board reload). Clearing only the queues would
   * leave `mountedIds` claiming cards that no longer exist in the document,
   * and the next `recompute()` would then see every card as already mounted
   * and queue nothing — a board reloaded in place (an external edit, a sync,
   * our own self-heal write-back) would come up empty until the whole view
   * was rebuilt.
   */
  reset(): void {
    this.mountedIds.clear()
    this.mountQueue.length = 0
    this.unmountQueue.length = 0
    this.mountQueueSet.clear()
    this.unmountQueueSet.clear()
  }

  /**
   * Re-derives which cards should be mounted/unmounted given the current
   * viewport rect and pinned set, and queues the diff. Call this on a
   * debounce (not every frame) — recompute throttling and drain-quota
   * throttling are two independent knobs, both owned by the caller.
   */
  recompute(
    cards: readonly VirtualCardRect[],
    viewportRect: WorldRect,
    pinnedIds: ReadonlySet<string>,
  ): void {
    for (const card of cards) {
      const vis = wantsVisible(card, viewportRect, pinnedIds)
      const isMounted = this.mountedIds.has(card.id)
      if (vis && !isMounted) {
        if (!this.mountQueueSet.has(card.id)) {
          this.mountQueue.push(card.id)
          this.mountQueueSet.add(card.id)
        }
        if (this.unmountQueueSet.has(card.id)) {
          this.unmountQueueSet.delete(card.id)
          const idx = this.unmountQueue.indexOf(card.id)
          if (idx !== -1) this.unmountQueue.splice(idx, 1)
        }
      } else if (!vis && isMounted) {
        if (!this.unmountQueueSet.has(card.id)) {
          this.unmountQueue.push(card.id)
          this.unmountQueueSet.add(card.id)
        }
      }
    }
  }

  /**
   * Ignores viewport intersection and force-queues every card for mount —
   * used when virtualization is turned off entirely. Kept for parity with
   * the engine's contract even though 1.0's UI doesn't expose the toggle.
   */
  recomputeAllVisible(cards: readonly VirtualCardRect[]): void {
    for (const card of cards) {
      if (!this.mountedIds.has(card.id) && !this.mountQueueSet.has(card.id)) {
        this.mountQueue.push(card.id)
        this.mountQueueSet.add(card.id)
      }
    }
    this.unmountQueue.length = 0
    this.unmountQueueSet.clear()
  }

  /**
   * Drains up to `mountQuota`/`unmountQuota` ids off the front of each
   * queue and marks them mounted/unmounted immediately (the caller is
   * expected to perform the matching DOM mount/unmount synchronously, or at
   * least start it, bounding how many *start* per frame).
   */
  drain(
    mountQuota: number,
    unmountQuota: number,
  ): { toMount: string[]; toUnmount: string[] } {
    const toMount = this.mountQueue.splice(0, mountQuota)
    for (const id of toMount) {
      this.mountQueueSet.delete(id)
      this.mountedIds.add(id)
    }
    const toUnmount = this.unmountQueue.splice(0, unmountQuota)
    for (const id of toUnmount) {
      this.unmountQueueSet.delete(id)
      this.mountedIds.delete(id)
    }
    return { toMount, toUnmount }
  }

  /** Escape hatch for callers that mount/unmount outside the normal diff. */
  markMounted(id: string): void {
    this.mountedIds.add(id)
  }

  markUnmounted(id: string): void {
    this.mountedIds.delete(id)
    const mIdx = this.mountQueue.indexOf(id)
    if (mIdx !== -1) {
      this.mountQueue.splice(mIdx, 1)
      this.mountQueueSet.delete(id)
    }
  }
}
