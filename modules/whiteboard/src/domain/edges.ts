// Pure geometry for `.yoloboard` edge rendering: anchor-side auto-selection
// and cubic-bezier control-point construction for the single SVG overlay the
// canvas draws all edges into ("贝塞尔曲线...控制点沿锚定边法线方向外推
// （Hepta/Canvas 手感）"). Only imports from ./fileFormat and
// ./virtualization, both already dependency-free domain modules — the
// module-boundary check requires every domain/ import to stay inside domain/
// (scripts/check-whiteboard-module-boundary.test.mjs).
//
// Connection points are derived from board data (card x/y/w/h), never
// measured from the DOM: the canvas UI must be able to draw an edge whose
// endpoint card isn't currently mounted (virtualization) or is mid-drag
// (temporary coordinates the caller passes in), so this module only ever
// sees plain rectangles, never live elements.

import type {
  BoardNode,
  Edge,
  EdgeAnchor,
  EdgeEnd,
  EdgeId,
  NodeId,
  NodeSide,
} from './fileFormat'
import type { CardRect, CardSize } from './resize'
import type { VirtualCardRect } from './virtualization'

export type Point = Readonly<{ x: number; y: number }>

/** One end of an edge: a node and the side of it the edge meets. */
export type SideAnchor = Readonly<{ nodeId: NodeId; side: NodeSide }>

export const NODE_SIDES: readonly NodeSide[] = [
  'top',
  'right',
  'bottom',
  'left',
]

export type EdgeGeometry = Readonly<{
  start: Point
  end: Point
  c1: Point
  c2: Point
  /** Point at t=0.5 along the curve — where a label is anchored. */
  label: Point
  /** Where an end that reaches a passage in sight goes on to, inside its
   * card: the passage's own edge, level with `start` / `end`. The curve
   * stops at the card's edge; the rest is a straight run over the card. */
  startInner?: Point
  endInner?: Point
  /** Nothing to draw: an edge within one card neither of whose passages is
   * in sight (`resolveEdgeEnds`). */
  hidden?: true
}>

/** How far a control point is pushed out along its anchor side's outward
 * normal, as a fraction of the straight-line distance between the two
 * anchor points ("外推距离与两卡距离正相关"). */
export const EDGE_CONTROL_FACTOR = 0.5

/** Upper bound on that extrapolation distance ("设上限"), so two far-apart
 * cards don't get a control point that overshoots into unrelated territory. */
export const EDGE_CONTROL_MAX_PX = 160

/** Lower bound on the push when the two ends face each other across a
 * narrow gap: enough of a lead-in that the line still leaves and meets its
 * sides square, not at a corner. */
export const EDGE_CONTROL_MIN_PX = 24

const SIDE_NORMALS: Readonly<Record<NodeSide, Point>> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
}

const OPPOSITE_SIDES: Readonly<Record<NodeSide, NodeSide>> = {
  top: 'bottom',
  right: 'left',
  bottom: 'top',
  left: 'right',
}

/** The side facing back the way the given one points — the side a card
 * dropped in front of an anchor should present to it. */
export function oppositeSide(side: NodeSide): NodeSide {
  return OPPOSITE_SIDES[side]
}

/** Midpoint of the given side of a card rect, in world coordinates — the
 * edge's connection point. Computed from data, never measured from the DOM
 * (see file doc comment). */
export function anchorPoint(card: VirtualCardRect, side: NodeSide): Point {
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
 * `fromSide`/`toSide` ("省略 = 按两卡相对位置自动选").
 * Compares the two cards' centers and anchors along whichever axis has the
 * larger separation — a card mostly to the right anchors right->left, one
 * mostly below anchors bottom->top, and so on.
 */
export function autoEdgeSides(
  from: VirtualCardRect,
  to: VirtualCardRect,
): Readonly<{ fromSide: NodeSide; toSide: NodeSide }> {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2)
  const dy = to.y + to.h / 2 - (from.y + from.h / 2)
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { fromSide: 'right', toSide: 'left' }
      : { fromSide: 'left', toSide: 'right' }
  }
  return dy >= 0
    ? { fromSide: 'bottom', toSide: 'top' }
    : { fromSide: 'top', toSide: 'bottom' }
}

