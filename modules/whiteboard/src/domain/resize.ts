// Pure card-resize geometry: what a drag on one of a card's eight handles
// does to its world-space rectangle. DOM-free like every other domain/
// module (Module Boundaries, CLAUDE.md) — the canvas UI (src/ui/canvas.ts)
// owns the handles, the pointer capture and the screen->world conversion,
// and calls in here with a plain rect and a world-space delta.
//
// Stated as "which edges does this handle move" rather than as eight cases,
// because that is the whole of the rule: a corner is not a third kind of
// gesture, it is the two edge gestures happening on separate axes. The two
// axes are then identical code, run once per axis.

import type { VirtualCardRect } from './virtualization'

export type ResizeHandle =
  | 'top'
  | 'right'
  | 'bottom'
  | 'left'
  | 'topleft'
  | 'topright'
  | 'bottomleft'
  | 'bottomright'

/** Every handle, in the order the canvas mounts them. */
export const RESIZE_HANDLES: readonly ResizeHandle[] = [
  'top',
  'right',
  'bottom',
  'left',
  'topleft',
  'topright',
  'bottomleft',
  'bottomright',
]

export type CardRect = Readonly<{ x: number; y: number; w: number; h: number }>

/** Which edge of one axis a handle moves: the low one, the high one, or
 * neither (an edge handle leaves the other axis alone). */
export type ResizeEdge = 'start' | 'end' | null

/**
 * The two edges `handle` moves — the whole of what distinguishes the eight
 * handles from one another, which is why both `resizeRect` and the alignment
 * that corrects it (domain/snapping.ts) read it from here rather than each
 * spelling the eight cases out again.
 */
export function resizeEdges(
  handle: ResizeHandle,
): Readonly<{ x: ResizeEdge; y: ResizeEdge }> {
  return {
    x: handle.includes('left')
      ? 'start'
      : handle.includes('right')
        ? 'end'
        : null,
    y: handle.includes('top')
      ? 'start'
      : handle.includes('bottom')
        ? 'end'
        : null,
  }
}

export type CardSize = Readonly<{ w: number; h: number }>

/** Drops the id from a board card, so callers can hand one straight in. */
export function rectOfCard(card: VirtualCardRect): CardRect {
  return { x: card.x, y: card.y, w: card.w, h: card.h }
}

/**
 * One axis of a resize.
 *
 * `movesStart` is a handle on the low edge (left/top), `movesEnd` one on the
 * high edge (right/bottom); a handle that names neither leaves the axis
 * alone, which is what makes an edge handle a one-dimensional resize.
 *
 * The clamp is applied to the size and the position is then derived from it,
 * not the other way round: that keeps the edge the user is *not* dragging
 * pinned exactly where it was, including once the minimum is reached and the
 * pointer keeps going. Clamping position and size independently would let a
 * card creep across the board while it sits at its minimum.
 */
function resizeAxis(
  pos: number,
  size: number,
  delta: number,
  min: number,
  movesStart: boolean,
  movesEnd: boolean,
): Readonly<{ pos: number; size: number }> {
  if (movesEnd) return { pos, size: Math.max(min, size + delta) }
  if (movesStart) {
    const next = Math.max(min, size - delta)
    return { pos: pos + size - next, size: next }
  }
  return { pos, size }
}

/**
 * The rectangle a card takes when `handle` is dragged by (dx, dy) world
 * units from `start`.
 *
 * `start` is the rect as it was when the gesture began, never the previous
 * frame's: deltas are measured against a fixed origin so a jittery pointer
 * stream cannot accumulate drift, matching how `dragPan` and card dragging
 * already work.
 */
export function resizeRect(
  start: CardRect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  min: CardSize,
): CardRect {
  const edges = resizeEdges(handle)
  const horizontal = resizeAxis(
    start.x,
    start.w,
    dx,
    min.w,
    edges.x === 'start',
    edges.x === 'end',
  )
  const vertical = resizeAxis(
    start.y,
    start.h,
    dy,
    min.h,
    edges.y === 'start',
    edges.y === 'end',
  )
  return {
    x: horizontal.pos,
    y: vertical.pos,
    w: horizontal.size,
    h: vertical.size,
  }
}
