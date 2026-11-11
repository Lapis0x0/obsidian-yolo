// A node's title (styles/cards/node-title.css): the one bar over a node that
// says what it is and what it is called. A group, a PDF — folded into its
// card or spread out — and a portal each wear one, and it is the same bar on
// all of them: a badge naming what kind of thing it is (a group, a PDF, a
// board), the name, and a note (how much a group holds). It is the node's
// handle: a press on it selects the node, a drag moves it, and a group's is
// renamed by a double-click. What is done to the node as a whole is the
// selection toolbar's, which stands over the title.
//
// What it says is `titleOf`'s, and how large it is drawn `titleBox`'s: both
// hands that draw a board draw it from them — the DOM (`createTitle`), and
// the overview canvas for a card it draws (overviewLayer.ts's `drawTitles`) —
// and everything that asks where it is (the toolbar standing over it, a press
// landing on it) asks `titleBox` too. So the bar is one thing however it is
// drawn, and wherever it is asked about.
//
// The room it takes on the board is domain/title.ts's NODE_TITLE: as tall as
// that, that far above what it heads, left edges aligned — except an open
// spread's, which is a node of its own and is its own box (`own`).

import type { BoardNode, NodeId } from '../../domain/fileFormat'
import { basenameWithoutExtension, fileNodeKind } from '../../domain/naming'
import { NODE_TITLE } from '../../domain/title'
import { titleRoom, titleStand } from '../../domain/titlePlace'
import type { WhiteboardTranslation } from '../../i18n'
import { TITLE_MIN_SCREEN_PX } from '../constants'

export const TITLE_CLASS = 'yolo-whiteboard-title'
/** An open spread's title, which is its own node's whole box. */
const OWN_CLASS = 'yolo-whiteboard-title-own'
/** The name, where a group's rename edits it (editingController.ts). */
export const TITLE_LABEL_CLASS = 'yolo-whiteboard-title-label'
const BADGE_CLASS = 'yolo-whiteboard-title-badge'
const NOTE_CLASS = 'yolo-whiteboard-title-note'

/** A badge's tint: the theme's colour of that name — or, `neutral`, the
 * muted text's, which a coloured group's badge takes its colour in place of
 * (node-title.css). */
export type TitleBadgeTone = 'red' | 'blue' | 'neutral'

/** What kind of thing a title names, in a word, and its tint. */
export type TitleBadge = Readonly<{ text: string; tone: TitleBadgeTone }>

export type Title = Readonly<{
  badge: TitleBadge
  label: string
  /** Beside the name, muted: how much a group holds. */
  note: string | null
  /** An open spread's: the node is the title's box, rather than headed by
   * it. */
  own: boolean
}>

/** What `titleOf` needs to know beyond the node. */
export type TitleContext = Readonly<{
  t: WhiteboardTranslation
  memberCount: (id: NodeId) => number
}>

/** The title `node` wears, or null for a node that wears none
 * (domain/titlePlace.ts's `titleStand` says which do). */
export function titleOf(node: BoardNode, about: TitleContext): Title | null {
  const stand = titleStand(node)
  if (stand === null) return null
  const own = stand === 'own'
  const { t } = about
  if (node.type === 'group') {
    const count = about.memberCount(node.id)
    return {
      badge: { text: t('group.badge'), tone: 'neutral' },
      label: node.label ?? '',
      note:
        count === 1
          ? t('group.countOne')
          : t('group.count').replace('{count}', String(count)),
      own,
    }
  }
  if (node.type !== 'file') return null
  return {
    badge:
      fileNodeKind(node.file) === 'pdf'
        ? { text: 'PDF', tone: 'red' }
        : { text: t('card.boardBadge'), tone: 'blue' },
    label: basenameWithoutExtension(node.file),
    note: null,
    own,
  }
}

// ---------------------------------------------------------------------------
// Its size. The stylesheet's numbers (node-title.css), stated once here for
// everything that has to agree with what the DOM lays out: the canvas that
// draws a title the DOM does not, and whatever asks where one is.
// ---------------------------------------------------------------------------

/** The bar's insides, in its own pixels — node-title.css's. */
export const TITLE_LOOK = Object.freeze({
  paddingStart: 11,
  paddingEnd: 6,
  border: 1,
  radius: 9,
  gap: 8,
  label: Object.freeze({ size: 16, weight: 500 }),
  note: Object.freeze({ size: 12, weight: 400 }),
  badge: Object.freeze({
    size: 12,
    weight: 600,
    padding: 6,
    height: 20,
    /** letter-spacing, in em. */
    spacing: 0.02,
  }),
})

/** How wide `text` is at `size` px and `weight`, in the title's font. */
export type MeasureText = (text: string, size: number, weight: number) => number

/** How wide `title` lays out with nothing cut short, in its own pixels — the
 * width it takes when it has room for all of it. */
