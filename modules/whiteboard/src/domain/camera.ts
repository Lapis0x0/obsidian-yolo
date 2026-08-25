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
 * Cursor-anchored zoom: recomputes (tx, ty, scale) so the world point
 * currently under `cursor` (a viewport-relative screen point) stays under
 * the cursor after the scale change. `deltaY` is the wheel event's raw
 * value (positive = zoom out, matching native wheel semantics); the
 * exponential factor mirrors the spike's tuning (`Math.exp(-deltaY * 0.01)`,
 * chosen there for a natural-feeling trackpad/mouse-wheel zoom speed).
 */
export function zoomAtPoint(
  view: CanvasView,
  cursor: ScreenPoint,
  deltaY: number,
  bounds: ScaleBounds,
): CanvasView {
  const worldX = (cursor.x - view.tx) / view.scale
  const worldY = (cursor.y - view.ty) / view.scale
  const factor = Math.exp(-deltaY * 0.01)
  const scale = clampScale(view.scale * factor, bounds)
  return {
    tx: cursor.x - worldX * scale,
    ty: cursor.y - worldY * scale,
    scale,
  }
}

/** Plain two-axis wheel pan (no modifier held): screen deltas subtract
 * directly from the translation, scale unchanged. */
export function panByWheel(view: CanvasView, deltaX: number, deltaY: number): CanvasView {
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

/** `.yoloboard`'s persisted `camera` field -> the canvas's live view state. */
export function viewFromCamera(camera: Camera): CanvasView {
  return { tx: camera.x, ty: camera.y, scale: camera.scale }
}

/** The canvas's live view state -> `.yoloboard`'s persisted `camera` field. */
export function cameraFromView(view: CanvasView): Camera {
  return { x: view.tx, y: view.ty, scale: view.scale }
}
