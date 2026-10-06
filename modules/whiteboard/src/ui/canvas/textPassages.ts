// Passages of text and note cards on screen: where one is in a card as drawn,
// the passage a selection or a pointer names, and the marks on them — the DOM
// half of domain/textAnchor.ts, which knows the card's Markdown source.
//
// A card shows its source rendered (or, being typed into, in an editor that
// hides some of it), so everything read off the screen is matched to the
// source loosely, and a passage of the source found on the screen the same
// way (`findLoose`). What the card has not drawn — a note's lines outside
// its window — cannot be found, and the caller falls back to the whole card.
//
// Marks are CSS highlights (`::highlight`, styles/cards/passages.css): ranges
// painted by the browser over the text without a single element added to the
// card, so a card's rendering is never touched for them. Highlights are
// per-window, so they are set in the card's own window — a popout's too.
//
// Pure DOM helpers; ./canvas.ts decides which cards and anchors.

import type { EdgeAnchor } from '../../domain/fileFormat'
import {
  TEXT_QUOTE_CONTEXT,
  type TextAnchor,
  type TextSpan,
  findLoose,
  resolveTextAnchor,
  snapToWordEdge,
  textAnchorAt,
} from '../../domain/textAnchor'
import type { PassageEnds } from '../pdf/pdfReader'

import type { CardPassagePlacement } from './edgeLayer'

/** The highlight names styles/cards/passages.css paints. */
export const PASSAGE_HIGHLIGHT = {
  mark: 'yolo-whiteboard-passage',
  strong: 'yolo-whiteboard-passage-strong',
  hint: 'yolo-whiteboard-passage-hint',
} as const

/** The blocks a pointer over a card's text names as a whole. */
const BLOCK_SELECTOR =
  'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, .cm-line'

type DisplayedText = Readonly<{
  text: string
  /** Each text node and where its text starts in `text`. */
  nodes: readonly Readonly<{ node: Text; start: number }>[]
}>

/** The text a card's body shows, in document order — only what is drawn:
 * a card being typed into keeps its rendering, hidden, beside the editor,
 * and the same words twice would be found in the copy nobody sees. */
function displayedText(body: HTMLElement): DisplayedText {
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT)
  const shown = new Map<Element, boolean>()
  const isShown = (el: Element | null) => {
    if (!el) return false
    let known = shown.get(el)
    if (known === undefined) {
      known = el.checkVisibility()
      shown.set(el, known)
    }
    return known
  }
  let text = ''
  const nodes: { node: Text; start: number }[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? ''
    if (value.length === 0 || !isShown(node.parentElement)) continue
    nodes.push({ node: node as Text, start: text.length })
    text += value
  }
  return { text, nodes }
}

/** The DOM range of `[start, end)` of a body's displayed text. */
function displayedRange(
  shown: DisplayedText,
  start: number,
  end: number,
  doc: Document,
): Range | null {
  const at = (offset: number, preferNext: boolean) => {
    for (let k = shown.nodes.length - 1; k >= 0; k -= 1) {
      const entry = shown.nodes[k]
      const length = entry.node.nodeValue?.length ?? 0
      if (
        offset > entry.start ||
        (offset === entry.start && (preferNext || k === 0))
      ) {
        return {
          node: entry.node,
          offset: Math.min(offset - entry.start, length),
        }
      }
    }
    return null
  }
  const from = at(start, true)
  const to = at(end, false)
  if (!from || !to) return null
  const range = doc.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  return range
}

/** Where a passage of the source is in a body's displayed text, or null. */
function displayedSpan(
  shown: DisplayedText,
  source: string,
  anchor: TextAnchor,
): TextSpan | null {
  const span = resolveTextAnchor(source, anchor)
  if (!span) return null
  return findLoose(shown.text, source.slice(span[0], span[1]), {
    before: source.slice(Math.max(0, span[0] - TEXT_QUOTE_CONTEXT), span[0]),
    after: source.slice(span[1], span[1] + TEXT_QUOTE_CONTEXT),
  })
}

