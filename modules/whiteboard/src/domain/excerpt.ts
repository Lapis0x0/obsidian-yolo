// What an excerpt from a PDF looks like once it is on the board: a text
// node (drawn as bare text — ui/canvas/pdfExcerpts.ts), written in Obsidian's
// own Markdown so it reads the same when it
// is copied into a note, and a link back to the page in Obsidian's own
// syntax (`#page=N&selection=a,b,c,d`) so it opens wherever a PDF link opens.
//
// A text excerpt is the quote, then the link as its own paragraph:
//
//   > The quoted passage, its PDF line breaks undone.
//
//   [[paper.pdf#page=3&selection=12,0,15,31|paper, p.3]]
//
// The quote holds only the source's words, so copying the quote copies
// exactly what was selected, and the link under it is the citation — the
// shape a note takes when a passage is pasted and its source put under it.
//
// A comment excerpt is an annotation's comment taken onto the board: the
// comment, as it was written, then the link to the passage it is about. Not
// the passage itself — a comment is a small thought of the reader's, and
// carrying its passage along would make every one of them a quote with a
// remark under it; the link reads the passage where it is, and the passage
// is an excerpt of its own when it is wanted beside it.
//
//   The argument skips a step here.
//
//   [[paper.pdf#page=3&selection=12,0,15,31|paper, p.3]]
//
// An area excerpt is the same card with a picture in the quote's place: the
// framed region as a PNG attachment, embedded, then the link to its page. One
// card rather than an image card beside a text card, because the two are one
// excerpt: they move, copy and delete together, and no image card can carry
// a link of its own.
//
// Also the other direction: reading `#page=…&selection=…` back out of a link
// someone clicked. Pure: no DOM, no host.

import type { PdfRectTuple, SelectionTuple } from './pdfAnnotations'

/** A passage to excerpt: its text, and where the link under it points. */
export type TextExcerpt = Readonly<{
  page: number
  /** Null cites the page alone. */
  selection: SelectionTuple | null
  quote: string
}>

/** An annotation's comment to excerpt, and where the link under it points. */
export type CommentExcerpt = Readonly<{
  page: number
  /** Null cites the page alone. */
  selection: SelectionTuple | null
  comment: string
}>

/** What an excerpt being dragged will become — enough to know the size of
 * its card before it is made. */
export type ExcerptContent =
  | Readonly<{ kind: 'text'; quote: string }>
  | Readonly<{ kind: 'comment'; comment: string }>
  | Readonly<{ kind: 'area'; rect: PdfRectTuple }>

/** Where a PDF link points inside its file. */
export type PdfLinkTarget = Readonly<{
  /** 1-based. */
  page: number
  /** Null for a link to the page alone (`#page=N`). */
  selection: SelectionTuple | null
}>

/**
 * Splits a link's text (`paper.pdf#page=3&selection=…`, as a rendered link's
 * `data-href` holds it) into the file part and the PDF location, or null
 * when it names no page. Parameters other than `page` and `selection`
 * (`color=…`, which Obsidian adds to a link copied with a highlight colour)
 * are ignored; a malformed selection leaves the page.
 */
export function parsePdfLink(
  linktext: string,
): Readonly<{ linkpath: string; target: PdfLinkTarget }> | null {
  const hash = linktext.indexOf('#')
  if (hash < 0) return null
  const target = parsePdfSubpath(linktext.slice(hash + 1))
  if (!target) return null
  return { linkpath: safeDecode(linktext.slice(0, hash)), target }
}

/** The location part of a PDF link, without its leading `#`. */
export function parsePdfSubpath(subpath: string): PdfLinkTarget | null {
  let page: number | null = null
  let selection: SelectionTuple | null = null
  for (const part of subpath.split('&')) {
    const equals = part.indexOf('=')
    if (equals < 0) continue
    const key = part.slice(0, equals).trim()
    const value = safeDecode(part.slice(equals + 1)).trim()
    if (key === 'page') {
      page = /^\d+$/.test(value) ? Number(value) : null
    } else if (key === 'selection') {
      const numbers = value.split(',').map((n) => n.trim())
      selection =
        numbers.length === 4 && numbers.every((n) => /^\d+$/.test(n))
          ? (numbers.map(Number) as unknown as SelectionTuple)
          : null
    }
  }
  if (page === null || page < 1) return null
  return { page, selection }
}

/** The subpath a link to a place in a PDF carries. */
export function pdfSubpath(page: number, selection?: SelectionTuple): string {
  return selection
    ? `#page=${page}&selection=${selection.join(',')}`
    : `#page=${page}`
}

const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/

/**
 * A selection's text as one paragraph. A PDF breaks lines where its layout
 * ran out of width, not where its author ended a thought, so the breaks are
 * joined: with a space between words, with nothing between two CJK
 * characters (which a space would split), and with nothing after a line
 * ending in a hyphen — that keeps a real compound whole and leaves a word
 * the layout split at least readable.
 */
