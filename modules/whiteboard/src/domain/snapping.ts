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
//      nothing lines up unless something is already nearly lined up. Only
//      like lines up with like — an edge with an edge, a centre with a
//      centre: an edge on another card's centre is a coincidence nobody
//      aims for, and on a board of cards there is always one within reach,
//      so offering it kept a drag caught on lines that meant nothing.
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
  /** Where that lattice's lines start from: the origin of the board being
   * worked in, which behind a portal is not this board's (domain/portals.ts).
   * The board's own origin when left out. */
  gridOrigin?: Readonly<{ x: number; y: number }>
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

/** Which of its rectangle's lines an anchor is on, along one axis: its
 * near edge, its centre, its far edge. */
type Line = 'start' | 'mid' | 'end'

/** A point that may line up, and which line of its rectangle it is on along
 * each axis. */
type Anchor = SnapPoint & Readonly<{ lineX: Line; lineY: Line }>

/** Whether anchors on these two lines may line up: an edge with an edge —
 * the same one, or the two meeting side by side — and a centre with a
 * centre. */
function alike(a: Line, b: Line): boolean {
  return (a === 'mid') === (b === 'mid')
}

/** The four corners and the centre — the whole candidate set, for both the
 * thing being moved and the things it might line up with. */
function anchorsOf(rect: CardRect): readonly Anchor[] {
  const right = rect.x + rect.w
  const bottom = rect.y + rect.h
  return [
    { x: rect.x, y: rect.y, lineX: 'start', lineY: 'start' },
    { x: rect.x, y: bottom, lineX: 'start', lineY: 'end' },
    { x: right, y: rect.y, lineX: 'end', lineY: 'start' },
    { x: right, y: bottom, lineX: 'end', lineY: 'end' },
    {
      x: rect.x + rect.w / 2,
      y: rect.y + rect.h / 2,
      lineX: 'mid',
      lineY: 'mid',
    },
  ]
}

/** One coordinate that lines up: the anchors that land on it and the ones
 * already there. */
