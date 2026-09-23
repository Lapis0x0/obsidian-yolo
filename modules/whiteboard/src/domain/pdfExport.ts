// What the annotations of a PDF (./pdfAnnotations.ts) become when they are
// written into a copy of it as standard PDF annotations — the records the
// host's `pdf.addAnnotations` takes.
//
// The geometry passes through unchanged: the annotation file already keeps
// PDF user-space points and highlight quads in /QuadPoints order. Only the
// colours are decided here. A PDF has no theme, so each palette name is
// written as the colour the board draws it with by default (the fallbacks
// in style.css). A highlight is laid on the page the way the reader lays it —
// the colour at HIGHLIGHT_STRENGTH over the page, multiplied — but as an
// opaque, lighter colour, which multiplied onto the page gives exactly the
// same result on any background: `page × (1 − s + s·c)` either way. That
// keeps the look identical in every viewer, whether or not it would honour
// an opacity. An area is framed in the full colour, with no fill, so what
// it frames reads as it is.
//
// Pure: no DOM, no host.

import {
  type AnnotationColor,
  type PdfAnnotation,
  type PdfRectTuple,
  displayColor,
} from './pdfAnnotations'

/** style.css's fallback RGB for each palette name. */
export const ANNOTATION_RGB: Readonly<
  Record<AnnotationColor, readonly [number, number, number]>
> = {
  yellow: [224, 172, 0],
  green: [8, 185, 78],
  blue: [8, 109, 221],
  pink: [213, 57, 132],
  purple: [120, 82, 238],
}

/** How much of the colour a highlight lays over the page (style.css's
 * `.yolo-whiteboard-pdf-mark` mix). */
export const HIGHLIGHT_STRENGTH = 0.45
/** An area's frame, in PDF units: the reader's 2 CSS px border at the
 * page's natural size is 1.5pt. */
export const AREA_BORDER_WIDTH = 1.5

export type ExportedPdfAnnotation = Readonly<
  (
    | { type: 'highlight'; quadPoints: readonly number[] }
    | { type: 'square'; rect: PdfRectTuple; borderWidth: number }
  ) & {
    page: number
    color: string
    contents?: string
    id: string
    createdAt: string
    modifiedAt: string
  }
>

export function toExportedAnnotations(
  annotations: readonly PdfAnnotation[],
): ExportedPdfAnnotation[] {
  return annotations.map((annotation) => {
    const base = {
      page: annotation.anchor.page,
      id: annotation.id,
      createdAt: annotation.createdAt,
      modifiedAt: annotation.updatedAt,
      ...(annotation.comment ? { contents: annotation.comment } : {}),
    }
    const rgb = ANNOTATION_RGB[displayColor(annotation.color)]
    if (annotation.type === 'highlight') {
      return {
        ...base,
        type: 'highlight',
        quadPoints: annotation.anchor.quadPoints,
        color: toHex(tint(rgb, HIGHLIGHT_STRENGTH)),
      }
    }
    return {
      ...base,
      type: 'square',
      rect: annotation.anchor.rect,
      borderWidth: AREA_BORDER_WIDTH,
      color: toHex(rgb),
    }
  })
}

/** The opaque colour that looks like `rgb` laid over white at `strength`. */
export function tint(
  rgb: readonly [number, number, number],
  strength: number,
): [number, number, number] {
  return rgb.map((c) => Math.round(255 - strength * (255 - c))) as [
    number,
    number,
    number,
  ]
}

export function toHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`
}
