// Pure geometry for the PDF reader (./pdfReader.ts): where each page sits in
// the continuous column, which pages are near the reader's viewport, how a
// scroll offset reads as a reading position and back, and when a page's
// bitmap is sharp enough to keep. No DOM, no host — every number here is in
// the reader's own layout pixels, which no transform around the reader (the
// board's camera) ever changes.

/** A page's size at scale 1, in PDF units, its rotation applied. */
export type PageSize = Readonly<{ width: number; height: number }>

/**
 * Every page laid out at the reader's width, top to bottom.
 *
 * Each page is fitted to the width on its own (`scales[i]`), so a landscape
 * page in a portrait paper is as wide as its neighbours rather than wider
 * than the card. The scale is also what the page is drawn and its text laid
 * out at — CSS pixels per PDF unit — so the three always agree.
 */
export type ReaderLayout = Readonly<{
  pageWidth: number
  scales: readonly number[]
  tops: readonly number[]
  heights: readonly number[]
  totalHeight: number
}>

export type ReaderMetrics = Readonly<{
  /** Space around the column: above the first page, below the last, and on
   * both sides. */
  padding: number
  /** Space between consecutive pages. */
  gap: number
}>

/** Pages run edge to edge: the card's own frame is the paper's edge, and a
 * margin inside it read as a second frame. Only the seam between pages stays,
 * as the one mark of a page turn. */
export const READER_METRICS: ReaderMetrics = Object.freeze({
  padding: 0,
  gap: 8,
})

export function layoutPages(
  sizes: readonly PageSize[],
  viewportWidth: number,
  metrics: ReaderMetrics = READER_METRICS,
): ReaderLayout {
  const pageWidth = Math.max(1, viewportWidth - 2 * metrics.padding)
  const scales: number[] = []
  const tops: number[] = []
  const heights: number[] = []
  let y = metrics.padding
  sizes.forEach((size, index) => {
    const scale = pageWidth / Math.max(size.width, 1e-6)
    if (index > 0) y += metrics.gap
    scales.push(scale)
    tops.push(y)
    heights.push(size.height * scale)
    y += size.height * scale
  })
  return {
    pageWidth,
    scales,
    tops,
    heights,
    totalHeight: y + metrics.padding,
  }
}

/** First and last page index (0-based, inclusive) that intersect the band. */
export type PageRange = Readonly<{ first: number; last: number }>

/**
 * The pages that intersect `[scrollTop - overscan, scrollTop + height +
 * overscan]`, or null for a layout with no pages. Binary search, because a
 * long document is laid out as thousands of pages and this runs on every
 * scroll frame.
 */
export function pagesInBand(
  layout: ReaderLayout,
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): PageRange | null {
  const count = layout.tops.length
  if (count === 0) return null
  const from = scrollTop - overscan
  const to = scrollTop + viewportHeight + overscan
  // The first page whose bottom edge is below `from`.
  let lo = 0
  let hi = count - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (layout.tops[mid] + layout.heights[mid] <= from) lo = mid + 1
    else hi = mid
  }
  const first = lo
  // The last page whose top edge is above `to`.
  lo = first
  hi = count - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (layout.tops[mid] < to) lo = mid
    else hi = mid - 1
  }
  return { first, last: Math.max(first, lo) }
}

/**
 * Where the reader is, as a 1-based fractional page: the page under its top
 * edge, plus how far down that page the edge is. The gap below a page counts
 * as the bottom of that page, and the padding above the first as its top, so
 * every offset has an answer.
 */
export function positionAt(layout: ReaderLayout, scrollTop: number): number {
  const count = layout.tops.length
  if (count === 0) return 1
  let lo = 0
  let hi = count - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (layout.tops[mid] <= scrollTop) lo = mid
    else hi = mid - 1
  }
  const height = layout.heights[lo]
  const fraction =
    height > 0 ? clamp((scrollTop - layout.tops[lo]) / height, 0, 1) : 0
  // A position of exactly N+1 would name the next page's top, which is a
  // different place from the bottom of this one's gap.
  return lo + 1 + Math.min(fraction, 0.9999)
}

/** The scroll offset that puts `position` (see `positionAt`) at the top. */
export function scrollTopFor(layout: ReaderLayout, position: number): number {
  const count = layout.tops.length
  if (count === 0 || !Number.isFinite(position)) return 0
  const clamped = clamp(position, 1, count + 0.9999)
  const index = Math.floor(clamped) - 1
  const fraction = clamped - Math.floor(clamped)
  return layout.tops[index] + fraction * layout.heights[index]
}

/**
 * The page a typed value names, clamped into the document, or null when it
 * names none — the page field accepts only what a person would type into a
 * page field.
 */
export function parsePageInput(
  value: string,
  pageCount: number,
): number | null {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed) || pageCount < 1) return null
  return clamp(Number.parseInt(trimmed, 10), 1, pageCount)
}

/**
 * Whether a bitmap drawn at `drawnRatio` device pixels per layout pixel
 * should be redrawn now that the page wants `wantedRatio`.
 *
 * Asymmetric on purpose. Zooming in past what was drawn blurs the text, so a
 * modest increase already earns a redraw. Zooming out leaves a sharper
 * bitmap than needed, which looks right and only costs memory, so it is
 * redrawn only once it is holding far more pixels than it shows.
 */
export function needsSharperBitmap(
  drawnRatio: number,
  wantedRatio: number,
): boolean {
  if (!(drawnRatio > 0)) return true
  return wantedRatio > drawnRatio * 1.1 || wantedRatio < drawnRatio * 0.5
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
