// Where a card goes when nobody said where — the other half of `edit_board`'s
// optional coordinates (docs/plans/09-03-whiteboard-agent-tools Q4, Q9).
//
// This is the *only* thing a caller cannot express with coordinates, which is
// why it is the only placement behaviour that exists. There is no anchor, no
// direction, no grid and no column count: every one of those says something
// an `x` and a `y` already say, and offering both would make a caller choose
// between two spellings of one thing and leave two paths to keep in step.
// What coordinates genuinely cannot say is "somewhere sensible, not on top of
// anything" — so that is what this answers, and nothing else.
//
// The rule: start beside what the card should follow (the one before it in
// the same batch, or everything already on the board), then step right until
// it fits.
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

/**
 * Every rectangle a new card must avoid. Group frames are filtered out here
 * rather than by each caller, so no call site can forget why.
 */
export function collectObstacles(nodes: readonly BoardNode[]): Rect[] {
  return nodes
    .filter((node) => node.type !== 'group')
    .map(({ x, y, w, h }) => ({ x, y, w, h }))
}

/**
 * `after` is what the card should sit beside — the previous card of the same
 * batch. Null measures against everything already placed instead, so the
 * first card of a batch lands beside the work rather than on top of it; on an
 * empty board that leaves the origin, which is the one case where "beside"
 * has nothing to be beside.
 */
export function placeCard(
  obstacles: readonly Rect[],
  size: Size,
  after: Rect | null = null,
): Point {
  const from = after ?? boundsOf(obstacles)
  const seed = from
    ? { x: from.x + from.w + PLACEMENT_GAP, y: from.y }
    : { x: 0, y: 0 }
  return findFreeSpot(seed, size, obstacles)
}

/**
 * Walks right from `seed` until the card fits. Searching along one axis
 * (rather than spiralling) keeps the result predictable: a card lands after
 * what it follows, further out if it has to, and never behind it.
 */
function findFreeSpot(
  seed: Point,
  size: Size,
  obstacles: readonly Rect[],
): Point {
  let candidate: Rect = { ...seed, w: size.w, h: size.h }
  for (let step = 0; step < MAX_PLACEMENT_STEPS; step += 1) {
    if (!obstacles.some((obstacle) => overlaps(obstacle, candidate))) {
      return { x: candidate.x, y: candidate.y }
    }
    candidate = { ...candidate, x: candidate.x + candidate.w + PLACEMENT_GAP }
  }
  return { x: candidate.x, y: candidate.y }
}

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