/** Where a passage of the source is in the body as drawn, or null. */
export function passageRange(
  body: HTMLElement,
  source: string,
  anchor: TextAnchor,
): Range | null {
  const shown = displayedText(body)
  const found = displayedSpan(shown, source, anchor)
  return found
    ? displayedRange(shown, found[0], found[1], body.ownerDocument)
    : null
}

/** Where a passage's first and last characters are on screen, for the
 * handles that move them. */
export function textPassageEnds(
  body: HTMLElement,
  source: string,
  anchor: TextAnchor,
): PassageEnds | null {
  const range = passageRange(body, source, anchor)
  const rects = range
    ? Array.from(range.getClientRects()).filter((rect) => rect.height > 0)
    : []
  if (rects.length === 0) return null
  const first = rects[0]
  const last = rects[rects.length - 1]
  return {
    start: { x: first.left, top: first.top, bottom: first.bottom },
    end: { x: last.right, top: last.top, bottom: last.bottom },
  }
}

/**
 * The passage with one end moved to the character nearest a client point,
 * snapped to a word's edge, the other end held — read on the screen and
 * matched back to the source. Null where the point is on no text the card
 * draws, or the passage cannot be found on it.
 */
export function adjustTextPassage(
  body: HTMLElement,
  source: string,
  anchor: TextAnchor,
  moving: 'start' | 'end',
  clientX: number,
  clientY: number,
): TextAnchor | null {
  const shown = displayedText(body)
  const current = displayedSpan(shown, source, anchor)
  const point = offsetNear(shown, clientX, clientY, body.ownerDocument)
  if (!current || point === null) return null
  const snapped = snapToWordEdge(shown.text, point)
  const held = moving === 'start' ? current[1] : current[0]
  const [start, end] = snapped <= held ? [snapped, held] : [held, snapped]
  if (shown.text.slice(start, end).trim() === '') return null
  const found = findLoose(source, shown.text.slice(start, end), {
    before: shown.text.slice(Math.max(0, start - TEXT_QUOTE_CONTEXT), start),
    after: shown.text.slice(end, end + TEXT_QUOTE_CONTEXT),
  })
  return found ? textAnchorAt(source, found) : null
}

/**
 * The offset in a body's displayed text nearest a client point: among the
 * characters on the line under it, the one whose edge is nearest across.
 */
function offsetNear(
  shown: DisplayedText,
  clientX: number,
  clientY: number,
  doc: Document,
): number | null {
  const range = doc.createRange()
  let best: number | null = null
  let bestDistance = Infinity
  for (const { node, start } of shown.nodes) {
    range.selectNodeContents(node)
    const onLine = Array.from(range.getClientRects()).some(
      (rect) => clientY >= rect.top && clientY <= rect.bottom,
    )
    if (!onLine) continue
    const length = node.nodeValue?.length ?? 0
    for (let k = 0; k < length; k += 1) {
      range.setStart(node, k)
      range.setEnd(node, k + 1)
      const rect = range.getBoundingClientRect()
      if (clientY < rect.top || clientY > rect.bottom || rect.width === 0) {
        continue
      }
      for (const [edge, offset] of [
        [rect.left, start + k],
        [rect.right, start + k + 1],
      ] as const) {
        const distance = Math.abs(clientX - edge)
        if (distance < bestDistance) {
          best = offset
          bestDistance = distance
        }
      }
    }
  }
  return best
}

/**
 * Where a passage is in its card, measured down from the card's top edge in
 * the card's own units (world units — the card is drawn under the camera's
 * scale, which the ratio of its on-screen to its laid-out height undoes), or
 * past the body's top or bottom edge when scrolled out of it.
 */
