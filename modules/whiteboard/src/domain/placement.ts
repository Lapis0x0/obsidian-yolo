// Where a card goes when nobody said where — the other half of `edit_board`'s
// optional coordinates (docs/plans/09-03-whiteboard-agent-tools Q4, Q9).
//
// One rule, and one prohibition.
//
// The rule: start where the caller pointed (beside an anchor card, or beside
// what is already on the board), then step along the requested direction
// until the card fits.
//
// The prohibition: **never move a node that is already there.** Pushing
// neighbours aside to make room is a re-layout nobody asked for, and Q2
// opened re-layout only to an explicit request (`arrange`). So placement
// searches for space; it never makes space. The worst it can do is put a card
// further away than the prettiest spot.
//
// Groups are not obstacles. A group is a frame drawn behind its members, and
// membership is geometric — landing a new card inside one is how a card joins
// it, so treating the frame as occupied would make "add this to that group"
// impossible to express.
//
// There is no grid, column-count, or other layout knob here. A caller that
// wants a specific arrangement has two better ways to say so: give the
// coordinates, or create the cards and then `arrange` them. A third,
// half-expressive layout language in between would only be a worse version of
// both.

import type { BoardNode } from './fileFormat'

/** Gap left between a placed card and whatever it was placed against. */
export const PLACEMENT_GAP = 40

/**
 * How many steps the search takes before giving up and stacking at the last
 * candidate. Reached only on a board dense enough that the whole ray is
 * occupied, where any answer is arbitrary; the cap exists so a pathological
 * board cannot spin.
 */
const MAX_PLACEMENT_STEPS = 500

export type Rect = Readonly<{ x: number; y: number; w: number; h: number }>
export type Size = Readonly<{ w: number; h: number }>
export type Point = Readonly<{ x: number; y: number }>

export type PlacementDirection = 'right' | 'left' | 'below' | 'above'

export const PLACEMENT_DIRECTIONS: readonly PlacementDirection[] = [
  'right',
  'left',
  'below',
  'above',
]

export type PlacementRequest = Readonly<{
  /**
   * Rectangle to place against. Null/absent = against everything already
   * placed, so a card lands beside the work rather than on top of it.
   */
  anchor?: Rect | null
  direction?: PlacementDirection
}>

/**
 * Every rectangle a new card must avoid. Group frames are filtered out here
 * rather than by each caller, so no call site can forget why.
 */
export function collectObstacles(nodes: readonly BoardNode[]): Rect[] {
  return nodes
    .filter((node) => node.type !== 'group')
    .map(({ x, y, w, h }) => ({ x, y, w, h }))
}

export function placeCard(
  obstacles: readonly Rect[],
  size: Size,
  { anchor, direction = 'right' }: PlacementRequest = {},
): Point {
  // On an empty board with no anchor, "beside" has nothing to be beside, so
  // the origin is the answer rather than a fallback.
  const from = anchor ?? boundsOf(obstacles)
  const seed = from ? adjacent(from, size, direction) : { x: 0, y: 0 }
  return findFreeSpot(seed, size, obstacles, direction)
}

/** Where a card of `size` sits when placed against `from` on that side. */
function adjacent(
  from: Rect,
  size: Size,
  direction: PlacementDirection,
): Point {
  switch (direction) {
    case 'right':
      return { x: from.x + from.w + PLACEMENT_GAP, y: from.y }
    case 'left':
      return { x: from.x - size.w - PLACEMENT_GAP, y: from.y }
    case 'below':
      return { x: from.x, y: from.y + from.h + PLACEMENT_GAP }
    case 'above':
      return { x: from.x, y: from.y - size.h - PLACEMENT_GAP }
  }
}

/**
 * Walks `direction` from `seed` until the card fits. Searching along the
 * direction the caller asked for (rather than spiralling) keeps the result
 * predictable: a card asked for on the right lands on the right, further out
 * if it has to, and never behind the anchor.
 */
function findFreeSpot(
  seed: Point,
  size: Size,
  obstacles: readonly Rect[],
  direction: PlacementDirection,
): Point {
  let candidate: Rect = { ...seed, w: size.w, h: size.h }
  for (let step = 0; step < MAX_PLACEMENT_STEPS; step += 1) {
    if (!obstacles.some((obstacle) => overlaps(obstacle, candidate))) {
      return { x: candidate.x, y: candidate.y }
    }
    candidate = { ...advance(candidate, direction), w: size.w, h: size.h }
  }
  return { x: candidate.x, y: candidate.y }
}

function advance(rect: Rect, direction: PlacementDirection): Point {
  const stride = (isHorizontal(direction) ? rect.w : rect.h) + PLACEMENT_GAP
  switch (direction) {
    case 'right':
      return { x: rect.x + stride, y: rect.y }
    case 'left':
      return { x: rect.x - stride, y: rect.y }
    case 'below':
      return { x: rect.x, y: rect.y + stride }
    case 'above':
      return { x: rect.x, y: rect.y - stride }
  }
}

const isHorizontal = (direction: PlacementDirection): boolean =>
  direction === 'right' || direction === 'left'

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  )
}

function boundsOf(rects: readonly Rect[]): Rect | null {
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
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}