/** Resolves the actual sides to anchor at: an explicit `fromSide`/`toSide`
 * from the file wins per side; either one left `undefined` falls back to
 * `autoEdgeSides`'s pick for that side. */
export function resolveEdgeSides(
  from: VirtualCardRect,
  to: VirtualCardRect,
  fromSide?: NodeSide,
  toSide?: NodeSide,
): Readonly<{ fromSide: NodeSide; toSide: NodeSide }> {
  if (fromSide && toSide) return { fromSide, toSide }
  const auto = autoEdgeSides(from, to)
  return { fromSide: fromSide ?? auto.fromSide, toSide: toSide ?? auto.toSide }
}

// --- ends that reach a passage --------------------------------------------
//
// An end with an anchor (fileFormat.ts's `EdgeAnchor`) reaches a passage
// inside its card, and is drawn to it: the curve meets a side of the card
// facing the other end (`passageSide`) — level with the passage on a left or
// right side, above or below its middle on the top or bottom — and,
// while the passage is in sight, runs straight on over the card to the
// passage's own edge on that side. An end on one page of a PDF's card
// (`fromPage` / `toPage`) is drawn the same way, the page its passage.
// Where the passage is comes from whoever draws the card (a reader knows its
// scroll), as a `PassagePlacement`; this module only turns it into a point.

/** Where the passage an end reaches is, as its card shows it now: on screen
 * in a box (world units), or scrolled past the card's top or bottom edge. */
export type PassagePlacement =
  | Readonly<{
      state: 'visible'
      top: number
      bottom: number
      left: number
      right: number
    }>
  | Readonly<{ state: 'above' | 'below' }>

/** How far in from the card's top or bottom corner an end is held when its
 * passage is scrolled past that edge, in world units — near the edge it went
 * out of, clear of the corner. */
export const PASSAGE_EDGE_INSET = 12

/** An edge's two ends: the sides they leave from, and the point on a side
 * when it is not the middle. */
export type EdgeEnds = Readonly<{
  fromSide: NodeSide
  toSide: NodeSide
  start?: Point
  end?: Point
  /** See `EdgeGeometry`'s. */
  startInner?: Point
  endInner?: Point
  hidden?: true
}>

/**
 * Where an edge's ends are drawn. An end without an anchor or a page, or
 * whose passage cannot be placed right now (`null`: the card is not drawn, or
 * is drawn without its text), meets its side's middle as before
 * (`resolveEdgeSides`).
 */
export function resolveEdgeEnds(
  edge: Pick<
    Edge,
    'fromSide' | 'toSide' | 'fromAnchor' | 'toAnchor' | 'fromPage' | 'toPage'
  >,
  from: VirtualCardRect,
  to: VirtualCardRect,
  placements: Readonly<{
    from?: PassagePlacement | null
    to?: PassagePlacement | null
  }>,
): EdgeEnds {
  const sides = resolveEdgeSides(from, to, edge.fromSide, edge.toSide)
  const fromPlaced =
    edge.fromAnchor || edge.fromPage !== undefined ? placements.from : null
  const toPlaced =
    edge.toAnchor || edge.toPage !== undefined ? placements.to : null
  if (from.id === to.id) return withinCardEnds(from, fromPlaced, toPlaced)
  if (!fromPlaced && !toPlaced) return sides
  const fromSide = fromPlaced
    ? passageSide(from, to, fromPlaced)
    : sides.fromSide
  const toSide = toPlaced ? passageSide(to, from, toPlaced) : sides.toSide
  const start = fromPlaced && passagePoint(from, fromSide, fromPlaced)
  const end = toPlaced && passagePoint(to, toSide, toPlaced)
  return {
    fromSide,
    toSide,
    ...(start ? { start: start.edge } : {}),
    ...(start && start.inner ? { startInner: start.inner } : {}),
    ...(end ? { end: end.edge } : {}),
    ...(end && end.inner ? { endInner: end.inner } : {}),
  }
}

/**
 * The side an end reaching a passage leaves `card` by, towards `other`: the
 * left or right one facing it — the run over the card to the passage then
 * crosses only the margin beside it. The top or bottom one only where the
 * other end is mostly above or below and the run from that side is the
 * shorter: a passage by the card's top or bottom edge, not one a vertical
 * run would reach through every line between.
 */
