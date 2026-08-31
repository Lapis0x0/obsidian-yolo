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

/**
 * One frame of the same approach toward a whole view — the counterpart of
 * `approachScale` for a camera move whose translation is *not* derivable from
 * its scale: framing a selection, as against a cursor-anchored wheel zoom.
 *
 * The scale eases exactly as it does for the wheel; the translation is then
 * **linear in that scale**, not in time. That one choice is what makes the
 * transit look like a zoom instead of a lurch, because a translation linear in
 * scale is precisely a `viewAnchoredAt` path: any two views of different
 * scales share exactly one screen point that means the same world point in
 * both, and a tx linear in s is the unique path that holds it still the whole
 * way. Framing a card that is already centred is then a pure zoom, and no
 * intermediate frame ever shows the board somewhere neither end put it.
 *
 * Obsidian Canvas eases its translation in *world* space instead (its `x`/`y`
 * are world coordinates, its `tZoom` a log2 scale — both interpolated against
 * time). That is a different curve, and a visibly worse one: framing a centred
 * card at 1x down to 0.2x sweeps it 137px sideways and back before it settles.
 *
 * Stated against `current` rather than against a stored origin, so it is
 * self-correcting: a frame the browser skipped, or a target moved mid-flight,
 * simply re-aims from wherever the camera actually is.
 */
export function approachView(
  current: CanvasView,
  target: CanvasView,
  dtMs: number,
  tauMs: number,
): CanvasView {
  if (tauMs <= 0 || dtMs <= 0) return target
  const scale = approachScale(current.scale, target.scale, dtMs, tauMs)
  const remaining = target.scale - current.scale
  // Near the end of a zoom — and throughout a fit that happens to land on the
  // scale it started at — there is no scale change left to hang the pan on.
  // The two agree in the limit (the eased scale covers `alpha` of what is
  // left, so `progress` tends to `alpha`), so the fallback is a seam-free
  // continuation rather than a second kind of motion.
  const progress =
    Math.abs(remaining) > SCALE_PROGRESS_EPSILON * target.scale
      ? (scale - current.scale) / remaining
      : 1 - Math.exp(-dtMs / tauMs)
  return {
    tx: current.tx + (target.tx - current.tx) * progress,
    ty: current.ty + (target.ty - current.ty) * progress,
    scale,
  }
}

/** Relative scale change below which `approachView` stops deriving the pan's
 * progress from the zoom's: the ratio of two vanishing quantities loses its
 * precision long before it loses its meaning. */
const SCALE_PROGRESS_EPSILON = 1e-6

/**
 * Whether `current` is close enough to `target` to call the move over —
 * within `epsilonDoublings` of its zoom and `epsilonPx` of its position.
 *
 * An exponential approach never actually arrives, so something has to decide
 * when it has; the two tolerances are separate because a hundredth of a
 * doubling and half a pixel are both "invisible" but neither implies the
 * other.
 */
export function viewSettled(
  current: CanvasView,
  target: CanvasView,
  epsilonDoublings: number,
  epsilonPx: number,
): boolean {
  return (
    Math.abs(Math.log2(current.scale / target.scale)) < epsilonDoublings &&
    Math.abs(current.tx - target.tx) < epsilonPx &&
    Math.abs(current.ty - target.ty) < epsilonPx
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

export type WorldRect = Readonly<{ x: number; y: number; w: number; h: number }>

/** Smallest rect covering all of `rects`; null when there are none. */
export function unionRect(rects: readonly WorldRect[]): WorldRect | null {
  if (rects.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.w)
    maxY = Math.max(maxY, r.y + r.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * The view that centers `bounds` in a viewport of the given size, zoomed out
 * just enough to fit with `paddingPx` of screen space on every side.
 *
 * Fitting never zooms *in* past 1:1 — matching Obsidian Canvas, where
 * zoom-to-fit on a single small card frames it at natural size rather than
 * blowing it up. It may however zoom *out* below `scaleBounds.min`: that
 * floor bounds interactive wheel zoom, but the whole point of fit-to-all is
 * to frame content however far it is spread — stopping at the floor would
 * center a wide board with every cluster off screen.
 */
export function fitViewToBounds(
  bounds: WorldRect,
  viewport: Readonly<{ width: number; height: number }>,
  paddingPx: number,
  scaleBounds: ScaleBounds,
): CanvasView {
  const availW = Math.max(1, viewport.width - paddingPx * 2)
  const availH = Math.max(1, viewport.height - paddingPx * 2)
  const raw = Math.min(
    availW / Math.max(1, bounds.w),
    availH / Math.max(1, bounds.h),
    1,
  )
  const scale = Number.isFinite(raw)
    ? Math.min(raw, scaleBounds.max)
    : scaleBounds.min
  return {
    tx: (viewport.width - bounds.w * scale) / 2 - bounds.x * scale,
    ty: (viewport.height - bounds.h * scale) / 2 - bounds.y * scale,
    scale,
  }
}

/** Screen-space pointer movement -> world-space movement at `view`'s current
 * scale — a pan/zoom's *translation* doesn't enter into converting a delta,
 * only its scale does, which is what tells a drag gesture (canvas.ts's card
 * move) how far the pointer's client-pixel travel is in board units. */
export function screenDeltaToWorld(
  view: CanvasView,
  dx: number,
  dy: number,
): Readonly<{ dx: number; dy: number }> {
  return { dx: dx / view.scale, dy: dy / view.scale }
}

/** Straight-line distance between two points in the same space (screen or
 * world — the formula doesn't care which). Used wherever a gesture picks the
 * nearer of two candidates, such as canvas.ts's `startEdgeReattach` choosing
 * which end of a pressed edge to grab. */
export function distanceBetween(a: ScreenPoint, b: ScreenPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * World spacing of the lattice at `scale`: `worldStep` doubled as many times
 * as it takes for one cell to cover `minScreenStep` pixels on screen.
 *
 * The dot grid is drawn from this and a drag snaps to it, which is the point
 * of it being one function: a card that lands between two visible dots would
 * be snapping to a lattice the board is not showing, and the user would have
 * no way to predict where it goes. Obsidian Canvas ties the two together the
 * same way (its `gridSpacing` feeds both its background pattern and its
 * `getSnapping`), differing only in taking the step off a table of zoom
 * thresholds rather than computing it.
 */
export function gridStepForScale(
  scale: number,
  worldStep: number,
  minScreenStep: number,
): number {
  const doublings = Math.max(
    0,
    Math.ceil(Math.log2(minScreenStep / (worldStep * scale))),
  )
  return worldStep * 2 ** doublings
}

/** `.yoloboard`'s persisted `camera` field -> the canvas's live view state. */
export function viewFromCamera(camera: Camera): CanvasView {
  return { tx: camera.x, ty: camera.y, scale: camera.scale }
}

/** The canvas's live view state -> `.yoloboard`'s persisted `camera` field. */
export function cameraFromView(view: CanvasView): Camera {
  return { x: view.tx, y: view.ty, scale: view.scale }
}
