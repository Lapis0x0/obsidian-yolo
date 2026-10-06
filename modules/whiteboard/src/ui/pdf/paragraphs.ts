// A page's paragraphs, inferred from where its text is: what a connection
// dropped on a PDF snaps to (../canvas/connectGesture.ts). A PDF says nothing
// about paragraphs — it places runs of text — so they are read off the
// layout the way a reader's eye does: lines are runs of text side by side,
// and a paragraph ends where the next line leaves a gap, changes size,
// starts further in, or is in another column.
//
// Pure: boxes in, item ranges out. Boxes are page fractions (./annotation
// Geometry.ts's `PageBox`), item `i` is text-layer span `data-idx=i`, as in
// a selection tuple.

import { snapToWordEdge } from '../../domain/textAnchor'

import type { PageBox } from './annotationGeometry'

/** One text item of a page, with where it is on the page — null for an item
 * that takes no room (an empty span). */
export type PlacedTextItem = Readonly<{
  text: string
  endsLine: boolean
  box: PageBox | null
}>

/** A paragraph: the items it runs over (inclusive), and its lines' boxes. */
export type PageParagraph = Readonly<{
  first: number
  last: number
  lines: readonly PageBox[]
  box: PageBox
}>

type Line = { first: number; last: number; box: PageBox }

/** A line further from the one above than this many of its heights starts a
 * new paragraph. Body text sits at about a third. */
const PARAGRAPH_GAP_LINES = 0.7
/** A line this many times taller or shorter than the one above is a heading
 * or a caption, not more of the same paragraph. */
const SIZE_CHANGE = 1.3
/** A line starting this many of its heights further in than the paragraph's
 * left edge is a first-line indent. */
const INDENT_LINES = 0.8

export function inferParagraphs(
  items: readonly PlacedTextItem[],
): PageParagraph[] {
  const lines = inferLines(items)
  const paragraphs: PageParagraph[] = []
  let run: Line[] = []
  const flush = () => {
    if (run.length === 0) return
    paragraphs.push({
      first: run[0].first,
      last: run[run.length - 1].last,
      lines: run.map((line) => line.box),
      box: union(run.map((line) => line.box)),
    })
    run = []
  }
  for (const line of lines) {
    const above = run[run.length - 1]
    if (
      above &&
      startsParagraph(line.box, above.box, union(run.map((l) => l.box)))
    ) {
      flush()
    }
    run.push(line)
  }
  flush()
  return paragraphs
}

/** The paragraph at a point on the page (fractions), if any: inside one, or
 * within half a line of it. */
export function paragraphAt(
  paragraphs: readonly PageParagraph[],
  x: number,
  y: number,
): PageParagraph | null {
  let best: PageParagraph | null = null
  let bestDistance = Infinity
  for (const paragraph of paragraphs) {
    const { box } = paragraph
    const slop = (paragraph.lines[0].bottom - paragraph.lines[0].top) * 0.5
    const dx = Math.max(box.left - x, 0, x - box.right)
    const dy = Math.max(box.top - y, 0, y - box.bottom)
    if (dx > slop || dy > slop) continue
    const distance = Math.hypot(dx, dy)
    if (distance < bestDistance) {
      best = paragraph
      bestDistance = distance
    }
  }
  return best
}

function inferLines(items: readonly PlacedTextItem[]): Line[] {
  const lines: Line[] = []
  let current: Line | null = null
  let ended = false
  items.forEach((item, index) => {
    const box = item.box
    if (box && box.bottom > box.top && item.text.trim() !== '') {
      if (current && !ended && sameLine(current.box, box)) {
        current.last = index
        current.box = union([current.box, box])
      } else {
        current = { first: index, last: index, box }
        lines.push(current)
      }
      ended = false
    } else if (current && !ended) {
      // An empty item still belongs to the line it is in.
      current.last = index
    }
    if (item.endsLine) ended = true
  })
  return lines
}

function sameLine(line: PageBox, box: PageBox): boolean {
  const shared = Math.min(line.bottom, box.bottom) - Math.max(line.top, box.top)
  const least = Math.min(line.bottom - line.top, box.bottom - box.top)
  return shared >= least / 2
}

function startsParagraph(
  line: PageBox,
  above: PageBox,
  paragraph: PageBox,
): boolean {
  const height = line.bottom - line.top
  const aboveHeight = above.bottom - above.top
  if (
    height > aboveHeight * SIZE_CHANGE ||
    aboveHeight > height * SIZE_CHANGE
  ) {
    return true
  }
  // Another column, or text above the last line rather than below it.
  if (line.left >= above.right || line.right <= above.left) return true
  if (line.top < above.top) return true
  const gap = line.top - above.bottom
  if (gap > Math.max(height, aboveHeight) * PARAGRAPH_GAP_LINES) return true
  return line.left - paragraph.left > height * INDENT_LINES
}

