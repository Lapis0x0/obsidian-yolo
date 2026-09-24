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
 * What the modifier keys held during a resize ask of it.
 *
 * `keepAspect` (Shift) holds the card's proportions: a corner follows
 * whichever axis the pointer has stretched further, and a side handle grows
 * the other axis with it, about its middle. `fromCenter` (Alt) grows the card
 * about its centre instead of about the opposite edge — every pixel the handle
 * moves is mirrored on the other side. The two compose, as they do in every
 * design tool that has them.
 */
export type ResizeModifiers = Readonly<{
  keepAspect?: boolean
  fromCenter?: boolean
}>

/**
 * The rectangle a card takes when `handle` is dragged by (dx, dy) world
 * units from `start`.
 *
 * `start` is the rect as it was when the gesture began, never the previous
 * frame's: deltas are measured against a fixed origin so a jittery pointer
 * stream cannot accumulate drift, matching how `dragPan` and card dragging
 * already work.
 *
 * The size is decided first and the position derived from it, never the
 * other way round: that keeps the edge the user is *not* dragging pinned
 * exactly where it was (or, growing from the centre, the centre), including
 * once the minimum is reached and the pointer keeps going. Clamping position
 * and size independently would let a card creep across the board while it
 * sits at its minimum.
 */
export function resizeRect(
  start: CardRect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  min: CardSize,
  modifiers: ResizeModifiers = {},
): CardRect {
  const edges = resizeEdges(handle)
  const reach = modifiers.fromCenter === true ? 2 : 1
  const sized = (size: number, delta: number, edge: ResizeEdge) =>
    edge === 'end'
      ? size + delta * reach
      : edge === 'start'
        ? size - delta * reach
        : size
  let w = Math.max(min.w, sized(start.w, dx, edges.x))
  let h = Math.max(min.h, sized(start.h, dy, edges.y))

  const keepAspect = modifiers.keepAspect === true && start.w > 0 && start.h > 0
  if (keepAspect) {
    const ratio = start.w / start.h
    // A side handle has one axis to follow; a corner follows the one the
    // pointer has pulled further, measured as a proportion so a wide card and
    // a tall one answer alike.
    const followWidth =
      edges.y === null ||
      (edges.x !== null &&
        Math.abs(w / start.w - 1) >= Math.abs(h / start.h - 1))
    if (followWidth) h = w / ratio
    else w = h * ratio
    if (w < min.w) {
      w = min.w
      h = w / ratio
    }
    if (h < min.h) {
      h = min.h
      w = h * ratio
    }
  }

  // Where the box sits once its size is known: about the centre when asked
  // to, or when an aspect-locked side handle grew the axis it does not face;
  // otherwise pinned by the edge the handle does not move.
  const place = (pos: number, size: number, from: number, edge: ResizeEdge) =>
    modifiers.fromCenter === true || (edge === null && keepAspect)
      ? pos + (from - size) / 2
      : edge === 'start'
        ? pos + from - size
        : pos
  return {
    x: place(start.x, w, start.w, edges.x),
    y: place(start.y, h, start.h, edges.y),
    w,
    h,
  }
}
