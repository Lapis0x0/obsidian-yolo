// Pure geometry and text anchoring for PDF annotations (../../domain/
// pdfAnnotations.ts): where an annotation is on its page, which one a click
// landed on, and how a highlight's text is found again.
//
// Boxes are fractions of the page (0..1 across, 0..1 down, in the page as it
// is shown — rotation applied). That is the one space both the drawing and
// the hit test can use whatever size the page is laid out at: a highlight
// layer positioned in percentages never has to be recomputed when a reader
// is resized or a card zoomed, and a click is turned into the same space by
// dividing by the page element's on-screen size — a ratio, which a board
// camera's scale does not distort.
//
// No DOM, no host: the page's PDF-to-viewport transform comes in as a
// function (the engine's `page.toViewportPoint` at scale 1).

import type {
  HighlightAnchor,
  PdfAnnotation,
  PdfRectTuple,
  SelectionTuple,
} from '../../domain/pdfAnnotations'

import {
  type SearchTextItem,
  UNSPACED_SCRIPT,
  buildPageSearchIndex,
  findInPage,
  normalizeQuery,
} from './textSearch'

export type PagePoint = readonly [x: number, y: number]

/** A box on a page as fractions of its shown width and height. */
export type PageBox = Readonly<{
  left: number
  top: number
  right: number
  bottom: number
}>

/** A page's PDF-to-viewport transform at scale 1, and the viewport's size. */
export type PageFrame = Readonly<{
  width: number
  height: number
  toViewport: (point: PagePoint) => PagePoint
}>

/** How much characters of context a quote keeps either side. */
export const QUOTE_CONTEXT_LENGTH = 32

/** The page boxes an annotation covers: one per highlighted line, or the
 * framed area. */
export function annotationBoxes(
  annotation: PdfAnnotation,
  frame: PageFrame,
): PageBox[] {
  if (annotation.type === 'area')
    return [rectBox(annotation.anchor.rect, frame)]
  return quadBoxes(annotation.anchor.quadPoints, frame)
}

/** Eight numbers per quad, each quad's bounding box on the page. */
export function quadBoxes(
  quadPoints: readonly number[],
  frame: PageFrame,
): PageBox[] {
  const boxes: PageBox[] = []
  for (let at = 0; at + 8 <= quadPoints.length; at += 8) {
    const corners: PagePoint[] = []
    for (let k = 0; k < 8; k += 2) {
      corners.push(
        frame.toViewport([quadPoints[at + k], quadPoints[at + k + 1]]),
      )
    }
    boxes.push(boundingBox(corners, frame))
  }
  return boxes
}

export function rectBox(rect: PdfRectTuple, frame: PageFrame): PageBox {
  return boundingBox(
    [
      frame.toViewport([rect[0], rect[1]]),
      frame.toViewport([rect[2], rect[3]]),
    ],
    frame,
  )
}

/**
 * A highlight's boxes as the outline of one shape, so it is filled once and
 * framed once: a quad per text item overlaps its neighbours on the same line
 * (a bold word is an item of its own) and the lines above and below, and
 * each overlap painted separately shows as a darker seam.
 *
 * The boxes are merged into lines (a box sharing most of its height with a
 * line is on it), and lines one above the other, overlapping across and
 * close enough down, are made to meet halfway between them. Each run of
 * lines that meet is one stepped polygon; a run is broken where the lines
 * do not overlap across (a column break) or leave a real gap (a paragraph
 * skipped). Points are page fractions, clockwise from the top left.
 */
export function highlightOutlines(boxes: readonly PageBox[]): PagePoint[][] {
  const lines: { left: number; top: number; right: number; bottom: number }[] =
    []
  const byMiddle = [...boxes].sort(
    (a, b) => a.top + a.bottom - (b.top + b.bottom),
  )
  for (const box of byMiddle) {
    const line = lines[lines.length - 1]
    const shared = line
      ? Math.min(line.bottom, box.bottom) - Math.max(line.top, box.top)
      : 0
    const least = line
      ? Math.min(line.bottom - line.top, box.bottom - box.top)
      : 0
    if (line && shared >= least / 2) {
      line.left = Math.min(line.left, box.left)
      line.top = Math.min(line.top, box.top)
      line.right = Math.max(line.right, box.right)
      line.bottom = Math.max(line.bottom, box.bottom)
    } else {
      lines.push({ ...box })
    }
  }

  const runs: (typeof lines)[] = []
  for (const line of lines) {
    const run = runs[runs.length - 1]
    const above = run?.[run.length - 1]
    const across = above
      ? Math.min(above.right, line.right) - Math.max(above.left, line.left)
      : 0
    const gap = above ? line.top - above.bottom : 0
    const height = above
      ? Math.min(above.bottom - above.top, line.bottom - line.top)
      : 0
    if (run && above && across > 0 && gap < height * LINE_JOIN_GAP) {
      const meet = (above.bottom + line.top) / 2
      above.bottom = meet
      line.top = meet
      run.push(line)
    } else {
      runs.push([line])
    }
  }

  return runs.map((run) => {
    const right: PagePoint[] = []
    const left: PagePoint[] = []
    for (const line of run) {
      right.push([line.right, line.top], [line.right, line.bottom])
      left.push([line.left, line.top], [line.left, line.bottom])
    }
    // Where two lines end at the same x their corners coincide; a point
    // repeated says nothing.
    const points: PagePoint[] = [
      [run[0].left, run[0].top],
      ...right,
      ...left.reverse(),
    ]
    return points.filter(
      ([x, y], at) =>
        at === 0 || x !== points[at - 1][0] || y !== points[at - 1][1],
    )
  })
}