function passageSide(
  card: VirtualCardRect,
  other: VirtualCardRect,
  placement: PassagePlacement,
): NodeSide {
  const dx = other.x + other.w / 2 - (card.x + card.w / 2)
  const dy = other.y + other.h / 2 - (card.y + card.h / 2)
  const across: NodeSide = dx >= 0 ? 'right' : 'left'
  if (Math.abs(dx) >= Math.abs(dy)) return across
  const along: NodeSide = dy >= 0 ? 'bottom' : 'top'
  if (placement.state !== 'visible') return along
  const acrossRun =
    across === 'right'
      ? card.x + card.w - placement.right
      : placement.left - card.x
  const alongRun =
    along === 'bottom'
      ? card.y + card.h - placement.bottom
      : placement.top - card.y
  return alongRun < acrossRun ? along : across
}

/**
 * An edge between two passages of one card — two pages of a PDF linked
 * while it was spread out, now folded back into one reader. Both ends leave
 * by the card's right side, the curve a bracket out in its margin from one
 * passage to the other. A passage scrolled out of sight is held near the
 * corner it went past, as any end's is; with neither in sight there is
 * nothing in the card to point at, and nothing is drawn — nor when the card
 * cannot place them at all.
 */
function withinCardEnds(
  card: VirtualCardRect,
  fromPlaced: PassagePlacement | null | undefined,
  toPlaced: PassagePlacement | null | undefined,
): EdgeEnds {
  const side: NodeSide = 'right'
  if (
    !fromPlaced ||
    !toPlaced ||
    (fromPlaced.state !== 'visible' && toPlaced.state !== 'visible')
  ) {
    return { fromSide: side, toSide: side, hidden: true }
  }
  const start = passagePoint(card, side, fromPlaced)
  const end = passagePoint(card, side, toPlaced)
  return {
    fromSide: side,
    toSide: side,
    start: start.edge,
    end: end.edge,
    ...(start.inner ? { startInner: start.inner } : {}),
    ...(end.inner ? { endInner: end.inner } : {}),
  }
}

/** Where an end meets its card's edge, and, for a passage in sight, the
 * passage's edge it runs on to. */
function passagePoint(
  card: VirtualCardRect,
  side: NodeSide,
  placement: PassagePlacement,
): Readonly<{ edge: Point; inner?: Point }> {
  if (side === 'top' || side === 'bottom') {
    const y = side === 'bottom' ? card.y + card.h : card.y
    if (placement.state !== 'visible') {
      return { edge: { x: card.x + card.w / 2, y } }
    }
    const inset = Math.min(PASSAGE_EDGE_INSET, card.w / 2)
    const center = (placement.left + placement.right) / 2
    const x = Math.min(
      card.x + card.w - inset,
      Math.max(card.x + inset, center),
    )
    const reach = side === 'bottom' ? placement.bottom : placement.top
    const inner = Math.min(card.y + card.h, Math.max(card.y, reach))
    return { edge: { x, y }, inner: { x, y: inner } }
  }
  const x = side === 'right' ? card.x + card.w : card.x
  const inset = Math.min(PASSAGE_EDGE_INSET, card.h / 2)
  const top = card.y + inset
  const bottom = card.y + card.h - inset
  if (placement.state !== 'visible') {
    return { edge: { x, y: placement.state === 'above' ? top : bottom } }
  }
  const middle = (placement.top + placement.bottom) / 2
  const y = Math.min(bottom, Math.max(top, middle))
  const reach = side === 'right' ? placement.right : placement.left
  const inner = Math.min(card.x + card.w, Math.max(card.x, reach))
  return { edge: { x, y }, inner: { x: inner, y } }
}

/**
 * How far both control points are pushed out: with the distance between the
 * ends, up to `EDGE_CONTROL_MAX_PX`. But two ends facing each other — one
 * leaving to the right, the other entering from the left, and so on — are
 * pushed only with the gap between them along that direction: pushed with
 * the whole distance, two ends far apart down a narrow gap (passages high
 * and low in two cards side by side) would each be pushed past the other's
 * side, and the curve swings out and back in an S where a straight run
 * across the gap was meant.
 */
