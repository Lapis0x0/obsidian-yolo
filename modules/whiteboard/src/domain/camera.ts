// Pure camera (pan/zoom) math for the whiteboard canvas — no DOM, no host
// dependency (Module Boundaries, CLAUDE.md: domain/ stays dependency-free).
// The canvas UI (src/ui/canvas.ts) is the only consumer: it owns the actual
// pointer/wheel event wiring and calls these functions to compute the next
// `CanvasView`, matching the algorithm ported from the S2/S3 spikes (`git
// show spike/s2-editor-lifecycle:src/features/whiteboard-spike/fileView.ts`
// setupInteraction()'s wheel handler and pointer-drag math) per
// docs/plans/08-25-yolo-whiteboard/p1-design.md §3.
//
// `CanvasView` (`{tx, ty, scale}`, screen-space camera transform) is
// virtualization.ts's existing type; `Camera` (`{x, y, scale}`, the
// `.yoloboard` file's persisted field name) is fileFormat.ts's. The two
// disagree on field names for the same pan offset (tx/ty vs x/y) because
// they were formalized independently from different spikes — `viewFromCamera`
// / `cameraFromView` are the single point that bridges them.

import type { Camera } from './fileFormat'
import type { CanvasView } from './virtualization'

export type ScreenPoint = Readonly<{ x: number; y: number }>

export type ScaleBounds = Readonly<{ min: number; max: number }>

/** Clamps to [min, max]; a non-finite input (NaN, Infinity from a malformed
 * upstream value) falls back to `min` rather than propagating a broken
 * camera into every downstream transform. */
export function clampScale(scale: number, bounds: ScaleBounds): number {
  if (!Number.isFinite(scale)) return bounds.min
  return Math.min(bounds.max, Math.max(bounds.min, scale))
}

/**
 * The scale a wheel event asks for, expressed as doublings.
 *
 * Zoom is naturally logarithmic — what a gesture means is "twice as close",
 * not "0.7 more" — so the tuning knob is how much wheel delta it takes to
 * double, which stays meaningful at every zoom level. `deltaY` is the event's
 * raw value (positive = zoom out, matching native wheel semantics).
 *
 * The spike's original `Math.exp(-deltaY * 0.01)` was tuned against a
 * trackpad, which emits many tiny deltas; it works out to a doubling every 69
 * units, so a single mouse-wheel notch (120) multiplied the scale by 3.3 and
 * two notches crossed the entire zoom range.
 */
export function scaleAfterWheel(
  scale: number,
  deltaY: number,
  deltaPerDoubling: number,
  bounds: ScaleBounds,
): number {
  return clampScale(scale * 2 ** (-deltaY / deltaPerDoubling), bounds)
}

/**
 * The view that puts `world` under `screen` at the given scale.
 *
 * Cursor-anchored zoom stated as a position rather than a step: the caller
 * holds the point the gesture grabbed, and every intermediate scale on the
 * way to the target re-derives the translation from it. Deriving each frame
 * from the anchor rather than accumulating deltas is what keeps the grabbed
 * point exactly under the cursor throughout, with no drift to accumulate.
 */
export function viewAnchoredAt(
  screen: ScreenPoint,
  world: ScreenPoint,
  scale: number,
): CanvasView {
  return {
    tx: screen.x - world.x * scale,
    ty: screen.y - world.y * scale,
    scale,
  }
}

/**
 * One frame of exponential approach from `current` toward `target`.
 *
 * Interpolated in log space, for the same reason the wheel is: halfway
 * between 0.5x and 2x should look like 1x, not 1.25x. `tauMs` is the time
 * constant — the delay after which roughly 63% of the remaining distance is
 * covered — and `dtMs` is the elapsed frame time, so the motion is identical
 * on a 60Hz and a 120Hz display instead of running twice as fast on one.
 */
export function approachScale(
  current: number,
  target: number,
  dtMs: number,
  tauMs: number,
): number {
  if (tauMs <= 0 || dtMs <= 0) return target
  const alpha = 1 - Math.exp(-dtMs / tauMs)
  return (
    2 ** (Math.log2(current) + (Math.log2(target) - Math.log2(current)) * alpha)
  )
}

/** Plain two-axis wheel pan (no modifier held): screen deltas subtract
 * directly from the translation, scale unchanged. */
export function panByWheel(
  view: CanvasView,
  deltaX: number,
  deltaY: number,
): CanvasView {
  return { ...view, tx: view.tx - deltaX, ty: view.ty - deltaY }
}

/**
 * Pointer-drag pan: `origin` is the view snapshot captured at drag start,
 * `start`/`current` are the pointer's screen position then and now. Kept
 * separate from `panByWheel` because drag deltas accumulate against a fixed
 * origin (so a jittery pointermove stream can't drift), whereas wheel deltas
 * are incremental per-event.
 */
export function dragPan(
  origin: CanvasView,
  start: ScreenPoint,
  current: ScreenPoint,
): CanvasView {
  return {
    ...origin,
    tx: origin.tx + (current.x - start.x),
    ty: origin.ty + (current.y - start.y),
  }
}

/** Inverse of the view transform: a viewport-relative screen point -> the
 * world-space point currently under it. Factored out of `zoomAtPoint`
 * (which computes the same thing inline) so ../domain/selection.ts's
 * marquee-selection math can convert its screen-space drag rectangle into
 * world coordinates for card hit-testing without duplicating the formula. */
export function screenToWorld(
  view: CanvasView,
  point: ScreenPoint,
): ScreenPoint {
  return {
    x: (point.x - view.tx) / view.scale,
    y: (point.y - view.ty) / view.scale,
  }
}

/** `.yoloboard`'s persisted `camera` field -> the canvas's live view state. */
export function viewFromCamera(camera: Camera): CanvasView {
  return { tx: camera.x, ty: camera.y, scale: camera.scale }
}

/** The canvas's live view state -> `.yoloboard`'s persisted `camera` field. */
export function cameraFromView(view: CanvasView): Camera {
  return { x: view.tx, y: view.ty, scale: view.scale }
}
