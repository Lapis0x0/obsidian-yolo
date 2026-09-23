/**
 * Writing annotations into a copy of a PDF as standard PDF annotations, so
 * any PDF viewer shows them.
 *
 * Coordinates arrive in PDF user space — what pdf.js's viewport
 * `convertToPdfPoint` returns, which already accounts for a MediaBox/CropBox
 * whose origin is not (0, 0) and for the page's /Rotate — and annotation
 * geometry (/Rect, /QuadPoints, appearance streams) is defined in that same
 * space, so nothing is converted: a viewer rotates an annotation with its page
 * as it rotates the page's own content.
 *
 * Every annotation carries its own appearance stream (/AP /N). pdf.js and
 * PDFium synthesize one for a Highlight or Square that has none, but not every
 * viewer does, and the synthesized ones differ; with our own stream the marks
 * look the same everywhere. A highlight is painted opaque with a multiply
 * blend (a highlighter pen: ink stays dark beneath it). Transparency is left
 * to the caller's choice of a lighter colour rather than written as /CA:
 * Acrobat applies an annotation's /CA on top of its appearance while pdf.js
 * and PDFium do not, so any opacity would render differently from viewer to
 * viewer.
 *
 * The pure parts (validation, geometry, appearance content) are exported for
 * tests; `addAnnotationsToPdf` is the only part that touches pdf-lib.
 */

import { PDFDocument, PDFHexString, type PDFPage, PDFString } from 'pdf-lib'

import type {
  PdfAnnotationInput,
  PdfRect,
} from '../../../src/core/runtime-components/contracts'

type Rgb = readonly [r: number, g: number, b: number]
/** What pdf-lib's `context.obj` turns into PDF objects: strings become
 * names, arrays arrays, plain objects dictionaries; `undefined` entries are
 * left out. */
type Literal = NonNullable<Parameters<PDFDocument['context']['flateStream']>[1]>

const DEFAULT_BORDER_WIDTH = 1
/** /F Print: shown on screen and printed. */
const FLAG_PRINT = 4

/** `#rrggbb` as PDF colour components (0–1). */
export function parseHexColor(color: string): Rgb {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color)
  if (!match)
    throw new TypeError(`PDF annotation colour "${color}" is not #rrggbb`)
  return [1, 2, 3].map(
    (index) => parseInt(match[index], 16) / 255,
  ) as unknown as Rgb
}

/** The smallest `[x1, y1, x2, y2]` (x1 < x2, y1 < y2) holding every point. */
export function quadPointsBounds(quadPoints: readonly number[]): PdfRect {
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (let index = 0; index < quadPoints.length; index += 2) {
    const x = quadPoints[index]
    const y = quadPoints[index + 1]
    x1 = Math.min(x1, x)
    y1 = Math.min(y1, y)
    x2 = Math.max(x2, x)
    y2 = Math.max(y2, y)
  }
  return [x1, y1, x2, y2]
}

export function normalizeRect([ax, ay, bx, by]: PdfRect): PdfRect {
  return [
    Math.min(ax, bx),
    Math.min(ay, by),
    Math.max(ax, bx),
    Math.max(ay, by),
  ]
}

/**
 * The content of a highlight's appearance stream: every line's quad as one
 * filled path, so where two lines' quads overlap the colour is multiplied
 * in once, not twice. The corners are taken top-left, top-right,
 * bottom-right, bottom-left — around the quad, not across it.
 */
export function highlightAppearance(
  quadPoints: readonly number[],
  color: Rgb,
): string {
  const ops = ['/GS0 gs', `${formatColor(color)} rg`]
  for (let index = 0; index < quadPoints.length; index += 8) {
    const q = quadPoints.slice(index, index + 8).map(formatNumber)
    ops.push(
      `${q[0]} ${q[1]} m`,
      `${q[2]} ${q[3]} l`,
      `${q[6]} ${q[7]} l`,
      `${q[4]} ${q[5]} l`,
      'h',
    )
  }
  ops.push('f')
  return ops.join('\n')
}

/** A Square's /Rect: the framed area grown by the border on every side, so
 * the border runs outside the area rather than over what it frames. */
export function squareRect(rect: PdfRect, borderWidth: number): PdfRect {
  const [x1, y1, x2, y2] = normalizeRect(rect)
  return [
    x1 - borderWidth,
    y1 - borderWidth,
    x2 + borderWidth,
    y2 + borderWidth,
  ]
}

/** The outline, stroked on the centre line of the band between `rect` and
 * `squareRect(rect)` — within /Rect, where a viewer drawing the border from
 * /BS itself would put it too. */
export function squareAppearance(
  rect: PdfRect,
  borderWidth: number,
  color: Rgb,
): string {
  const [x1, y1, x2, y2] = normalizeRect(rect)
  const half = borderWidth / 2
  return [
    `${formatNumber(borderWidth)} w`,
    `${formatColor(color)} RG`,
    [x1 - half, y1 - half, x2 - x1 + borderWidth, y2 - y1 + borderWidth]
      .map(formatNumber)
      .join(' ') + ' re',
    'S',
  ].join('\n')
}

