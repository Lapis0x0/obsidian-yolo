// "Tidy up": the one-click cleanup behind the selection toolbar's own button —
// pure geometry, no DOM and no Board, like ./arrange.ts beside it.
//
// Unlike align and distribute this is not Obsidian Canvas's operation; it is
// ours, and it exists because the eight geometric commands never answer the
// thing a user actually wants ("make this look tidy") — each one moves a
// single axis and leaves the other axis' mess untouched, so the user has to
// translate their intent into two or three operations and get the order right.
//
// The whole design rests on one restraint: **a card's position on a board
// carries meaning** (left is the cause, right is the effect; above is the
// claim, below is the evidence). The user never says so out loud, so any
// operation that re-decides which card goes where is gambling with something
// it cannot see. Tidy therefore does exactly two things — closes the gaps to
// one even value, and lines up the edges — and is forbidden the rest:
//
//   - it never changes the order (which card is left of which, above which),
//   - it never changes a card's size,
//   - it never moves a card into or out of a row it was not already in.
//
// So the worst it can do is fail to help. It cannot destroy a layout, which is
// what makes it safe to put under a single click with no preview.
//
// Rows, not modes. There is no "is this a row, a column or a grid?" decision —
// that would have a boundary, and a boundary a user cannot predict is exactly
// what makes a smart feature feel hostile. Instead there is one rule, and the
// three shapes fall out of it as special cases (a column is rows of one; a row
// is a single row; a grid is neither):
//
//   Scanning from the top down, a card belongs to the current row when it
//   vertically overlaps that row's *first* card.
//
// Against the row's first card, not against the row so far: "overlaps anything
// already in the row" chains — A overlaps B, B overlaps C, A and C do not
// touch at all, and a diagonal drift of cards collapses into one long row.
// That is re-deciding the layout, which is the line this module does not
// cross.

import { type ArrangePoint, type ArrangeRect, boundsOf } from './arrange'

/**
 * Where every rect lands once the selection is tidied.
 *
 * Total over the input, like ./arrange.ts's operations — the caller drops the
 * no-ops, because `setNodePositions` returns the same board when nothing
 * actually moved and an idle tidy should record no history step.
 *
 * `gridStep` is the lattice gaps are rounded to (the caller's
 * `GRID_WORLD_STEP_PX`), and doubles as the smallest gap this will leave: a
 * pile of cards dropped on top of each other has negative gaps, and spreading
 * it out until each card is visible is the one case where "close the gaps"
 * means opening them.
 */
export function tidyRects(
  rects: readonly ArrangeRect[],
  gridStep: number,
): Map<string, ArrangePoint> {
  const positions = new Map<string, ArrangePoint>()
  for (const rect of rects) positions.set(rect.id, { x: rect.x, y: rect.y })
  const bounds = boundsOf(rects)
  if (!bounds || rects.length < 2) return positions

  const rows = rowsOf(rects)
  const columnGap = snapGap(medianOf(columnGaps(rows)), gridStep)
  const rowGap = snapGap(medianOf(rowGaps(rows)), gridStep)

  let top = bounds.minY
  for (const row of rows) {
    let left = bounds.minX
    let tallest = 0
    for (const rect of row) {
      positions.set(rect.id, { x: left, y: top })
      left += rect.w + columnGap
      tallest = Math.max(tallest, rect.h)
    }
    top += tallest + rowGap
  }
  return positions
}

/**
 * The selection split into rows, top to bottom, each row ordered left to
 * right — the layout the user already sees, read back as structure. Both
 * orders come from the current coordinates, which is what guarantees the
 * result preserves them.
 */
function rowsOf(rects: readonly ArrangeRect[]): ArrangeRect[][] {
  const ordered = rects.slice().sort((a, b) => a.y - b.y || a.x - b.x)
  const rows: ArrangeRect[][] = []
  let head: ArrangeRect | undefined
  for (const rect of ordered) {
    if (head && overlapsVertically(head, rect)) {
      rows[rows.length - 1].push(rect)
      continue
    }
    rows.push([rect])
    head = rect
  }
  for (const row of rows) row.sort((a, b) => a.x - b.x || a.y - b.y)
  return rows
}

function overlapsVertically(a: ArrangeRect, b: ArrangeRect): boolean {
  return a.y < b.y + b.h && b.y < a.y + a.h
}

/** Every gap between neighbours within a row, in world units and possibly
 * negative where cards overlap. Pooled across all rows rather than measured
 * per row, so one loose row cannot end up spaced differently from a tight
 * one — the point is a single even value for the whole selection. */
function columnGaps(rows: readonly (readonly ArrangeRect[])[]): number[] {
  const gaps: number[] = []
  for (const row of rows) {
    for (let index = 1; index < row.length; index += 1) {
      const previous = row[index - 1]
      gaps.push(row[index].x - (previous.x + previous.w))
    }
  }
  return gaps
}

/** Every gap between one row's lowest edge and the next row's highest. */
function rowGaps(rows: readonly (readonly ArrangeRect[])[]): number[] {
  const gaps: number[] = []
  for (let index = 1; index < rows.length; index += 1) {
    const above = rows[index - 1]
    const below = rows[index]
    const bottom = Math.max(...above.map((rect) => rect.y + rect.h))
    const topOfNext = Math.min(...below.map((rect) => rect.y))
    gaps.push(topOfNext - bottom)
  }
  return gaps
}

/**
 * The middle gap, not the average one: a single card parked far off to the
 * side would drag an average out and space the whole selection around an
 * accident. Empty (a pure column has no gaps between columns, a single row
 * none between rows) yields null, and `snapGap` turns that into one cell.
 */
function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = values.slice().sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

/** The gap the layout will actually use: on the lattice, and never below one
 * cell — a gap of zero would leave cards touching, and a negative one (which
 * is what a pile of overlapping cards measures) would keep them hidden behind
 * each other. */
function snapGap(gap: number | null, gridStep: number): number {
  if (gap === null) return gridStep
  return Math.max(gridStep, Math.round(gap / gridStep) * gridStep)
}
