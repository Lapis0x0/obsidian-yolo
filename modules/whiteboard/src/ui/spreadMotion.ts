// How each sheet of a PDF spread moves as the spread is dealt out of its
// card or gathered back into it — the one rule both of the board's
// compositors play: the DOM's Web Animations (canvas.ts's `playSpreadDeal`,
// `foldSpreadAway`) and the overview canvas's motions (overviewLayer.ts's
// `animate`). They used to each say it, and drifted: a change made to one
// was not made to the other, and the overview went on fading the very page
// the card was turning into.
//
// The rule: the page the folded card shows (gpu/pdfCards.ts's `firstPage`)
// *is* the card. Its sheet travels whole between its own place and the
// card's, drawn over the others and at once. Every other sheet comes out
// from under it fading in, in page order, or goes back under it fading out,
// all together. At the card's end each sheet is as wide as the card, its
// top-left on the card's.
//
// Described in world units and proportions only — nothing of either
// compositor's — so each turns it into its own drawing. UI presentation
// policy, not board data, so it sits beside lod.ts rather than in domain/.

import { SPREAD_DEAL_MAX_DELAY_MS, SPREAD_DEAL_STAGGER_MS } from './constants'

/** Dealt out of the card (`in`), or gathered back into it (`out`). */
export type SpreadMotionDirection = 'in' | 'out'

/** One sheet's part in the motion, between its place and the card's. */
export type SheetMotion = Readonly<{
  /** From the sheet's own top-left to where it is at the card's end, in
   * world units. */
  offset: Readonly<{ x: number; y: number }>
  /** Its size at the card's end, as a multiple of its own, from its
   * top-left. */
  scale: number
  /** Faded out at the card's end; whole throughout otherwise. */
  fade: boolean
  /** How long after the motion starts this sheet leaves, in ms. */
  delay: number
  /** Drawn over every other sheet: the page the card shows. */
  onTop: boolean
}>

type Sheet = Readonly<{ x: number; y: number; w: number; page: number }>
type Card = Readonly<{ x: number; y: number; w: number }>

/** How `sheet` moves, the card showing page `lead`. */
export function sheetMotion(
  sheet: Sheet,
  card: Card,
  lead: number,
  direction: SpreadMotionDirection,
): SheetMotion {
  const onTop = sheet.page === lead
  return {
    offset: { x: card.x - sheet.x, y: card.y - sheet.y },
    scale: card.w / sheet.w,
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
  }
}

/** Every sheet's motion, the one on top last — the order a compositor that
 * draws in order of being told should be told in. */
export function spreadMotions<S extends Sheet>(
  sheets: readonly S[],
  card: Card,
  lead: number,
  direction: SpreadMotionDirection,
): readonly Readonly<{ sheet: S; motion: SheetMotion }>[] {
  const moves = sheets.map((sheet) => ({
    sheet,
    motion: sheetMotion(sheet, card, lead, direction),
  }))
  return [
    ...moves.filter((move) => !move.motion.onTop),
    ...moves.filter((move) => move.motion.onTop),
  ]
}
