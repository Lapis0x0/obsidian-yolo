// Alignment for a drag or a resize: the correction that turns a gesture's raw
// world-space delta into one that lines the thing being moved up with its
// neighbours, or failing that with the grid. DOM-free like every other
// domain/ module (Module Boundaries, CLAUDE.md) — the canvas UI owns the
// pointer, the candidate set and the guide lines it draws from what comes
// back.
//
// Two mechanisms, in Obsidian Canvas's own order and for its own reasons
// (measured off 1.13.7's `getSnapping`):
//
//   1. Object alignment. Both rectangles' anchors — four corners and the
//      centre — are candidates, so edge-to-edge and centre-to-centre are the
//      same rule rather than two. It has a tolerance, because it is an offer:
//      nothing lines up unless something is already nearly lined up.
//   2. The grid, on whichever axis found no object to align to. No tolerance:
//      a free axis always lands on the lattice, so a board stays on its grid
//      without the user thinking about it.
//
// Decided per axis, not per gesture, which is what lets a card sit against
// its neighbour's left edge while its vertical position falls on the grid.
// An axis the gesture did not move is left alone entirely — a horizontal drag
// must not shuffle a card vertically onto the nearest grid line.

import { type ResizeHandle, resizeEdges } from './resize'
import type { CardRect } from './resize'

export type SnapPoint = Readonly<{ x: number; y: number }>

/**
 * One alignment worth drawing: a line at `position` on `axis` ('x' being a
 * vertical line), running from `from` to `to` along the other axis, with a
 * mark at each `marks` position on it. Everything is in world units, with the
 * snap correction already applied — this is what lined up, not what asked to.
 */
export type SnapGuide = Readonly<{
  axis: 'x' | 'y'
  position: number
  from: number
  to: number
  marks: readonly number[]
}>

/** A correction to add to the gesture's raw delta, and what to draw for it. */
export type SnapResult = Readonly<{
  dx: number
  dy: number
  guides: readonly SnapGuide[]
}>

export type SnapOptions = Readonly<{
  /** How far apart two anchors may be and still line up, in world units.
   * The caller derives it from a screen distance, so the offer is the same
   * size under the pointer at every zoom. */
  tolerance: number
  /** Lattice an axis with no object to align to falls onto. */
  gridStep: number
}>

const NO_SNAP: SnapResult = Object.freeze({ dx: 0, dy: 0, guides: [] })

/**
 * Two corrections this close together are the same correction.
 *
 * Two same-sized cards meeting line up on three coordinates at once — left,
 * centre and right — for one correction, but each pair computes that
 * correction as its own subtraction of world coordinates and the three
 * results differ in the last bits. Compared exactly, which of the three
 * counts as "the smallest" changes with every sub-pixel of pointer movement,
 * and the guides flicker between subsets of themselves. Far below a pixel at
 * any zoom, so nothing a user could aim at is merged by it.
 */
const SAME_CORRECTION = 1e-6

/** The four corners and the centre — the whole candidate set, for both the
 * thing being moved and the things it might line up with. */
function anchorsOf(rect: CardRect): readonly SnapPoint[] {
  const right = rect.x + rect.w
  const bottom = rect.y + rect.h
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x, y: bottom },
    { x: right, y: rect.y },
    { x: right, y: bottom },
    { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 },
  ]
}

/** One coordinate that lines up: the anchors that land on it and the ones
 * already there. */
type AxisGroup = Readonly<{
  position: number
  sources: SnapPoint[]
  targets: SnapPoint[]
}>

type AxisMatch = Readonly<{ delta: number; groups: readonly AxisGroup[] }>

/**
 * The smallest correction along `axis` that puts a source anchor on a target
 * anchor, or null when nothing is within `tolerance`.
 *
 * Everything that correction lines up is kept, not just the pair that found
 * it, and grouped by the coordinate it lines up *on*: two same-sized cards
 * meeting is one correction but three alignments (left, centre, right), and
 * three cards sharing a left edge is one alignment with three cards on it.
 * Each group is a line the caller can draw.
 *
 * A plain double loop. The candidate set is bounded by what is on screen and
 * the source set by what is being dragged, so this is a few hundred
 * comparisons per axis per pointer event; Obsidian sorts and binary-searches,
 * which buys nothing at that size.
 */
function alignAxis(
  sources: readonly SnapPoint[],
  targets: readonly SnapPoint[],
  tolerance: number,
  axis: 'x' | 'y',
): AxisMatch | null {
  let delta: number | null = null
  let groups = new Map<number, AxisGroup>()
  for (const source of sources) {
    for (const target of targets) {
      const candidate = target[axis] - source[axis]
      if (Math.abs(candidate) > tolerance) continue
      if (
        delta === null ||
        Math.abs(candidate) < Math.abs(delta) - SAME_CORRECTION
      ) {
        delta = candidate
        groups = new Map()
      } else if (Math.abs(candidate - delta) > SAME_CORRECTION) {
        // Beaten, or the same distance in the other direction — which lines
        // this pair up with nothing.
        continue
      }
      const position = target[axis]
      let group = groups.get(position)
      if (!group) {
        group = { position, sources: [], targets: [] }
        groups.set(position, group)
      }
      if (!group.sources.includes(source)) group.sources.push(source)
      if (!group.targets.includes(target)) group.targets.push(target)
    }
  }
  return delta === null ? null : { delta, groups: [...groups.values()] }
}