export function excerptQuoteText(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
  let out = ''
  for (const line of lines) {
    if (out === '') {
      out = line
      continue
    }
    const last = out[out.length - 1]
    const joinTight = last === '-' || (CJK.test(last) && CJK.test(line[0]))
    out += joinTight ? line : ` ${line}`
  }
  return out
}

/** A text excerpt card's Markdown: the quote, then its link. */
export function textExcerptMarkdown(quote: string, link: string): string {
  return `> ${excerptQuoteText(quote)}\n\n${link}`
}

/** A comment excerpt's Markdown: the comment as written, then its link. */
export function commentExcerptMarkdown(comment: string, link: string): string {
  return `${comment.trim()}\n\n${link}`
}

/** An area excerpt card's Markdown: the picture (`link` to the attachment,
 * made an embed), then the link to its page. */
export function areaExcerptMarkdown(
  imageLink: string,
  pageLink: string,
): string {
  const embed = imageLink.startsWith('!') ? imageLink : `!${imageLink}`
  return `${embed}\n\n${pageLink}`
}

/** A name for an area's PNG: the PDF's, its page, and when — so two frames
 * of one page do not have to be told apart by a counter. */
export function areaExcerptFileName(
  pdfBasename: string,
  page: number,
  now: Date,
): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate(),
  )}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const safe =
    pdfBasename
      .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'pdf'
  return `${safe} p${page} ${stamp}.png`
}

export type ExcerptCardMetrics = Readonly<{
  /** The card's width. */
  width: number
  /** Heights are rounded up to whole steps of this, so a card sits on the
   * grid. */
  grid: number
  minHeight: number
  maxHeight: number
}>

// A card body's text: 13px on 1.5 lines, 6px/10px padding (style.css), and a
// blockquote indents by about 24px. Estimates, not measurements — a card
// that comes out a line short or long is still readable, and the user sizes
// it from there.
const LINE_PX = 20
const LATIN_CHAR_PX = 6.5
const WIDE_CHAR_PX = 13
const BODY_PADDING_X = 20
const QUOTE_INDENT_PX = 26
/** Padding, the gap between the quote and the link, and the link's line. */
const CHROME_PX = 12 + 13 + LINE_PX + 13

/** The size a text excerpt card is made at, from how much it has to show. */
export function textExcerptCardSize(
  quote: string,
  metrics: ExcerptCardMetrics,
): Readonly<{ w: number; h: number }> {
  const inner = metrics.width - BODY_PADDING_X - QUOTE_INDENT_PX
  return {
    w: metrics.width,
    h: fitHeight(
      wrappedLines(excerptQuoteText(quote), inner) * LINE_PX + CHROME_PX,
      metrics,
    ),
  }
}

/** The size a comment excerpt is made at: as a quote's, without the quote's
 * indent, and keeping the comment's own line breaks. */
export function commentExcerptCardSize(
  comment: string,
  metrics: ExcerptCardMetrics,
): Readonly<{ w: number; h: number }> {
  const inner = metrics.width - BODY_PADDING_X
  let lines = 0
  for (const line of comment.trim().split(/\r?\n/)) {
    lines += wrappedLines(line, inner)
  }
  return {
    w: metrics.width,
    h: fitHeight(lines * LINE_PX + CHROME_PX, metrics),
  }
}

/** How many lines `text` wraps to in `inner` pixels — at least one. */
function wrappedLines(text: string, inner: number): number {
  let width = 0
  for (const char of text) {
    width += CJK.test(char) ? WIDE_CHAR_PX : LATIN_CHAR_PX
  }
  return Math.max(1, Math.ceil(width / inner))
}

/**
 * The size an area excerpt card is made at: wide enough for the picture at
 * the card's width (a PNG shows at one CSS pixel per pixel, up to the width
 * it is given), tall enough for it and the link under it.
 */
export function areaExcerptCardSize(
  image: Readonly<{ width: number; height: number }>,
  metrics: ExcerptCardMetrics,
): Readonly<{ w: number; h: number }> {
  const inner = metrics.width - BODY_PADDING_X
  const shown = Math.min(inner, image.width)
  const height = image.width > 0 ? (shown * image.height) / image.width : 0
  return {
    w: metrics.width,
    h: fitHeight(height + CHROME_PX, metrics),
  }
}

function fitHeight(height: number, metrics: ExcerptCardMetrics): number {
  const clamped = Math.min(
    metrics.maxHeight,
    Math.max(metrics.minHeight, height),
  )
  return Math.ceil(clamped / metrics.grid) * metrics.grid
}

function safeDecode(text: string): string {
  if (!text.includes('%')) return text
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}