export function placeTextPassage(
  card: HTMLElement,
  body: HTMLElement,
  source: string,
  anchor: TextAnchor,
): CardPassagePlacement | null {
  const range = passageRange(body, source, anchor)
  if (!range) return null
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.height > 0,
  )
  if (rects.length === 0) return null
  const top = Math.min(...rects.map((rect) => rect.top))
  const bottom = Math.max(...rects.map((rect) => rect.bottom))
  const shown = body.getBoundingClientRect()
  if (bottom <= shown.top) return { state: 'above' }
  if (top >= shown.bottom) return { state: 'below' }
  const cardRect = card.getBoundingClientRect()
  const scale = card.offsetHeight > 0 ? cardRect.height / card.offsetHeight : 0
  if (!(scale > 0)) return null
  return {
    state: 'visible',
    top: (Math.max(top, shown.top) - cardRect.top) / scale,
    bottom: (Math.min(bottom, shown.bottom) - cardRect.top) / scale,
  }
}

/** The passage of the source a selection in a body names, or null when it
 * is not in the body or names nothing the source has. */
export function selectionAnchor(
  body: HTMLElement,
  selection: Selection,
  source: string,
): TextAnchor | null {
  if (selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!body.contains(range.commonAncestorContainer)) return null
  const shown = displayedText(body)
  const offsetOf = (node: Node, offset: number) => {
    const entry = shown.nodes.find((candidate) => candidate.node === node)
    return entry ? entry.start + offset : null
  }
  const start = offsetOf(range.startContainer, range.startOffset)
  const end = offsetOf(range.endContainer, range.endOffset)
  const text = range.toString()
  const found =
    start !== null && end !== null
      ? findLoose(source, shown.text.slice(start, end), {
          before: shown.text.slice(
            Math.max(0, start - TEXT_QUOTE_CONTEXT),
            start,
          ),
          after: shown.text.slice(end, end + TEXT_QUOTE_CONTEXT),
        })
      : findLoose(source, text)
  return found ? textAnchorAt(source, found) : null
}

/** The block of a body under a client point — a paragraph, a heading, a list
 * item — as a passage of the source, or null where there is none. */
export function blockAnchorAt(
  body: HTMLElement,
  clientX: number,
  clientY: number,
  source: string,
): TextAnchor | null {
  let best: HTMLElement | null = null
  let bestArea = Infinity
  for (const el of Array.from(
    body.querySelectorAll<HTMLElement>(BLOCK_SELECTOR),
  )) {
    const rect = el.getBoundingClientRect()
    if (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      continue
    }
    // The innermost: a list item rather than the quote it is in.
    const area = rect.width * rect.height
    if (area < bestArea) {
      best = el
      bestArea = area
    }
  }
  const text = best?.textContent ?? ''
  if (text.trim() === '') return null
  const found = findLoose(source, text)
  if (!found) return null
  // A block ends with its line: the stop after its last word is its too.
  const lineEnd = source.indexOf('\n', found[1])
  return textAnchorAt(source, [
    found[0],
    lineEnd === -1 ? source.length : lineEnd,
  ])
}

/** Whether a client point is on a passage as drawn. */
export function rangeContains(
  range: Range,
  clientX: number,
  clientY: number,
): boolean {
  return Array.from(range.getClientRects()).some(
    (rect) =>
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom,
  )
}

/** Paints `ranges` under one of the passage highlights in `doc`'s window,
 * replacing what it painted before; no ranges clears it. */
export function paintPassages(
  doc: Document,
  name: (typeof PASSAGE_HIGHLIGHT)[keyof typeof PASSAGE_HIGHLIGHT],
  ranges: readonly Range[],
): void {
  const win = doc.defaultView as
    | (Window & { CSS?: typeof CSS; Highlight?: typeof Highlight })
    | null
  // A Map of name to highlight; the target's lib knows it only as an empty
  // interface.
  const registry = win?.CSS?.highlights as Map<string, Highlight> | undefined
  if (!registry || !win?.Highlight) return
  if (ranges.length === 0) {
    registry.delete(name)
    return
  }
  registry.set(name, new win.Highlight(...ranges))
}

/** Whether an anchor is one this module places. */
export function isTextAnchor(anchor: EdgeAnchor): anchor is TextAnchor {
  return anchor.kind === 'text'
}
