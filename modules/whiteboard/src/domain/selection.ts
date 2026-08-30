// Pure marquee-selection math: normalizing a drag gesture's two corner
// points into a world-space rectangle, and hit-testing board cards against
// it (docs/plans/08-25-yolo-whiteboard/p1-design.md §3's "框选"). The canvas
// UI (src/ui/canvas.ts) owns the actual overlay div and the screen->world
// conversion (via ./camera's `screenToWorld`) — this module only ever sees
// plain world-space points/rects, keeping it DOM-free like every other
// domain/ module.
//
// Selection itself (which ids are currently selected) is UI state, not board
// data (p1-design §7#3 doesn't mention it, and it has no `.yoloboard`
// representation) — this module never touches `Board`, only plain rects.

import type { ScreenPoint } from './camera'
import type { VirtualCardRect, WorldRect } from './virtualization'

/**
 * Normalizes two arbitrary corner points (the drag's start and current/end
 * position, in the same coordinate space) into a `WorldRect` regardless of
 * which direction the user dragged.
 */
export function marqueeRectFromPoints(
  a: ScreenPoint,
  b: ScreenPoint,
): WorldRect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  }
}

/**
 * Same open-interval intersection test as virtualization.ts's viewport
 * check, deliberately re-derived rather than imported/shared: this one
 * answers "does the user's marquee rectangle select this card" (a UI/input
 * concern), while virtualization's answers "is this card visible" (a
 * rendering concern) — the two happen to share a formula today but are free
 * to diverge (e.g. marquee could switch to full-containment) without
 * coupling the two modules.
 */
function intersects(card: VirtualCardRect, rect: WorldRect): boolean {
  return (
    card.x < rect.right &&
    card.x + card.w > rect.left &&
    card.y < rect.bottom &&
    card.y + card.h > rect.top
  )
}

/** Ids of every card intersecting `rect`, in the input cards' order. */
export function cardsInMarquee(
  cards: readonly VirtualCardRect[],
  rect: WorldRect,
): string[] {
  return cards.filter((card) => intersects(card, rect)).map((card) => card.id)
}

/**
 * The card a world-space point lands on, or null for open canvas. Later cards
 * paint over earlier ones, so the scan runs backwards and the topmost one
 * wins — the same card the user sees under the pointer.
 *
 * Answering this from geometry rather than from an event's target is not a
 * preference: a gesture that captured the pointer retargets every mouse event
 * after it to the capturing element, so `click`/`dblclick` on a card arrive
 * naming the viewport (see canvas.ts's onDoubleClick).
 */
export function cardAtPoint(
  cards: readonly VirtualCardRect[],
  point: ScreenPoint,
): string | null {
  for (let index = cards.length - 1; index >= 0; index -= 1) {
    const card = cards[index]
    if (
      point.x >= card.x &&
      point.x <= card.x + card.w &&
      point.y >= card.y &&
      point.y <= card.y + card.h
    ) {
      return card.id
    }
  }
  return null
}