function controlPush(
  start: Point,
  end: Point,
  fromSide: NodeSide,
  toSide: NodeSide,
): number {
  const distance = Math.hypot(end.x - start.x, end.y - start.y)
  const push = Math.min(distance * EDGE_CONTROL_FACTOR, EDGE_CONTROL_MAX_PX)
  if (toSide !== OPPOSITE_SIDES[fromSide]) return push
  const normal = SIDE_NORMALS[fromSide]
  const gap = (end.x - start.x) * normal.x + (end.y - start.y) * normal.y
  if (gap <= 0) return push
  return Math.min(
    push,
    Math.max(gap * EDGE_CONTROL_FACTOR, EDGE_CONTROL_MIN_PX),
  )
}

/**
 * Whether an end leaves its side across the way to the other end rather
 * than along it — out of a left or right side towards something mostly
 * above or below. An end that reaches a passage does that by design
 * (`passageSide`), into what is often a narrow gap: two pages side by side.
 * Pushed out as far as the distance asks, it would cross the gap and the
 * card beyond before turning; it turns at once instead.
 */
function leavesSideways(at: Point, other: Point, side: NodeSide): boolean {
  const normal = SIDE_NORMALS[side]
  const dx = other.x - at.x
  const dy = other.y - at.y
  const along = dx * normal.x + dy * normal.y
  const across = Math.abs(dx * normal.y - dy * normal.x)
  return Math.abs(along) < across
}

function extrapolate(anchor: Point, side: NodeSide, push: number): Point {
  const normal = SIDE_NORMALS[side]
  return { x: anchor.x + normal.x * push, y: anchor.y + normal.y * push }
}

function cubicBezierPointAt(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  t: number,
): Point {
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
 * resolved (via `resolveEdgeSides`, or `resolveEdgeEnds` for an edge that may
 * reach a passage) — this function doesn't auto-pick. `points` puts an end
 * somewhere on its side other than the middle (`resolveEdgeEnds`). */
export function computeEdgeGeometry(
  from: VirtualCardRect,
  to: VirtualCardRect,
  fromSide: NodeSide,
  toSide: NodeSide,
  points?: Readonly<{
    start?: Point
    end?: Point
    startInner?: Point
    endInner?: Point
    hidden?: true
  }>,
): EdgeGeometry {
  const start = points?.start ?? anchorPoint(from, fromSide)
  const end = points?.end ?? anchorPoint(to, toSide)
  const push = controlPush(start, end, fromSide, toSide)
  const c1 = extrapolate(
    start,
    fromSide,
    points?.startInner && leavesSideways(start, end, fromSide)
      ? EDGE_CONTROL_MIN_PX
      : push,
  )
  const c2 = extrapolate(
    end,
    toSide,
    points?.endInner && leavesSideways(end, start, toSide)
      ? EDGE_CONTROL_MIN_PX
      : push,
  )
  return {
    start,
    end,
    c1,
    c2,
    label: cubicBezierPointAt(start, c1, c2, end, 0.5),
    ...(points?.startInner ? { startInner: points.startInner } : {}),
    ...(points?.endInner ? { endInner: points.endInner } : {}),
    ...(points?.hidden ? { hidden: true } : {}),
  }
}

// --- hit testing ----------------------------------------------------------
//
// Asking which edge a point is on, from the geometry rather than from the DOM.
// The DOM tiers do not need this — every edge carries a fat transparent stroke
// under it and the browser answers — but the overview tier has no edge
// elements at all: the canvas draws them, and a canvas is not a pointer target
// (ui/canvas/overviewLayer.ts). Selecting an edge is promised at every zoom,
// so down there the same question is answered here instead.

/** How many segments the curve is measured as. Twenty is well past the point
 * where the polyline and the curve differ by anything a pointer can express:
 * an edge is a few hundred world units long, so the chords are tens of units
 * where the tolerance itself is tens of units. */
export const EDGE_HIT_SAMPLES = 20

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y)
  const t = Math.max(
    0,
    Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq),
  )
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}

/**
 * Shortest distance from `point` to an edge's curve, measured against the
 * polyline through `EDGE_HIT_SAMPLES` samples of it — a cubic has no closed
 * form for this, and sampling is what every hit test on one does.
 *
 * Space-agnostic: feed it world coordinates and a world tolerance, or screen
 * coordinates and a screen one. The caller picks (canvas.ts works in world
 * space, where the geometry already is, and divides its screen tolerance by
 * the camera scale).
 */
