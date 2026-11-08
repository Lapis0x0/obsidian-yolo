// Where a passage is in a card the GPU scene draws: what
// ../canvas/textPassages.ts's `placeTextPassage` says of a card's DOM, said
// of the text runs the typesetter laid out (../typesetting/typesetter.ts's
// `runs`), so that an edge reaching a passage ends at it whether the card is
// built or drawn.
//
// Found the same way: the passage, read in the card's source, is looked for
// loosely (letters and digits) in the text the card shows — here the runs'
// text, in reading order, as the DOM's is its text nodes in document order.

import {
  TEXT_QUOTE_CONTEXT,
  type TextAnchor,
  findLoose,
  resolveTextAnchor,
} from '../../domain/textAnchor'
import type { CardPassagePlacement } from '../canvas/edgeLayer'
import { RUN_FIELDS } from '../typesetting/typesetProtocol'

import { runOffsetX } from './glyphs'

/** A card's runs: its shown text, per run RUN_FIELDS floats, and the fonts
 * they name — laid out from the top of the block its window starts at.
 * `view` is what of that shows in the card: its content moved up by
 * `scroll`, seen from `top` (below the top inset, once moved) to `bottom`
 * (the card's height); all of it when left out. */
export type DrawnText = Readonly<{
  shown: string
  runs: Float32Array
  fonts: readonly string[]
  view?: Readonly<{ scroll: number; top: number; bottom: number }>
}>

/** A glyph's advance in a font. */
export type GlyphAdvance = (glyph: string, font: string) => number

/** How many characters at either end of what a card draws are looked for
 * in the source to tell where the drawing starts and ends. */
const DRAWN_EDGE_CHARS = 64

/** Where `anchor` is in a card drawing `drawn`, in card units from its
 * top-left corner; above or below what it draws; or null when the passage
 * is gone. */
export function placeDrawnPassage(
  drawn: DrawnText,
  source: string,
  anchor: TextAnchor,
  advance: GlyphAdvance,
): CardPassagePlacement | null {
  const placed = placeDrawnLines(drawn, source, anchor, advance)
  if (!placed || placed.state !== 'visible') return placed
  const { lines } = placed
  return {
    state: 'visible',
    top: Math.min(...lines.map((line) => line.top)),
    bottom: Math.max(...lines.map((line) => line.bottom)),
    left: Math.min(...lines.map((line) => line.left)),
    right: Math.max(...lines.map((line) => line.right)),
  }
}

/** Where a passage is on a drawn card, run by run — a box per piece of a
 * line it covers — in the card's own units; or that it is not drawn. */
export function placeDrawnLines(
  drawn: DrawnText,
  source: string,
  anchor: TextAnchor,
  advance: GlyphAdvance,
):
  | Readonly<{ state: 'visible'; lines: readonly PassageBox[] }>
  | Readonly<{ state: 'above' | 'below' }>
  | null {
  const span = resolveTextAnchor(source, anchor)
  if (!span) return null
  const found = findLoose(drawn.shown, source.slice(span[0], span[1]), {
    before: source.slice(Math.max(0, span[0] - TEXT_QUOTE_CONTEXT), span[0]),
    after: source.slice(span[1], span[1] + TEXT_QUOTE_CONTEXT),
  })
  if (!found) {
    const outside = beyond(drawn.shown, source, span)
    return outside && outside.state !== 'visible' ? outside : null
  }
  const [start, end] = found
  const lines: PassageBox[] = []
  const { runs } = drawn
  const scroll = drawn.view?.scroll ?? 0
  // Of the passage's lines, some above what the card shows, some below.
  let above = 0
  let below = 0
  for (let i = 0; i < runs.length; i += RUN_FIELDS) {
    const runStart = runs[i]
    const runEnd = runs[i + 1]
    if (runEnd <= start || runStart >= end) continue
    const x0 = runs[i + 2]
    const x1 = runs[i + 4]
    const text = drawn.shown.slice(runStart, runEnd)
    const font = drawn.fonts[runs[i + 7]] ?? ''
    // Across the run as far as the passage goes: where the GPU scene puts
    // its glyphs (./glyphs.ts).
    const at = (offset: number) =>
      x0 +
      runOffsetX(
        text,
        x1 - x0,
        (glyph) => advance(glyph, font),
        offset - runStart,
      )
    const top = runs[i + 3] - scroll
    const bottom = runs[i + 5] - scroll
    if (!(top < bottom)) continue
    if (drawn.view && bottom <= drawn.view.top) {
      above += 1
      continue
    }
    if (drawn.view && top >= drawn.view.bottom) {
      below += 1
      continue
    }
    lines.push({
      top,
      bottom,
      left: at(Math.max(start, runStart)),
      right: at(Math.min(end, runEnd)),
    })
  }
  if (lines.length === 0) {
    if (above > 0 && below === 0) return { state: 'above' }
    if (below > 0 && above === 0) return { state: 'below' }
    return null
  }
  return { state: 'visible', lines }
}

/** A box in a card, in its own units from its top left. */
export type PassageBox = Readonly<{
  top: number
  bottom: number
  left: number
  right: number
}>

/** A passage the card does not draw: above all it draws, or below. */
function beyond(
  shown: string,
  source: string,
  span: readonly [number, number],
): CardPassagePlacement | null {
  if (shown.trim().length === 0) return null
  const first = findLoose(source, shown.slice(0, DRAWN_EDGE_CHARS))
  const last = findLoose(source, shown.slice(-DRAWN_EDGE_CHARS))
  if (first && span[1] <= first[0]) return { state: 'above' }
  if (last && span[0] >= last[1]) return { state: 'below' }
  return null
}

/** Glyph advances as this window's canvas measures them — as the
 * typesetting worker's does, from the same fonts — each measured once. */
export function canvasGlyphAdvance(): GlyphAdvance {
  let ctx: OffscreenCanvasRenderingContext2D | null | undefined
  const known = new Map<string, Map<string, number>>()
  return (glyph, font) => {
    ctx ??= new OffscreenCanvas(1, 1).getContext('2d')
    let widths = known.get(font)
    if (!widths) {
      widths = new Map()
      known.set(font, widths)
    }
    let width = widths.get(glyph)
    if (width === undefined) {
      if (ctx && ctx.font !== font) ctx.font = font
      width = ctx ? ctx.measureText(glyph).width : 0
      widths.set(glyph, width)
    }
    return width
  }
}
