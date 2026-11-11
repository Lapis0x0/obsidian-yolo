// How things on the board move as they are folded into something smaller
// and opened back out of it — the one rule every fold on the board follows
// (canvas.ts's `gather`, `dealOut`), shown by whatever draws each node
// (./canvas/motions.ts). The DOM and the overview canvas used to each say it
// for PDF spreads alone, and drifted: a change made to one was not made to
// the other, and the overview went on fading the very page the card was
// turning into.
//
// A fold is a map from the board onto where a thing is shown folded: a
// uniform scale about one point, landing at another (`FoldMap`). Each node
// it carries travels between its own place and where the map puts it, and
// is that much smaller there (`motionUnder`). Two folds use it:
//
// - A PDF spread folding into its card (`sheetMotion`): each sheet is mapped
//   onto the card, as wide as it, top-left on top-left. The page the card
//   shows *is* the card — its sheet travels whole, drawn over the others and
//   at once; every other sheet comes out from under it fading in, in page
//   order, or goes back under it fading out, all together.
// - A group collapsing into its box (`groupFoldMotions`): each thing it
//   holds — with what that thing carries — is mapped onto its cell of the
//   box, the same map the box draws its picture of it by (domain/groups.ts's
//   `collapsedGroupPlaces`), so where the motion ends is where the picture
//   is. Things past the cells go into the last one, fading.
//
// Described in world units and proportions only — nothing of either
// compositor's — so each turns it into its own drawing. UI presentation
// policy, not board data, so it sits beside lod.ts rather than in domain/.

import type { GroupPlace } from '../domain/groups'

import { SPREAD_DEAL_MAX_DELAY_MS, SPREAD_DEAL_STAGGER_MS } from './constants'
import type { Pose } from './tween'

/** Opened out of the fold (`in`), or folded back into it (`out`). */
export type FoldDirection = 'in' | 'out'

/** One node's part in a fold, between its place and where it is folded. */
export type FoldMotion = Readonly<{
  /** From the node's own top-left to where it is folded, in world units. */
  offset: Readonly<{ x: number; y: number }>
  /** Its size folded, as a multiple of its own, from its top-left. */
  scale: number
  /** Faded out folded; whole throughout otherwise. */
  fade: boolean
  /** How long after the motion starts this node leaves, in ms. */
  delay: number
  /** Drawn over every other node in the fold. */
  onTop: boolean
}>

/** A point `p` of the board, folded, is at `to + (p - from) * scale`. */
export type FoldMap = Readonly<{
  from: Readonly<{ x: number; y: number }>
  to: Readonly<{ x: number; y: number }>
  scale: number
}>

type Point = Readonly<{ x: number; y: number }>

/** Where `node` is shown folded by `motion` (./canvas/motions.ts plays the
 * way there and back). */
export function foldedPose(
  node: Readonly<{ x: number; y: number; w: number; h: number }>,
  motion: FoldMotion,
): Pose {
  return {
    x: node.x + motion.offset.x,
    y: node.y + motion.offset.y,
    w: node.w * motion.scale,
    h: node.h * motion.scale,
    opacity: motion.fade ? 0 : 1,
  }
}

/** How `node` moves under `map`. */
export function motionUnder(
  node: Point,
  map: FoldMap,
  how: Readonly<{ fade: boolean; delay: number; onTop: boolean }>,
): FoldMotion {
  return {
    offset: {
      x: map.to.x + (node.x - map.from.x) * map.scale - node.x,
      y: map.to.y + (node.y - map.from.y) * map.scale - node.y,
    },
    scale: map.scale,
    ...how,
  }
}

type Sheet = Readonly<{ x: number; y: number; w: number; page: number }>
type Card = Readonly<{ x: number; y: number; w: number }>

/** How `sheet` of a spread moves, the card showing page `lead`. */
export function sheetMotion(
  sheet: Sheet,
  card: Card,
  lead: number,
  direction: FoldDirection,
): FoldMotion {
  const onTop = sheet.page === lead
  return motionUnder(
    sheet,
    { from: sheet, to: card, scale: card.w / sheet.w },
    {
      fade: !onTop,
      // Going back, they go together: the card is waiting for all of them.
      delay:
        onTop || direction === 'out'
          ? 0
          : Math.min(
              (sheet.page - 1) * SPREAD_DEAL_STAGGER_MS,
              SPREAD_DEAL_MAX_DELAY_MS,
            ),
      onTop,
    },
  )
}

/** Every sheet's motion, the one on top last — the order a compositor that
 * draws in order of being told should be told in. */
export function spreadMotions<S extends Sheet>(
  sheets: readonly S[],
  card: Card,
  lead: number,
  direction: FoldDirection,
): readonly Readonly<{ node: S; motion: FoldMotion }>[] {
  const moves = sheets.map((node) => ({
    node,
    motion: sheetMotion(node, card, lead, direction),
  }))
  return [
    ...moves.filter((move) => !move.motion.onTop),
    ...moves.filter((move) => move.motion.onTop),
  ]
}

/**
 * Every node a group's fold carries, and how: each place in its box
 * (`places`) carries the thing it shows and what `carried` says that thing
 * takes with it, all under the place's map. The same either way: a group
 * opens all at once, as it closes.
 */
export function groupFoldMotions<N extends Point & Readonly<{ id: string }>>(
  places: readonly GroupPlace[],
  carried: (id: string) => readonly N[],
): readonly Readonly<{ node: N; motion: FoldMotion }>[] {
  return places.flatMap((place) => {
    const map: FoldMap = {
      from: place.extent,
      to: { x: place.x, y: place.y },
      scale: place.scale,
    }
    return carried(place.id).map((node) => ({
      node,
      motion: motionUnder(node, map, {
        fade: place.more,
        delay: 0,
        onTop: false,
      }),
    }))
  })
}
