// What a gesture holds the pointer on, and so what cursor it shows.
//
// A gesture captures the pointer so that it keeps the moves and the release
// wherever they go — off the card, over live content, out of the viewport.
// While an element holds the capture, Blink hit-tests every move to *that
// element* and takes the cursor from its style (event_handler.cc's
// `PerformMouseEventHitTest` with a capture target, then `SelectCursor`): so
// whatever holds it decides the cursor for the whole gesture, from the press
// to the release, whatever the pointer passes over.
//
// Every gesture holds it on one element, then — an empty box over the
// viewport (canvas/viewport.css's `.yolo-whiteboard-pan-capture`) — told
// first which cursor the gesture shows: the closed hand for anything carried
// or panned, the handle's own arrow for a resize, the pointing hand for a
// connection drawn out, the plain arrow for a marquee. Holding it on the
// viewport instead showed the viewport's arrow whatever the gesture was; and
// the cursor cannot be put on the viewport, because `cursor` is inherited
// and an inherited property changed there is recomputed on everything under
// it — every card, every edge path and label — ~130ms each way on a
// 3000-edge board (measured 2026-09-02). The box has no descendants, so
// telling it a cursor restyles nothing else.

import type { ResizeHandle } from '../../domain/resize'

/** The cursor a gesture shows while it holds the pointer. */
export type HeldCursor =
  | 'default'
  | 'grabbing'
  | 'pointer'
  | 'ns-resize'
  | 'ew-resize'
  | 'nwse-resize'
  | 'nesw-resize'

/** Holds `pointerId` for a gesture, showing `cursor` until it is let go. */
export type HoldPointer = (pointerId: number, cursor: HeldCursor) => void

/** Holding the pointer on `el`, the one element every gesture holds it on. */
export function holdPointerOn(el: HTMLElement): HoldPointer {
  return (pointerId, cursor) => {
    el.setCssProps({ '--yolo-whiteboard-held-cursor': cursor })
    el.setPointerCapture(pointerId)
  }
}

/** The arrow a resize from `handle` shows — the one its handle shows under
 * the pointer (cards/resize-handles.css). */
export function resizeCursor(handle: ResizeHandle): HeldCursor {
  switch (handle) {
    case 'top':
    case 'bottom':
      return 'ns-resize'
    case 'left':
    case 'right':
      return 'ew-resize'
    case 'topleft':
    case 'bottomright':
      return 'nwse-resize'
    case 'topright':
    case 'bottomleft':
      return 'nesw-resize'
  }
}