type AxisGroup = Readonly<{
  position: number
  sources: Anchor[]
  targets: Anchor[]
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
  sources: readonly Anchor[],
  targets: readonly Anchor[],
  tolerance: number,
  axis: 'x' | 'y',
): AxisMatch | null {
  const line = axis === 'x' ? 'lineX' : 'lineY'
  let delta: number | null = null
  let groups = new Map<number, AxisGroup>()
  for (const source of sources) {
    for (const target of targets) {
      if (!alike(source[line], target[line])) continue
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
function gridDelta(
  value: number,
  { gridStep: step, gridOrigin }: SnapOptions,
  axis: 'x' | 'y',
): number {
  if (!(step > 0)) return 0
  const origin = gridOrigin?.[axis] ?? 0
  return Math.round((value - origin) / step) * step + origin - value
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
  const block = boundsOf(moving)
  const x = options.movedX
    ? alignAxis(sources, targets, options.tolerance, 'x')
    : null
  const y = options.movedY
    ? alignAxis(sources, targets, options.tolerance, 'y')
    : null
  const spaceX = options.movedX
    ? spaceAxis(block, candidates, options.tolerance, 'x')
    : null
  const spaceY = options.movedY
    ? spaceAxis(block, candidates, options.tolerance, 'y')
    : null
  const pickX = nearer(x, spaceX)
  const pickY = nearer(y, spaceY)
  // The grid is measured from the selection's top-left corner: one point for
  // however many cards are travelling together, so a multi-card drag keeps
  // its internal spacing instead of collapsing each card onto the lattice.
  const dx =
    pickX?.delta ?? (options.movedX ? gridDelta(block.x, options, 'x') : 0)
  const dy =
    pickY?.delta ?? (options.movedY ? gridDelta(block.y, options, 'y') : 0)
  return {
    dx,
    dy,
    guides: [
      ...guidesFor(pickX?.align ? x : null, 'x', dx, dy),
      ...guidesFor(pickY?.align ? y : null, 'y', dx, dy),
      ...(pickX?.space ? (spaceX?.guides(dx, dy) ?? []) : []),
      ...(pickY?.space ? (spaceY?.guides(dx, dy) ?? []) : []),
    ],
  }
}

/** The rectangle `rects` cover together. */
function boundsOf(rects: readonly CardRect[]): CardRect {
  const x = Math.min(...rects.map((rect) => rect.x))
  const y = Math.min(...rects.map((rect) => rect.y))
  return {
    x,
    y,
    w: Math.max(...rects.map((rect) => rect.x + rect.w)) - x,
    h: Math.max(...rects.map((rect) => rect.y + rect.h)) - y,
  }
}

/** Which of an axis's two offers wins — the smaller correction — and,
 * offering the same, both. */
function nearer(
  align: AxisMatch | null,
  space: Spacing | null,
): Readonly<{ delta: number; align: boolean; space: boolean }> | null {
  if (!align && !space) return null
  if (!space) return { delta: align?.delta ?? 0, align: true, space: false }
  if (!align) return { delta: space.delta, align: false, space: true }
  if (Math.abs(align.delta - space.delta) <= SAME_CORRECTION) {
    return { delta: align.delta, align: true, space: true }
  }
  return Math.abs(align.delta) < Math.abs(space.delta)
    ? { delta: align.delta, align: true, space: false }
    : { delta: space.delta, align: false, space: true }
}

/** An even spacing on offer (`spaceAxis`): the correction, and the gaps it
 * makes equal, drawn once the corrections on both axes are known. */
type Spacing = Readonly<{
  delta: number
  guides: (dx: number, dy: number) => SnapGuide[]
}>

/**
 * The smallest correction along `axis` that puts the moving block as far
 * from a neighbour in line with it — in its column for `y`, its row for `x`
 * — as two neighbours in that line already are from each other, or null
 * when no such spacing is within `tolerance`. A card added below a column is
 * set the column's own distance below the last card in it, which alignment
 * alone cannot say: it lines up edges, not the gaps between them.
 *
 * Only a neighbour with nothing in between counts, and only gaps between
 * neighbours: a spacing is a distance between two things side by side.
 */
function spaceAxis(
  block: CardRect,
  candidates: readonly CardRect[],
  tolerance: number,
  axis: 'x' | 'y',
): Spacing | null {
  const size = axis === 'x' ? 'w' : 'h'
  const across = axis === 'x' ? 'y' : 'x'
  const acrossSize = axis === 'x' ? 'h' : 'w'
  const end = (rect: CardRect) => rect[axis] + rect[size]
  const inLine = (a: CardRect, b: CardRect) =>
    a[across] < b[across] + b[acrossSize] &&
    a[across] + a[acrossSize] > b[across]
  const line = candidates
    .filter((rect) => inLine(rect, block))
    .sort((a, b) => a[axis] - b[axis])
  const clear = (from: number, to: number, except: CardRect) =>
    !line.some((rect) => rect !== except && rect[axis] < to && end(rect) > from)
  const pairs: { a: CardRect; b: CardRect; gap: number }[] = []
  for (let i = 0; i + 1 < line.length; i += 1) {
    const a = line[i]
    const b = line[i + 1]
    const gap = b[axis] - end(a)
    if (gap > 0 && clear(end(a), b[axis], a)) pairs.push({ a, b, gap })
  }
  let best: {
    delta: number
    gap: number
    beside: CardRect
    after: boolean
  } | null = null
  for (const beside of line) {
    for (const { gap } of pairs) {
      for (const after of [true, false]) {
        const delta = after
          ? end(beside) + gap - block[axis]
          : beside[axis] - gap - end(block)
        if (Math.abs(delta) > tolerance) continue
        if (best && Math.abs(delta) >= Math.abs(best.delta) - SAME_CORRECTION)
          continue
        const from = after ? end(beside) : beside[axis] - gap
        if (!clear(from, from + gap, beside)) continue
        best = { delta, gap, beside, after }
      }
    }
  }
  if (!best) return null
  const { delta, gap, beside, after } = best
  return {
    delta,
    guides: (dx, dy) => {
      const shift = { x: dx, y: dy }
      const placed: CardRect = {
        ...block,
        x: block.x + shift.x,
        y: block.y + shift.y,
      }
      const spans = [
        ...pairs
          .filter((pair) => Math.abs(pair.gap - gap) <= SAME_CORRECTION)
          .map((pair) => ({ a: pair.a, b: pair.b })),
        after ? { a: beside, b: placed } : { a: placed, b: beside },
      ]
      // A line across each equal gap, through the middle of what the two
      // sides of it share: a vertical line for a gap in a column.
      return spans.map(({ a, b }) => {
        const low = Math.max(a[across], b[across])
        const high = Math.min(
          a[across] + a[acrossSize],
          b[across] + b[acrossSize],
        )
        return {
          axis: across,
          position: (low + high) / 2,
          from: end(a),
          to: b[axis],
          marks: [end(a), b[axis]],
        }
      })
    },
  }
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
    movingX === null || edges.x === null
      ? null
      : alignAxis(
          [
            { x: movingX, y: rect.y, lineX: edges.x, lineY: 'start' },
            { x: movingX, y: bottom, lineX: edges.x, lineY: 'end' },
          ],
          targets,
          options.tolerance,
          'x',
        )
  const y =
    movingY === null || edges.y === null
      ? null
      : alignAxis(
          [
            { x: rect.x, y: movingY, lineX: 'start', lineY: edges.y },
            { x: right, y: movingY, lineX: 'end', lineY: edges.y },
          ],
          targets,
          options.tolerance,
          'y',
        )
  const dx =
    x?.delta ?? (movingX === null ? 0 : gridDelta(movingX, options, 'x'))
  const dy =
    y?.delta ?? (movingY === null ? 0 : gridDelta(movingY, options, 'y'))
  return result(x, y, dx, dy)
}