export function distanceToEdgeCurve(
  geometry: EdgeGeometry,
  point: Point,
): number {
  const { start, c1, c2, end } = geometry
  let previous = start
  let best = Infinity
  for (let index = 1; index <= EDGE_HIT_SAMPLES; index += 1) {
    const next =
      index === EDGE_HIT_SAMPLES
        ? end
        : cubicBezierPointAt(start, c1, c2, end, index / EDGE_HIT_SAMPLES)
    best = Math.min(best, distanceToSegment(point, previous, next))
    previous = next
  }
  return best
}

/**
 * The edge running closest to `point`, or null when none runs within
 * `tolerance` of it.
 *
 * Nearest rather than topmost, unlike `nodeAtPoint`: cards are opaque and
 * stack, so which one you clicked is which one you can see; lines cross, and
 * the one you meant is the one you aimed at. Scanned backwards so an exact tie
 * still goes to the edge drawn last.
 *
 * The bounding box of the two endpoint cards grown by `EDGE_CONTROL_MAX_PX`
 * contains the whole curve (see edgeLayer's `edgeIsVisible` for why), so a
 * point outside it plus the tolerance cannot be on the edge — four comparisons
 * to skip the sampling, which on a board of a few thousand edges is what makes
 * this a linear scan worth doing at all.
 */
export function edgeAtPoint(
  edges: readonly Edge[],
  nodes: ReadonlyMap<NodeId, VirtualCardRect>,
  point: Point,
  tolerance: number,
): EdgeId | null {
  let best: EdgeId | null = null
  let bestDistance = Infinity
  const margin = EDGE_CONTROL_MAX_PX + tolerance
  for (let index = edges.length - 1; index >= 0; index -= 1) {
    const edge = edges[index]
    // Within one card it is drawn only where the card places its passages,
    // which the board alone cannot (`resolveEdgeEnds`).
    if (edge.fromNode === edge.toNode) continue
    const from = nodes.get(edge.fromNode)
    const to = nodes.get(edge.toNode)
    if (!from || !to) continue
    if (
      point.x < Math.min(from.x, to.x) - margin ||
      point.x > Math.max(from.x + from.w, to.x + to.w) + margin ||
      point.y < Math.min(from.y, to.y) - margin ||
      point.y > Math.max(from.y + from.h, to.y + to.h) + margin
    ) {
      continue
    }
    const sides = resolveEdgeSides(from, to, edge.fromSide, edge.toSide)
    const distance = distanceToEdgeCurve(
      computeEdgeGeometry(from, to, sides.fromSide, sides.toSide),
      point,
    )
    if (distance > tolerance || distance >= bestDistance) continue
    bestDistance = distance
    best = edge.id
  }
  return best
}

/**
 * Where a connection drag would land if it ended at `point`: the nearest
 * connection point of any card the pointer is inside of (or within `snapPx`
 * of), or null when it is over open canvas.
 *
 * Two stages, both from Obsidian Canvas's own rule: a card only becomes a
 * candidate once the pointer is inside its rect grown by `snapPx` — so a
 * drag passing near a card does not get yanked into it — and the side is then
 * whichever of the four connection points is closest, which is why dropping
 * on the far half of a wide card still anchors to the near edge.
 *
 * `cards` is the candidate set the caller has already excluded the drag's
 * fixed end from: an edge with both ends on one card is not a connection.
 */
export function findConnectTarget(
  point: Point,
  cards: readonly VirtualCardRect[],
  snapPx: number,
): SideAnchor | null {
  let best: SideAnchor | null = null
  let bestDistance = Infinity
  for (const card of cards) {
    if (
      point.x < card.x - snapPx ||
      point.x > card.x + card.w + snapPx ||
      point.y < card.y - snapPx ||
      point.y > card.y + card.h + snapPx
    ) {
      continue
    }
    for (const side of NODE_SIDES) {
      const anchor = anchorPoint(card, side)
      const distance = Math.hypot(anchor.x - point.x, anchor.y - point.y)
      if (distance >= bestDistance) continue
      bestDistance = distance
      best = { nodeId: card.id, side }
    }
  }
  return best
}

