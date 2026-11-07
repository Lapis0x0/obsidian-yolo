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

/** A card's runs: its shown text, and per run RUN_FIELDS floats. */
export type DrawnText = Readonly<{ shown: string; runs: Float32Array }>

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
): CardPassagePlacement | null {
  const span = resolveTextAnchor(source, anchor)
  if (!span) return null
  const found = findLoose(drawn.shown, source.slice(span[0], span[1]), {
    before: source.slice(Math.max(0, span[0] - TEXT_QUOTE_CONTEXT), span[0]),
    after: source.slice(span[1], span[1] + TEXT_QUOTE_CONTEXT),
  })
  if (!found) return beyond(drawn.shown, source, span)
  const [start, end] = found
  let top = Infinity
  let bottom = -Infinity
  let left = Infinity
  let right = -Infinity
  const { runs } = drawn
  for (let i = 0; i < runs.length; i += RUN_FIELDS) {
    const runStart = runs[i]
    const runEnd = runs[i + 1]
    if (runEnd <= start || runStart >= end) continue
    const x0 = runs[i + 2]
    const x1 = runs[i + 4]
    // Across the run as far as the passage goes: its characters taken as
    // sharing the run's width evenly.
    const at = (offset: number) =>
      x0 + ((x1 - x0) * (offset - runStart)) / Math.max(1, runEnd - runStart)
    left = Math.min(left, at(Math.max(start, runStart)))
    right = Math.max(right, at(Math.min(end, runEnd)))
    top = Math.min(top, runs[i + 3])
    bottom = Math.max(bottom, runs[i + 5])
  }
  if (!(top < bottom)) return null
  return { state: 'visible', top, bottom, left, right }
}

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
