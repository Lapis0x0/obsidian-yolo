/**
 * Pure layout math for the interactive PDF surface. Nothing here touches the
 * DOM or pdf.js, so it can be unit-tested from the host test suite.
 */

/** An axis-aligned box in viewport (CSS pixel, top-left origin) space. */
export type ViewportBox = Readonly<{
  left: number
  top: number
  right: number
  bottom: number
}>

/**
 * pdf.js viewer's own default `maxCanvasPixels` (2^25): large enough for a
 * letter page at ~8x on a 2x display, small enough to stay clear of the
 * browser's canvas area limit, where an oversized canvas silently renders
 * blank.
 */
export const MAX_CANVAS_PIXELS = 2 ** 25

/**
 * The backing-store pixel ratio to render a `width` x `height` CSS-pixel box
 * at: the requested ratio, lowered just enough that the canvas stays within
 * `maxPixels`.
 */
export function capPixelRatio(
  width: number,
  height: number,
  requested: number,
  maxPixels: number = MAX_CANVAS_PIXELS,
): number {
  const ratio = Number.isFinite(requested) && requested > 0 ? requested : 1
  const area = width * height * ratio * ratio
  if (area <= maxPixels || area === 0) return ratio
  return Math.sqrt(maxPixels / (width * height))
}

/**
 * Folds the per-fragment boxes of a text selection into one box per visual
 * line, in reading order.
 *
 * A selection yields one box per text-layer span (and often several per
 * span), so a single highlighted line arrives as dozens of abutting boxes.
 * Two boxes belong to the same line when they overlap vertically by at least
 * half the shorter box — which keeps superscripts and mixed font sizes on
 * their line — and are horizontally close; the gap limit is what keeps the
 * same baseline in two columns from merging across the gutter.
 */
export function mergeBoxesIntoLines(
  boxes: readonly ViewportBox[],
): ViewportBox[] {
  const lines: ViewportBox[] = []
  for (const box of boxes) {
    if (!(box.right > box.left) || !(box.bottom > box.top)) continue
    const index = lines.findIndex((line) => belongsToLine(line, box))
    if (index === -1) {
      lines.push(box)
      continue
    }
    const line = lines[index]
    lines[index] = {
      left: Math.min(line.left, box.left),
      top: Math.min(line.top, box.top),
      right: Math.max(line.right, box.right),
      bottom: Math.max(line.bottom, box.bottom),
    }
  }
  return lines
}

function belongsToLine(line: ViewportBox, box: ViewportBox): boolean {
  const overlap =
    Math.min(line.bottom, box.bottom) - Math.max(line.top, box.top)
  const shorter = Math.min(line.bottom - line.top, box.bottom - box.top)
  if (overlap < shorter / 2) return false
  const gap = Math.max(box.left - line.right, line.left - box.right, 0)
  return gap <= Math.max(line.bottom - line.top, box.bottom - box.top)
}
