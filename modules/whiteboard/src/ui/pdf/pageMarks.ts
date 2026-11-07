// A PDF page's annotations painted over its picture, as a reader's
// annotation layer draws them (styles/pdf/annotations.css): a highlight one
// shape over its lines, multiplied into the page — screened into the
// inverted one of a dark theme — and a framed area a box with a faint wash.
// The overview paints them over the pictures it draws
// (../canvas/overviewLayer.ts); the GPU scene's pages have them painted into
// the picture it is handed (../gpu/pdfCards.ts).
//
// The highlights are one path per colour in page fractions, made once per
// list of annotations (`pageMarks`) and drawn through the page's rectangle
// as a transform: a board of annotated pages costs a fill per colour per
// page, not a path rebuilt point by point every frame.

import {
  type AnnotationColor,
  type PdfAnnotation,
  displayColor,
} from '../../domain/pdfAnnotations'

import type { PageBox, PageFrame } from './annotationGeometry'
import { boxesFor, outlinesFor } from './annotationLayer'

export type PageMarks = Readonly<{
  highlights: ReadonlyMap<AnnotationColor, Path2D>
  areas: readonly Readonly<{ color: AnnotationColor; box: PageBox }>[]
}>

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** By the page's list of annotations, then by where its PDF points land. */
const cache = new WeakMap<
  readonly PdfAnnotation[],
  WeakMap<PageFrame, PageMarks>
>()

/** A page's annotations as they are painted, made once per list — a store
 * hands out a new one only when the page's annotations change. Paths are
 * the window's own (`Path2DOf`), like everything else it draws with. */
export function pageMarks(
  annotations: readonly PdfAnnotation[],
  frame: PageFrame,
  Path2DOf: typeof Path2D,
): PageMarks {
  let perFrame = cache.get(annotations)
  if (!perFrame) {
    perFrame = new WeakMap()
    cache.set(annotations, perFrame)
  }
  const cached = perFrame.get(frame)
  if (cached) return cached
  const highlights = new Map<AnnotationColor, Path2D>()
  const areas: PageMarks['areas'][number][] = []
  for (const annotation of annotations) {
    const color = displayColor(annotation.color)
    if (annotation.type === 'area') {
      for (const box of boxesFor(annotation, frame)) areas.push({ color, box })
      continue
    }
    const outline = highlights.get(color) ?? new Path2DOf()
    highlights.set(color, outline)
    for (const points of outlinesFor(annotation, frame)) {
      points.forEach(([x, y], at) => {
        if (at === 0) outline.moveTo(x, y)
        else outline.lineTo(x, y)
      })
      outline.closePath()
    }
  }
  const marks = { highlights, areas }
  perFrame.set(frame, marks)
  return marks
}

/** Paints `marks` over a page whose picture fills `page`, in `colors`. */
export function paintPageMarks(
  ctx: Context2D,
  marks: PageMarks,
  page: Readonly<{ x: number; y: number; w: number; h: number }>,
  colors: Readonly<Record<AnnotationColor, string>>,
  dark: boolean,
): void {
  const alpha = ctx.globalAlpha
  ctx.save()
  if (marks.highlights.size > 0) {
    ctx.save()
    ctx.translate(page.x, page.y)
    ctx.scale(page.w, page.h)
    ctx.globalCompositeOperation = dark ? 'screen' : 'multiply'
    ctx.globalAlpha = alpha * (dark ? 0.4 : 0.45)
    for (const [color, outline] of marks.highlights) {
      ctx.fillStyle = colors[color]
      ctx.fill(outline)
    }
    ctx.restore()
  }
  ctx.lineWidth = 1
  for (const { color, box } of marks.areas) {
    const x = page.x + box.left * page.w
    const y = page.y + box.top * page.h
    const w = (box.right - box.left) * page.w
    const h = (box.bottom - box.top) * page.h
    ctx.fillStyle = colors[color]
    ctx.globalAlpha = alpha * 0.1
    ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = colors[color]
    ctx.globalAlpha = alpha
    ctx.strokeRect(x, y, w, h)
  }
  ctx.restore()
}

/** A page's picture with `marks` painted into it: what the GPU scene draws
 * for an annotated page, which it cannot paint over the way a canvas does. */
export function withPageMarks(
  picture: ImageBitmap,
  marks: PageMarks,
  colors: Readonly<Record<AnnotationColor, string>>,
  dark: boolean,
): ImageBitmap {
  const canvas = new OffscreenCanvas(picture.width, picture.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return picture
  ctx.drawImage(picture, 0, 0)
  paintPageMarks(
    ctx,
    marks,
    { x: 0, y: 0, w: picture.width, h: picture.height },
    colors,
    dark,
  )
  return canvas.transferToImageBitmap()
}