/** Throws on anything that would not make a well-formed annotation. */
export function validateAnnotation(
  annotation: PdfAnnotationInput,
  pageCount: number,
): void {
  const { page, color } = annotation
  if (!(Number.isInteger(page) && page >= 1 && page <= pageCount)) {
    throw new RangeError(
      `PDF annotation page ${page} is outside 1-${pageCount}`,
    )
  }
  parseHexColor(color)
  for (const key of ['contents', 'author', 'id'] as const) {
    const value = annotation[key]
    if (value !== undefined && typeof value !== 'string') {
      throw new TypeError(`PDF annotation ${key} must be a string`)
    }
  }
  for (const key of ['createdAt', 'modifiedAt'] as const) {
    const value = annotation[key]
    if (value !== undefined && Number.isNaN(Date.parse(value))) {
      throw new TypeError(`PDF annotation ${key} "${value}" is not a date`)
    }
  }
  if (annotation.type === 'highlight') {
    const { quadPoints } = annotation
    if (
      !Array.isArray(quadPoints) ||
      quadPoints.length === 0 ||
      quadPoints.length % 8 !== 0 ||
      !quadPoints.every(Number.isFinite)
    ) {
      throw new TypeError(
        'PDF highlight quadPoints must be a non-empty list of 8 numbers per line',
      )
    }
    return
  }
  if (annotation.type === 'square') {
    const { rect, borderWidth } = annotation
    if (
      !Array.isArray(rect) ||
      rect.length !== 4 ||
      !rect.every(Number.isFinite)
    ) {
      throw new TypeError('PDF square rect must be four numbers')
    }
    if (
      borderWidth !== undefined &&
      !(Number.isFinite(borderWidth) && borderWidth > 0)
    ) {
      throw new TypeError('PDF square borderWidth must be a positive number')
    }
    return
  }
  throw new TypeError(
    `PDF annotation type "${String((annotation as { type: unknown }).type)}" is not supported`,
  )
}

export async function addAnnotationsToPdf(
  bytes: Uint8Array,
  annotations: readonly PdfAnnotationInput[],
): Promise<Uint8Array> {
  // Loaded from a copy: pdf-lib parses in place, and the caller's bytes are
  // not ours to touch. An encrypted document is refused here — pdf-lib cannot
  // write one back — rather than saved with its strings garbled.
  const doc = await PDFDocument.load(bytes.slice(), { updateMetadata: false })
  const pages = doc.getPages()
  for (const annotation of annotations) {
    validateAnnotation(annotation, pages.length)
  }
  for (const annotation of annotations) {
    addAnnotation(doc, pages[annotation.page - 1], annotation)
  }
  return await doc.save({ useObjectStreams: false })
}

function addAnnotation(
  doc: PDFDocument,
  page: PDFPage,
  annotation: PdfAnnotationInput,
): void {
  const { context } = doc
  const color = parseHexColor(annotation.color)
  const text = (value: string | undefined) =>
    value ? PDFHexString.fromText(value) : undefined
  const date = (value: string | undefined) =>
    value ? PDFString.fromDate(new Date(value)) : undefined

  let rect: PdfRect
  let appearance: string
  let subtype: Literal
  let resources: Literal | undefined
  if (annotation.type === 'highlight') {
    rect = quadPointsBounds(annotation.quadPoints)
    appearance = highlightAppearance(annotation.quadPoints, color)
    resources = { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply' } } }
    subtype = {
      Subtype: 'Highlight',
      QuadPoints: [...annotation.quadPoints],
      Border: [0, 0, 0],
    }
  } else {
    const width = annotation.borderWidth ?? DEFAULT_BORDER_WIDTH
    rect = squareRect(annotation.rect, width)
    appearance = squareAppearance(annotation.rect, width, color)
    subtype = { Subtype: 'Square', BS: { Type: 'Border', W: width, S: 'S' } }
  }

  const appearanceRef = context.register(
    context.flateStream(appearance, {
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: [...rect],
      Resources: resources,
    }),
  )
  const dict = context.obj({
    Type: 'Annot',
    ...subtype,
    Rect: [...rect],
    C: [...color],
    F: FLAG_PRINT,
    P: page.ref,
    AP: { N: appearanceRef },
    Contents: text(annotation.contents),
    T: text(annotation.author),
    NM: text(annotation.id),
    CreationDate: date(annotation.createdAt),
    M: date(annotation.modifiedAt ?? annotation.createdAt),
  })
  // After whatever the page already has: existing annotations stay as they
  // are, and ours draw above them.
  page.node.addAnnot(context.register(dict))
}

function formatColor(color: Rgb): string {
  return color.map(formatNumber).join(' ')
}

/** Up to four decimals, no exponent, no trailing zeros. */
function formatNumber(value: number): string {
  const fixed = value.toFixed(4)
  const trimmed = fixed.replace(/\.?0+$/, '')
  return trimmed === '-0' ? '0' : trimmed
}