/**
 * The edge a finished connection drag creates: `anchor` is the end that
 * stayed put and `target` is where the dragged end landed; `movingEnd` says
 * which of the two the drag was moving (canvas.ts's `ConnectInteraction`),
 * so anchor/target resolve to `from`/`to` accordingly. `id` is the caller's
 * to generate — canvas.ts's `nextEdgeId` is `crypto`-backed, out of reach for
 * this dependency-free module.
 */
export function buildEdge(
  id: EdgeId,
  anchor: SideAnchor,
  movingEnd: 'from' | 'to',
  target: SideAnchor,
): Edge {
  const from = movingEnd === 'to' ? anchor : target
  const to = movingEnd === 'to' ? target : anchor
  return {
    id,
    fromNode: from.nodeId,
    toNode: to.nodeId,
    fromSide: from.side,
    toSide: to.side,
    // JSON Canvas's defaults: the arrow is at the end you pulled towards.
    fromEnd: 'none',
    toEnd: 'arrow',
    extra: {},
  }
}

/**
 * `edge` with one end reaching `anchor` inside its node, or — with
 * `undefined` — the whole node again. A passage of a PDF's card also names
 * its page (`fromPage`/`toPage`), so the end lands on that page's sheet when
 * the document is spread out; a sheet is already the page. Letting go of a
 * passage keeps the page: the end stays with the page it was on.
 */
export function anchorEdgeEnd(
  edge: Edge,
  end: 'from' | 'to',
  anchor: EdgeAnchor | undefined,
  nodeType: BoardNode['type'] | undefined,
): Edge {
  const page =
    anchor?.kind === 'pdf' && nodeType === 'file' ? anchor.page : undefined
  if (end === 'from') {
    return {
      ...edge,
      fromAnchor: anchor,
      ...(page === undefined ? {} : { fromPage: page }),
    }
  }
  return {
    ...edge,
    toAnchor: anchor,
    ...(page === undefined ? {} : { toPage: page }),
  }
}

/**
 * The rect for a card of `size` placed so that its `side` connection point
 * sits exactly on `point` — where a card created by dropping a connection on
 * open canvas goes, so the new card meets the incoming edge head-on instead
 * of being centered on the drop and pierced by it.
 */
export function rectAnchoredAt(
  point: Point,
  side: NodeSide,
  size: CardSize,
): CardRect {
  switch (side) {
    case 'top':
      return { x: point.x - size.w / 2, y: point.y, ...size }
    case 'bottom':
      return { x: point.x - size.w / 2, y: point.y - size.h, ...size }
    case 'left':
      return { x: point.x, y: point.y - size.h / 2, ...size }
    case 'right':
      return { x: point.x - size.w, y: point.y - size.h / 2, ...size }
  }
}

// --- arrowheads -----------------------------------------------------------
//
// JSON Canvas models an edge's arrowheads as two independent fields,
// `fromEnd`/`toEnd`, each 'none' or 'arrow'. What a user picks from is not two
// independent switches but one question — which way does this point — so the
// edge toolbar offers the four combinations by name. This is the translation
// between the two, kept here rather than in the toolbar so the mapping (and in
// particular that JSON Canvas's default, no arrow at the source and an arrow
// at the target, *is* one of the four) is covered by a test.

export type ArrowDirection = 'none' | 'forward' | 'backward' | 'both'

export const ARROW_DIRECTIONS: readonly ArrowDirection[] = [
  'none',
  'forward',
  'backward',
  'both',
]

/** The `fromEnd`/`toEnd` pair a direction writes. */
export function arrowEnds(
  direction: ArrowDirection,
): Readonly<{ fromEnd: EdgeEnd; toEnd: EdgeEnd }> {
  return {
    fromEnd:
      direction === 'backward' || direction === 'both' ? 'arrow' : 'none',
    toEnd: direction === 'forward' || direction === 'both' ? 'arrow' : 'none',
  }
}

/** Which direction an edge is currently in — the option the menu ticks. */
export function arrowDirection(
  fromEnd: EdgeEnd,
  toEnd: EdgeEnd,
): ArrowDirection {
  if (fromEnd === 'arrow') return toEnd === 'arrow' ? 'both' : 'backward'
  return toEnd === 'arrow' ? 'forward' : 'none'
}

/** SVG path `d` attribute for the cubic bezier described by `geometry`. */
export function buildEdgePathD(geometry: EdgeGeometry): string {
  const { start, c1, c2, end } = geometry
  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`
}
