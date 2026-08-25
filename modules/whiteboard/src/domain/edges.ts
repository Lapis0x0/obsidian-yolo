// Pure geometry for `.yoloboard` edge rendering: anchor-side auto-selection
// and cubic-bezier control-point construction for the single SVG overlay the
// canvas draws all edges into (docs/plans/08-25-yolo-whiteboard/p1-design.md
// §1.1, §3, §7#3 — "贝塞尔曲线...控制点沿锚定边法线方向外推（Hepta/Canvas
// 手感）"). Only imports from ./fileFormat and ./virtualization, both already
// dependency-free domain modules — the module-boundary check requires every
// domain/ import to stay inside domain/
// (scripts/check-whiteboard-module-boundary.test.mjs).
//
// Connection points are derived from board data (card x/y/w/h), never
// measured from the DOM: the canvas UI must be able to draw an edge whose
// endpoint card isn't currently mounted (virtualization) or is mid-drag
// (temporary coordinates the caller passes in), so this module only ever
// sees plain rectangles, never live elements.

import type { CardSide } from './fileFormat'
import type { VirtualCardRect } from './virtualization'

export type Point = Readonly<{ x: number; y: number }>

export type EdgeGeometry = Readonly<{
  start: Point
  end: Point
  c1: Point
  c2: Point
  /** Point at t=0.5 along the curve — where a label is anchored. */
  label: Point
}>

/** How far a control point is pushed out along its anchor side's outward
 * normal, as a fraction of the straight-line distance between the two
 * anchor points (p1-design: "外推距离与两卡距离正相关"). */
export const EDGE_CONTROL_FACTOR = 0.5

/** Upper bound on that extrapolation distance ("设上限"), so two far-apart
 * cards don't get a control point that overshoots into unrelated territory. */
export const EDGE_CONTROL_MAX_PX = 160

const SIDE_NORMALS: Readonly<Record<CardSide, Point>> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
}

/** Midpoint of the given side of a card rect, in world coordinates — the
 * edge's connection point. Computed from data, never measured from the DOM
 * (see file doc comment). */
export function anchorPoint(card: VirtualCardRect, side: CardSide): Point {
  switch (side) {
    case 'top':
      return { x: card.x + card.w / 2, y: card.y }
    case 'right':
      return { x: card.x + card.w, y: card.y + card.h / 2 }
    case 'bottom':
      return { x: card.x + card.w / 2, y: card.y + card.h }
    case 'left':
      return { x: card.x, y: card.y + card.h / 2 }
  }
}

/**
 * Picks the pair of sides an edge should anchor to when the file omits
 * `fromSide`/`toSide` (p1-design §1.1: "省略 = 按两卡相对位置自动选").
 * Compares the two cards' centers and anchors along whichever axis has the
 * larger separation — a card mostly to the right anchors right->left, one
 * mostly below anchors bottom->top, and so on.
 */
export function autoEdgeSides(
  from: VirtualCardRect,
  to: VirtualCardRect,
): Readonly<{ fromSide: CardSide; toSide: CardSide }> {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2)
  const dy = to.y + to.h / 2 - (from.y + from.h / 2)
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { fromSide: 'right', toSide: 'left' } : { fromSide: 'left', toSide: 'right' }
  }
  return dy >= 0 ? { fromSide: 'bottom', toSide: 'top' } : { fromSide: 'top', toSide: 'bottom' }
}

/** Resolves the actual sides to anchor at: an explicit `fromSide`/`toSide`
 * from the file wins per side; either one left `undefined` falls back to
 * `autoEdgeSides`'s pick for that side. */
export function resolveEdgeSides(
  from: VirtualCardRect,
  to: VirtualCardRect,
  fromSide?: CardSide,
  toSide?: CardSide,
): Readonly<{ fromSide: CardSide; toSide: CardSide }> {
  if (fromSide && toSide) return { fromSide, toSide }
  const auto = autoEdgeSides(from, to)
  return { fromSide: fromSide ?? auto.fromSide, toSide: toSide ?? auto.toSide }
}

function extrapolate(anchor: Point, side: CardSide, distance: number): Point {
  const normal = SIDE_NORMALS[side]
  const push = Math.min(distance * EDGE_CONTROL_FACTOR, EDGE_CONTROL_MAX_PX)
  return { x: anchor.x + normal.x * push, y: anchor.y + normal.y * push }
}

function cubicBezierPointAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const c = 3 * mt * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  }
}

/** Full geometry for one edge: anchor points, bezier control points, and the
 * curve's midpoint (label anchor). `fromSide`/`toSide` should already be
 * resolved (via `resolveEdgeSides`) — this function doesn't auto-pick. */
export function computeEdgeGeometry(
  from: VirtualCardRect,
  to: VirtualCardRect,
  fromSide: CardSide,
  toSide: CardSide,
): EdgeGeometry {
  const start = anchorPoint(from, fromSide)
  const end = anchorPoint(to, toSide)
  const distance = Math.hypot(end.x - start.x, end.y - start.y)
  const c1 = extrapolate(start, fromSide, distance)
  const c2 = extrapolate(end, toSide, distance)
  return { start, end, c1, c2, label: cubicBezierPointAt(start, c1, c2, end, 0.5) }
}

/** SVG path `d` attribute for the cubic bezier described by `geometry`. */
export function buildEdgePathD(geometry: EdgeGeometry): string {
  const { start, c1, c2, end } = geometry
  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`
}