/** What it takes to put `value` on the lattice. */
function gridDelta(value: number, step: number): number {
  return step > 0 ? Math.round(value / step) * step - value : 0
}

function guidesFor(
  match: AxisMatch | null,
  axis: 'x' | 'y',
  dx: number,
  dy: number,
): SnapGuide[] {
  if (!match) return []
  const other = axis === 'x' ? 'y' : 'x'
  const shift = axis === 'x' ? dy : dx
  return match.groups.map((group) => {
    // The sources land on the group's coordinate once the correction is in,
    // which is what "they line up" means; only the *other* axis still needs
    // the correction applying to it.
    const marks = [
      ...group.sources.map((point) => point[other] + shift),
      ...group.targets.map((point) => point[other]),
    ]
    return {
      axis,
      position: group.position,
      from: Math.min(...marks),
      to: Math.max(...marks),
      marks,
    }
  })
}

function result(
  x: AxisMatch | null,
  y: AxisMatch | null,
  dx: number,
  dy: number,
): SnapResult {
  return {
    dx,
    dy,
    guides: [...guidesFor(x, 'x', dx, dy), ...guidesFor(y, 'y', dx, dy)],
  }
}

/**
 * Where a drag should actually land.
 *
 * `moving` is the dragged rectangles as the raw pointer delta leaves them,
 * `candidates` what they may line up with; the result is the correction on
 * top of that delta. `movedX`/`movedY` say which axes the gesture is
 * actually moving on.
 */
export function snapMove(
  moving: readonly CardRect[],
  candidates: readonly CardRect[],
  options: SnapOptions &
    Readonly<{
      movedX: boolean
      movedY: boolean
    }>,
): SnapResult {
  if (moving.length === 0) return NO_SNAP
  const sources = moving.flatMap(anchorsOf)
  const targets = candidates.flatMap(anchorsOf)
  const x = options.movedX
    ? alignAxis(sources, targets, options.tolerance, 'x')
    : null
  const y = options.movedY
    ? alignAxis(sources, targets, options.tolerance, 'y')
    : null
  // The grid is measured from the selection's top-left corner: one point for
  // however many cards are travelling together, so a multi-card drag keeps
  // its internal spacing instead of collapsing each card onto the lattice.
  const dx =
    x?.delta ??
    (options.movedX
      ? gridDelta(Math.min(...moving.map((rect) => rect.x)), options.gridStep)
      : 0)
  const dy =
    y?.delta ??
    (options.movedY
      ? gridDelta(Math.min(...moving.map((rect) => rect.y)), options.gridStep)
      : 0)
  return result(x, y, dx, dy)
}

/**
 * Where a resize should actually land: the same two mechanisms applied to the
 * edges the handle moves.
 *
 * Only those edges are offered, unlike a drag's five anchors per rectangle.
 * The opposite edge cannot move, so aligning *it* would mean dragging the
 * edge under the pointer somewhere it was not asked to go, and the centre
 * moves at half the speed of the edge, so aligning it would mean the same.
 * `rect` is the rectangle the raw pointer delta produces, and the correction
 * comes back in the delta's own terms — a resize moves its edge one-for-one
 * with the delta (domain/resize.ts's `resizeAxis`), so the caller adds this
 * to the delta exactly as a drag does.
 */
export function snapResize(
  rect: CardRect,
  handle: ResizeHandle,
  candidates: readonly CardRect[],
  options: SnapOptions,
): SnapResult {
  const edges = resizeEdges(handle)
  const targets = candidates.flatMap(anchorsOf)
  const right = rect.x + rect.w
  const bottom = rect.y + rect.h
  const movingX = edges.x === null ? null : edges.x === 'start' ? rect.x : right
  const movingY =
    edges.y === null ? null : edges.y === 'start' ? rect.y : bottom
  const x =
    movingX === null
      ? null
      : alignAxis(
          [
            { x: movingX, y: rect.y },
            { x: movingX, y: bottom },
          ],
          targets,
          options.tolerance,
          'x',
        )
  const y =
    movingY === null
      ? null
      : alignAxis(
          [
            { x: rect.x, y: movingY },
            { x: right, y: movingY },
          ],
          targets,
          options.tolerance,
          'y',
        )
  const dx =
    x?.delta ?? (movingX === null ? 0 : gridDelta(movingX, options.gridStep))
  const dy =
    y?.delta ?? (movingY === null ? 0 : gridDelta(movingY, options.gridStep))
  return result(x, y, dx, dy)
}