function union(boxes: readonly PageBox[]): PageBox {
  return {
    left: Math.min(...boxes.map((box) => box.left)),
    top: Math.min(...boxes.map((box) => box.top)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  }
}

/** A paragraph's text as a selection of it reads: its items in order, a line
 * break after each that ends a line, none after the last. */
export function paragraphText(
  items: readonly Readonly<{ text: string; endsLine: boolean }>[],
  paragraph: PageParagraph,
): string {
  let text = ''
  for (let index = paragraph.first; index <= paragraph.last; index += 1) {
    text += items[index].text
    if (items[index].endsLine && index < paragraph.last) text += '\n'
  }
  return text.trim()
}

/** A place between two characters of a page's text: item `item`, before
 * its character `offset` — one end of a selection tuple. */
export type TextPosition = Readonly<{ item: number; offset: number }>

/**
 * The place in a page's text nearest a point (page fractions), snapped to a
 * word's edge: the line under the point (or the nearest), the item on it
 * nearest across, and the character by where across that item the point is —
 * an item's characters are taken to share its width evenly, which is what a
 * line of one font at one size does closely enough to aim at.
 */
export function positionNear(
  items: readonly PlacedTextItem[],
  x: number,
  y: number,
): TextPosition | null {
  let best: { index: number; box: PageBox } | null = null
  let bestDistance = Infinity
  items.forEach((item, index) => {
    const box = item.box
    if (!box || item.text.length === 0) return
    const dy = Math.max(box.top - y, 0, y - box.bottom)
    const dx = Math.max(box.left - x, 0, x - box.right)
    // A line away costs more than the width of the page across.
    const distance = dy * 10 + dx
    if (distance < bestDistance) {
      best = { index, box }
      bestDistance = distance
    }
  })
  if (!best) return null
  const { index, box } = best as { index: number; box: PageBox }
  const text = items[index].text
  const width = box.right - box.left
  const fraction = width > 0 ? (x - box.left) / width : 0
  const raw = Math.round(Math.min(1, Math.max(0, fraction)) * text.length)
  return { item: index, offset: snapToWordEdge(text, raw) }
}

/** A tuple's two ends in reading order. */
export function orderedTuple(
  a: TextPosition,
  b: TextPosition,
): readonly [number, number, number, number] {
  const aFirst = a.item < b.item || (a.item === b.item && a.offset <= b.offset)
  const [first, last] = aFirst ? [a, b] : [b, a]
  return [first.item, first.offset, last.item, last.offset]
}

/** The text a tuple covers, as a selection of it reads. */
export function tupleText(
  items: readonly Readonly<{ text: string; endsLine: boolean }>[],
  [startItem, startOffset, endItem, endOffset]: readonly [
    number,
    number,
    number,
    number,
  ],
): string {
  let text = ''
  for (let index = startItem; index <= endItem; index += 1) {
    const item = items[index]
    if (!item) break
    const from = index === startItem ? startOffset : 0
    const to = index === endItem ? endOffset : item.text.length
    text += item.text.slice(from, to)
    if (item.endsLine && index < endItem) text += '\n'
  }
  return text
}

/** The boxes of the lines a tuple covers — partial items cut where their
 * characters are taken to be (`positionNear`'s even split). */
export function tupleBoxes(
  items: readonly PlacedTextItem[],
  [startItem, startOffset, endItem, endOffset]: readonly [
    number,
    number,
    number,
    number,
  ],
): PageBox[] {
  const lines: PageBox[] = []
  for (let index = startItem; index <= endItem; index += 1) {
    const item = items[index]
    const box = item?.box
    if (!box || item.text.length === 0) continue
    const from = index === startItem ? startOffset : 0
    const to = index === endItem ? endOffset : item.text.length
    if (to <= from) continue
    const width = box.right - box.left
    const piece: PageBox = {
      left: box.left + (width * from) / item.text.length,
      right: box.left + (width * to) / item.text.length,
      top: box.top,
      bottom: box.bottom,
    }
    const line = lines[lines.length - 1]
    const shared = line
      ? Math.min(line.bottom, piece.bottom) - Math.max(line.top, piece.top)
      : 0
    if (
      line &&
      shared >= Math.min(line.bottom - line.top, piece.bottom - piece.top) / 2
    ) {
      lines[lines.length - 1] = {
        left: Math.min(line.left, piece.left),
        top: Math.min(line.top, piece.top),
        right: Math.max(line.right, piece.right),
        bottom: Math.max(line.bottom, piece.bottom),
      }
    } else {
      lines.push(piece)
    }
  }
  return lines
}