/** How far apart, as a share of their height, two lines may be and still be
 * drawn as one block. */
const LINE_JOIN_GAP = 0.6

function boundingBox(points: readonly PagePoint[], frame: PageFrame): PageBox {
  const xs = points.map(([x]) => x / frame.width)
  const ys = points.map(([, y]) => y / frame.height)
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  }
}

/**
 * The annotation a click at `point` (page fractions) means: of those with a
 * box under it — grown by `slop` on every side, so a thin line is not a
 * pixel-hunt — the one whose box is smallest, which is the one drawn on top
 * of the others there (a highlight inside a framed figure is the highlight).
 */
export function hitTestAnnotations(
  entries: readonly Readonly<{ id: string; boxes: readonly PageBox[] }>[],
  point: PagePoint,
  slop = 0,
): string | null {
  const [x, y] = point
  let best: string | null = null
  let bestArea = Number.POSITIVE_INFINITY
  for (const entry of entries) {
    for (const box of entry.boxes) {
      if (
        x < box.left - slop ||
        x > box.right + slop ||
        y < box.top - slop ||
        y > box.bottom + slop
      ) {
        continue
      }
      const area = (box.right - box.left) * (box.bottom - box.top)
      if (area < bestArea) {
        bestArea = area
        best = entry.id
      }
    }
  }
  return best
}

/** The page text as one string with a line break after every item that
 * ends a line, and where each item starts in it. */
function pageText(items: readonly SearchTextItem[]): {
  text: string
  starts: number[]
} {
  let text = ''
  const starts: number[] = []
  for (const item of items) {
    starts.push(text.length)
    text += item.text
    if (item.endsLine) text += '\n'
  }
  return { text, starts }
}

function tupleSpan(
  starts: readonly number[],
  items: readonly SearchTextItem[],
  [startItem, startOffset, endItem, endOffset]: SelectionTuple,
): readonly [number, number] | null {
  if (
    startItem >= items.length ||
    endItem >= items.length ||
    startOffset > items[startItem].text.length ||
    endOffset > items[endItem].text.length
  ) {
    return null
  }
  const start = starts[startItem] + startOffset
  const end = starts[endItem] + endOffset
  return end > start ? [start, end] : null
}

/** A little of the page's text before and after a selection: what tells two
 * occurrences of the same quote apart when it has to be found again. */
export function quoteContext(
  items: readonly SearchTextItem[],
  tuple: SelectionTuple,
  length = QUOTE_CONTEXT_LENGTH,
): { prefix: string; suffix: string } {
  const { text, starts } = pageText(items)
  const span = tupleSpan(starts, items, tuple)
  if (!span) return { prefix: '', suffix: '' }
  return {
    prefix: text.slice(Math.max(0, span[0] - length), span[0]),
    suffix: text.slice(span[1], span[1] + length),
  }
}

/**
 * Where a highlight's text is on its page now, as a selection tuple.
 *
 * The stored tuple, when the text it names is still the quote — the common
 * case, and exact. Otherwise the quote is searched for the way in-document
 * search matches (case-, width- and whitespace-forgiving), and of several
 * occurrences the one whose surroundings best agree with the stored context
 * wins; ties go to the first. Null when the quote is not on the page.
 */
export function resolveHighlightSelection(
  items: readonly SearchTextItem[],
  anchor: HighlightAnchor,
): SelectionTuple | null {
  const quote = foldForAnchor(anchor.quote.exact)
  if (quote === '') return null
  const { text, starts } = pageText(items)
  if (anchor.selection) {
    const span = tupleSpan(starts, items, anchor.selection)
    if (span && foldForAnchor(text.slice(span[0], span[1])) === quote) {
      return anchor.selection
    }
  }
  const matches = findInPage(buildPageSearchIndex(items), quote)
  if (matches.length <= 1) return matches[0] ?? null
  const prefix = foldForAnchor(anchor.quote.prefix ?? '')
  const suffix = foldForAnchor(anchor.quote.suffix ?? '')
  let best = matches[0]
  let bestScore = -1
  for (const match of matches) {
    const span = tupleSpan(starts, items, match)
    if (!span) continue
    const before = foldForAnchor(
      text.slice(Math.max(0, span[0] - QUOTE_CONTEXT_LENGTH * 2), span[0]),
    )
    const after = foldForAnchor(
      text.slice(span[1], span[1] + QUOTE_CONTEXT_LENGTH * 2),
    )
    const score =
      commonSuffixLength(before, prefix) + commonPrefixLength(after, suffix)
    if (score > bestScore) {
      bestScore = score
      best = match
    }
  }
  return best
}

/**
 * Text folded the way the search index folds a page, including its one
 * asymmetry: a line break next to a CJK character joins the two lines with
 * nothing. A quote taken from a selection spells a line break as a newline,
 * which `normalizeQuery` alone would turn into a space the index never has.
 */
export function foldForAnchor(text: string): string {
  const joined = text.replace(
    /\s*\n\s*/g,
    (run: string, at: number, whole: string) => {
      const before = whole[at - 1] ?? ''
      const after = whole[at + run.length] ?? ''
      return UNSPACED_SCRIPT.test(before) || UNSPACED_SCRIPT.test(after)
        ? ''
        : ' '
    },
  )
  return normalizeQuery(joined)
}

function commonPrefixLength(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1
  return n
}

function commonSuffixLength(a: string, b: string): number {
  let n = 0
  while (
    n < a.length &&
    n < b.length &&
    a[a.length - 1 - n] === b[b.length - 1 - n]
  ) {
    n += 1
  }
  return n
}
