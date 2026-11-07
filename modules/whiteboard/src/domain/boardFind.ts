// Finding text across a board's cards: every occurrence of a query in the
// text of each card given — a text card's Markdown, a note card's note — as
// a place in that card's source, which is what a passage on the card is
// placed from (domain/textAnchor.ts).
//
// Matched as the PDF reader's find matches a page (./textSearch.ts), a card's
// lines being its items, and with Markdown's marks taking no part: a card
// shows "**a** b" as "a b", and that is what is looked for.
//
// A board holds thousands of cards and the query changes as it is typed, so
// each card's folded text is kept — only the text, a fraction of what the
// map from each folded character back to the source costs — and that map is
// built only for the cards the query is in.

import {
  type SearchTextItem,
  buildPageSearchIndex,
  findInPage,
  foldSearchText,
  normalizeQuery,
} from './textSearch'

/** Markdown's marks, shown as formatting rather than as text. Tested one
 * character at a time, so not global. */
const MARKDOWN_MARKS = /[*_~=`#[\]]/

export type FindableCard = Readonly<{
  id: string
  source: string
  /** Where its text starts in `source`: past a note's frontmatter. */
  from: number
}>

/** An occurrence: where it is in its card's source. */
export type FindHit = Readonly<{ id: string; start: number; end: number }>

type Folded = Readonly<{ source: string; from: number; text: string }>

export class BoardFind {
  private readonly folded = new Map<string, Folded>()

  /** Every occurrence of `query`, card by card in the order given, each
   * card's in reading order. What is kept of a card not given is let go. */
  find(cards: readonly FindableCard[], query: string): FindHit[] {
    const wanted = normalizeQuery(query, MARKDOWN_MARKS)
    const seen = new Set<string>()
    const hits: FindHit[] = []
    for (const card of cards) {
      seen.add(card.id)
      const text = this.foldedText(card)
      if (wanted === '' || !text.includes(wanted)) continue
      hits.push(...hitsIn(card, wanted))
    }
    for (const id of [...this.folded.keys()]) {
      if (!seen.has(id)) this.folded.delete(id)
    }
    return hits
  }

  private foldedText(card: FindableCard): string {
    const known = this.folded.get(card.id)
    if (known && known.source === card.source && known.from === card.from) {
      return known.text
    }
    const text = foldSearchText(linesOf(card).items, MARKDOWN_MARKS)
    this.folded.set(card.id, { source: card.source, from: card.from, text })
    return text
  }
}

function hitsIn(card: FindableCard, wanted: string): FindHit[] {
  const { items, starts } = linesOf(card)
  return findInPage(buildPageSearchIndex(items, MARKDOWN_MARKS), wanted).map(
    ([startLine, startOffset, endLine, endOffset]) => ({
      id: card.id,
      start: starts[startLine] + startOffset,
      end: starts[endLine] + endOffset,
    }),
  )
}

/** A card's text as lines, each the item it is matched as, and where each
 * starts in the source. */
function linesOf(card: FindableCard): {
  items: SearchTextItem[]
  starts: number[]
} {
  const items: SearchTextItem[] = []
  const starts: number[] = []
  let at = card.from
  for (const line of card.source.slice(card.from).split('\n')) {
    items.push({ text: line, endsLine: true })
    starts.push(at)
    at += line.length + 1
  }
  return { items, starts }
}
