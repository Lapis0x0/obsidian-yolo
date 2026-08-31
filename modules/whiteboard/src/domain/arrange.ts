// Alignment and even distribution for a multi-node selection (P3 batch 3
// wave B, feature 5) — pure geometry, no DOM and no Board (Module Boundaries,
// CLAUDE.md: domain/ stays dependency-free). ui/canvas.ts turns the returned
// positions into one `setNodePositions` call, i.e. one undo step per action.
//
// Both operations are Obsidian Canvas's own, read off its running
// `menu.render` closure (1.13.7) rather than reinvented — a board that arrives
// by `.canvas` import should rearrange the way its author expects:
//
//   - align moves each node to an edge (or centre line) of the selection's
//     bounding box, on one axis only, leaving the other axis alone;
//   - distribute keeps the two outermost nodes where they are and spreads the
//     rest so the *gaps* between neighbours are equal — equal spacing, not
//     equal centre-to-centre pitch, which is what makes a row of differently
//     sized cards read as evenly placed.
//
// Canvas's "arrange horizontally/vertically/as grid" and "justify" are
// deliberately not here: those reflow or resize a selection rather than align
// it, and are a different feature from the one this wave was asked for.

export type ArrangeRect = Readonly<{
  id: string
  x: number
  y: number
  w: number
  h: number
}>

export type ArrangePoint = Readonly<{ x: number; y: number }>

/** Where the selection's bounding box a node is pulled to. `center` is the
 * horizontal centre line, `middle` the vertical one — Canvas's own naming, and
 * the reason the six are one list rather than an edge plus an axis. */
export type AlignEdge =
  | 'left'
  | 'center'
  | 'right'
  | 'top'
  | 'middle'
  | 'bottom'

export type DistributeAxis = 'horizontal' | 'vertical'

export const ALIGN_EDGES: readonly AlignEdge[] = [
  'left',
  'center',
  'right',
  'top',
  'middle',
  'bottom',
]

export const DISTRIBUTE_AXES: readonly DistributeAxis[] = [
  'horizontal',
  'vertical',
]

type Bounds = Readonly<{
  minX: number
  minY: number
  maxX: number
  maxY: number
}>

/**
 * The position each node takes when the selection is aligned to `edge`.
 *
 * Total: every input gets an entry, including the nodes already on that edge
 * (the caller drops the no-ops — `setNodePositions` compares before writing).
 * An empty selection yields an empty map, and a selection of one yields that
 * node's own position, because a lone node *is* its own bounding box.
 */
export function alignRects(
  rects: readonly ArrangeRect[],
  edge: AlignEdge,
): Map<string, ArrangePoint> {
  const positions = new Map<string, ArrangePoint>()
  const bounds = boundsOf(rects)
  if (!bounds) return positions
  for (const rect of rects) {
    positions.set(rect.id, alignedPoint(rect, bounds, edge))
  }
  return positions
}

function alignedPoint(
  rect: ArrangeRect,
  bounds: Bounds,
  edge: AlignEdge,
): ArrangePoint {
  switch (edge) {
    case 'left':
      return { x: bounds.minX, y: rect.y }
    case 'right':
      return { x: bounds.maxX - rect.w, y: rect.y }
    case 'center':
      return { x: (bounds.minX + bounds.maxX - rect.w) / 2, y: rect.y }
    case 'top':
      return { x: rect.x, y: bounds.minY }
    case 'bottom':
      return { x: rect.x, y: bounds.maxY - rect.h }
    case 'middle':
      return { x: rect.x, y: (bounds.minY + bounds.maxY - rect.h) / 2 }
  }
}

/**
 * The position each node takes when the selection is spread evenly along
 * `axis`.
 *
 * The span is fixed by the two outermost nodes — they do not move — and the
 * leftover space is divided into equal gaps between neighbours. Nodes are
 * ordered by their current position along the axis (ties broken by the other
 * axis, so a stable order exists for nodes that start stacked), which is what
 * makes the operation preserve the arrangement the user already sees rather
 * than reshuffling it.
 *
 * Fewer than three nodes is a no-op: with two there is a single gap and it is
 * already whatever the user left it at, and with one or none there is nothing
 * to space. The map is still total over the input so callers need no special
 * case.
 */
export function distributeRects(
  rects: readonly ArrangeRect[],
  axis: DistributeAxis,
): Map<string, ArrangePoint> {
  const positions = new Map<string, ArrangePoint>()
  for (const rect of rects) positions.set(rect.id, { x: rect.x, y: rect.y })
  const bounds = boundsOf(rects)
  if (!bounds || rects.length < 3) return positions

  const horizontal = axis === 'horizontal'
  const ordered = rects.slice().sort((a, b) => {
    const primary = horizontal ? a.x - b.x : a.y - b.y
    return primary !== 0 ? primary : horizontal ? a.y - b.y : a.x - b.x
  })
  const extent = ordered.reduce(
    (total, rect) => total + (horizontal ? rect.w : rect.h),
    0,
  )
  const span = horizontal
    ? bounds.maxX - bounds.minX
    : bounds.maxY - bounds.minY
  const gap = (span - extent) / (ordered.length - 1)

  // The first node anchors the run and the last is already at the far edge by
  // construction, so only the interior ones are placed.
  let previous = ordered[0]
  for (let index = 1; index < ordered.length - 1; index += 1) {
    const rect = ordered[index]
    const point = horizontal
      ? { x: previous.x + previous.w + gap, y: rect.y }
      : { x: rect.x, y: previous.y + previous.h + gap }
    positions.set(rect.id, point)
    previous = { ...rect, ...point }
  }
  return positions
}

function boundsOf(rects: readonly ArrangeRect[]): Bounds | null {
  if (rects.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const rect of rects) {
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.w)
    maxY = Math.max(maxY, rect.y + rect.h)
  }
  return { minX, minY, maxX, maxY }
}
