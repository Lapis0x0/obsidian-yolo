// A card's title line (styles/cards/title-line.css): one line above the
// card saying what kind of thing it is and what it is called — a badge and
// a name — for a card that stands for a whole document of its own: a PDF,
// and a portal onto another board.
//
// The line stands where an open PDF spread's title does (domain/spread.ts's
// SPREAD_METRICS: `titleHeight` tall, `titleGap` above the card), so a PDF's
// title does not move as its pages come out or go back, and every card that
// wears one is titled alike. The DOM draws it from `createTitleLine`; the
// overview canvas draws the same line at the same sizes
// (overviewLayer.ts's `drawTitleLines`, ../constants.ts's
// SPREAD_TITLE_WORLD). Both ask `titleBadgeOf` what it says.

import type { BoardNode } from '../../domain/fileFormat'
import { fileNodeKind } from '../../domain/naming'
import { isSpreadTitle } from '../../domain/spread'
import type { WhiteboardTranslation } from '../../i18n'

/** The badge's tint: the theme's colour of that name. */
export type TitleBadgeTone = 'red' | 'blue'

export type TitleBadge = Readonly<{ text: string; tone: TitleBadgeTone }>

const LINE_CLASS = 'yolo-whiteboard-title-line'
const BADGE_CLASS = 'yolo-whiteboard-title-badge'
const TEXT_CLASS = 'yolo-whiteboard-title-text'

/** Whether a card wears a title line above it as its label: a folded PDF
 * card, and a portal. An open spread's title is not one — it is the line
 * itself, a node of its own. */
export function wearsTitleLine(node: BoardNode): boolean {
  return (
    node.type === 'file' &&
    !isSpreadTitle(node) &&
    ['pdf', 'board'].includes(fileNodeKind(node.file))
  )
}

/** What a card's title line says its kind is, or null for a card that has
 * none — an open spread's title being a PDF's. */
export function titleBadgeOf(
  node: BoardNode,
  t: WhiteboardTranslation,
): TitleBadge | null {
  if (node.type !== 'file') return null
  switch (fileNodeKind(node.file)) {
    case 'pdf':
      return { text: 'PDF', tone: 'red' }
    case 'board':
      return { text: t('card.boardBadge'), tone: 'blue' }
    default:
      return null
  }
}

/** The line: the badge, then the name. */
export function createTitleLine(
  doc: Document,
  badge: TitleBadge,
  name: string,
): HTMLElement {
  const line = doc.createElement('div')
  line.className = LINE_CLASS
  const mark = doc.createElement('span')
  mark.className = `${BADGE_CLASS} ${BADGE_CLASS}-${badge.tone}`
  mark.textContent = badge.text
  const text = doc.createElement('span')
  text.className = TEXT_CLASS
  text.textContent = name
  line.append(mark, text)
  return line
}