export function titleContentWidth(title: Title, measure: MeasureText): number {
  const look = TITLE_LOOK
  const badge = look.badge
  const parts = [
    measure(title.badge.text, badge.size, badge.weight) +
      title.badge.text.length * badge.spacing * badge.size +
      badge.padding * 2,
    measure(title.label, look.label.size, look.label.weight),
    ...(title.note === null
      ? []
      : [measure(title.note, look.note.size, look.note.weight)]),
  ]
  return (
    look.border * 2 +
    look.paddingStart +
    parts.reduce((sum, part) => sum + part, 0) +
    look.gap * (parts.length - 1) +
    look.paddingEnd
  )
}

/**
 * How much a title is scaled up from its bottom-left corner for a node seen
 * at `seen` (the camera's scale, times the portals' it is behind): 1 while
 * its name is at least TITLE_MIN_SCREEN_PX on screen, and as much as holds
 * it there past that. At every zoom, whichever hand draws it: a title is what
 * a board seen from far away is read by.
 */
export function titleScale(seen: number): number {
  return Math.max(1, TITLE_MIN_SCREEN_PX / (TITLE_LOOK.label.size * seen))
}

type Rect = Readonly<{ x: number; y: number; w: number; h: number }>

/**
 * Where `title` is over `node` shown at `rect` — in whatever units `rect` is
 * in, `unit` of them to one of the node's own — held `scale` times its size
 * (`titleScale`): the room the board gives it (domain/titlePlace.ts's
 * `titleRoom`), as wide as it lays out (`content`) inside that. Past that
 * its name is cut short: one line, so one height. Null for a node that
 * wears none.
 */
export function titleBox(
  node: BoardNode,
  rect: Rect,
  content: number,
  scale: number,
  unit: number,
): Rect | null {
  const room = titleRoom(node, rect, unit, scale)
  return room && { ...room, w: Math.min(content * scale * unit, room.w) }
}

// ---------------------------------------------------------------------------
// The DOM's bar.
// ---------------------------------------------------------------------------

/** The bar for `title`, built once per mount: a node's element is rebuilt
 * or its title replaced whenever what it says changes, so there is nothing
 * here to keep in step. */
export function createTitle(doc: Document, title: Title): HTMLElement {
  const bar = doc.createElement('div')
  bar.className = title.own ? `${TITLE_CLASS} ${OWN_CLASS}` : TITLE_CLASS
  bar.style.height = `${NODE_TITLE.height}px`
  if (!title.own) bar.style.bottom = `calc(100% + ${NODE_TITLE.gap}px)`

  const badge = doc.createElement('span')
  badge.className = `${BADGE_CLASS} ${BADGE_CLASS}-${title.badge.tone}`
  badge.textContent = title.badge.text
  bar.appendChild(badge)

  const label = doc.createElement('span')
  label.className = TITLE_LABEL_CLASS
  label.textContent = title.label
  // The whole name, where it is cut short.
  label.title = title.label
  label.spellcheck = false
  bar.appendChild(label)

  if (title.note !== null) {
    const note = doc.createElement('span')
    note.className = NOTE_CLASS
    note.textContent = title.note
    bar.appendChild(note)
  }
  return bar
}

/** The name, where a group's rename edits it. */
export function titleLabel(bar: Element): HTMLElement | null {
  return bar.querySelector<HTMLElement>(`.${TITLE_LABEL_CLASS}`)
}

/** Shows `bar` at `scale` (`titleScale`). A custom property on the bar,
 * which its transform and its widest are both written from: it has a handful
 * of descendants, so writing one restyles nothing else. */
export function applyTitleScale(bar: HTMLElement, scale: number): void {
  const value = String(scale)
  if (bar.style.getPropertyValue('--yolo-whiteboard-title-scale') !== value) {
    bar.setCssProps({ '--yolo-whiteboard-title-scale': value })
  }
}

/** How wide titles lay out, in the font the DOM lays them out in — one for
 * the board, which everything asking where a title is shares. */
export type TitleMeasure = Readonly<{
  /** The font family the DOM's titles are in. */
  family: string
  text: MeasureText
  /** `titleContentWidth`, remembered: asked of the same few dozen titles on
   * every frame that draws or places them. */
  width: (title: Title) => number
}>

const TITLE_WIDTHS_LIMIT = 2000

export function createTitleMeasure(family: string): TitleMeasure {
  const ctx = new OffscreenCanvas(1, 1).getContext('2d')
  const text: MeasureText = (value, size, weight) => {
    if (!ctx) return value.length * size * 0.6
    ctx.font = `${weight} ${size}px ${family}`
    return ctx.measureText(value).width
  }
  const widths = new Map<string, number>()
  return {
    family,
    text,
    width: (title) => {
      const key = JSON.stringify([title.badge, title.label, title.note])
      const known = widths.get(key)
      if (known !== undefined) return known
      if (widths.size >= TITLE_WIDTHS_LIMIT) widths.clear()
      const width = titleContentWidth(title, text)
      widths.set(key, width)
      return width
    },
  }
}
