// Drawing a page's annotations (../../domain/pdfAnnotations.ts) into the
// layer each page of a reader (./pdfReader.ts) carries between its picture
// and its text layer.
//
// Positioned in percentages of the page (./annotationGeometry.ts explains the
// space), so a layer never has to be redrawn for a resize or a zoom — only
// when the page's annotations change. A framed area is a box; a highlight is
// one shape over all its lines (`highlightOutlines`), an SVG stretched over
// the page, filled once and — while active — outlined once. The layer takes no pointer
// events: the text layer above it has to keep receiving the presses that
// select text, so the reader finds which annotation a click meant by
// geometry (`hitTestAnnotations`) instead of by event target.
//
// Not the CSS Custom Highlight API the search uses: those ranges exist only
// on pages with a text layer (a card that is not being read has none), and
// an area annotation is not a range of text at all.

import { type PdfAnnotation, displayColor } from '../../domain/pdfAnnotations'

import {
  type PageBox,
  type PageFrame,
  type PagePoint,
  annotationBoxes,
  highlightOutlines,
} from './annotationGeometry'

const SVG_NS = 'http://www.w3.org/2000/svg'
const MARK_CLASS = 'yolo-whiteboard-pdf-mark'
/** A highlight's fill, and the outline drawn over it while it is active:
 * two layers, since the fill is blended into the page and the outline is
 * not. */
const HIGHLIGHT_CLASS = 'yolo-whiteboard-pdf-highlight'
const HIGHLIGHT_OUTLINE_CLASS = 'yolo-whiteboard-pdf-highlight-outline'
/** What an annotation is measured by and marked active on. */
const SHAPE_SELECTOR = `.${MARK_CLASS}, .${HIGHLIGHT_CLASS} path`
const MARK_AREA_CLASS = 'yolo-whiteboard-pdf-mark-area'
const MARK_ACTIVE_CLASS = 'yolo-whiteboard-pdf-mark-active'
/** How far down its last line a highlight's dot sits: low, near where the
 * words stand, rather than in the line's middle. */
const NOTE_LINE_FRACTION = 0.95
/** A commented annotation's dot. */
export const NOTE_CLASS = 'yolo-whiteboard-pdf-mark-note'

/** The class that paints something in an annotation colour (style.css sets
 * `--yolo-whiteboard-annotation` from it). */
export function annotationColorClass(color: string): string {
  return `yolo-whiteboard-annotation-${displayColor(color)}`
}

/** Annotations are immutable values, so their boxes on a page can be kept
 * for as long as the value lives. Keyed per frame too: the same annotation
 * is on the same page in every reader, but each reader has its own page
 * object. */
const boxCache = new WeakMap<PdfAnnotation, WeakMap<PageFrame, PageBox[]>>()

export function boxesFor(
  annotation: PdfAnnotation,
  frame: PageFrame,
): PageBox[] {
  let perFrame = boxCache.get(annotation)
  if (!perFrame) {
    perFrame = new WeakMap()
    boxCache.set(annotation, perFrame)
  }
  let boxes = perFrame.get(frame)
  if (!boxes) {
    boxes = annotationBoxes(annotation, frame)
    perFrame.set(frame, boxes)
  }
  return boxes
}

const outlineCache = new WeakMap<
  PdfAnnotation,
  WeakMap<PageFrame, PagePoint[][]>
>()

/** A highlight's shape on a page (`highlightOutlines`), kept like its
 * boxes: the overview draws it every frame (../canvas/overviewLayer.ts). */
export function outlinesFor(
  annotation: PdfAnnotation,
  frame: PageFrame,
): PagePoint[][] {
  let perFrame = outlineCache.get(annotation)
  if (!perFrame) {
    perFrame = new WeakMap()
    outlineCache.set(annotation, perFrame)
  }
  let outlines = perFrame.get(frame)
  if (!outlines) {
    outlines = highlightOutlines(boxesFor(annotation, frame))
    perFrame.set(frame, outlines)
  }
  return outlines
}

/** Redraws `layer` with `annotations`, marking `activeId`. */
export function renderAnnotationLayer(
  layer: HTMLElement,
  annotations: readonly PdfAnnotation[],
  frame: PageFrame,
  activeId: string | null,
): void {
  const doc = layer.ownerDocument
  const children: Element[] = []
  for (const annotation of annotations) {
    const boxes = boxesFor(annotation, frame)
    const colorClass = annotationColorClass(annotation.color)
    const active = annotation.id === activeId
    if (annotation.type === 'area') {
      for (const box of boxes) {
        const mark = doc.createElement('div')
        mark.className = `${MARK_CLASS} ${MARK_AREA_CLASS} ${colorClass}`
        mark.classList.toggle(MARK_ACTIVE_CLASS, active)
        mark.dataset.annotationId = annotation.id
        placeBox(mark, box)
        children.push(mark)
      }
    } else if (boxes.length > 0) {
      const d = outlinePath(highlightOutlines(boxes))
      for (const className of [HIGHLIGHT_CLASS, HIGHLIGHT_OUTLINE_CLASS]) {
        const svg = doc.createElementNS(SVG_NS, 'svg')
        svg.setAttribute('class', `${className} ${colorClass}`)
        svg.setAttribute('viewBox', '0 0 1 1')
        svg.setAttribute('preserveAspectRatio', 'none')
        const path = doc.createElementNS(SVG_NS, 'path')
        path.setAttribute('d', d)
        path.classList.toggle(MARK_ACTIVE_CLASS, active)
        path.dataset.annotationId = annotation.id
        svg.appendChild(path)
        children.push(svg)
      }
    }
    // A commented annotation says so where it ends: a dot in its own colour
    // just past its last line (or the corner of its frame) — the reader's to
    // hover and click (`noteAtPoint`), since this layer takes no pointer.
    if (annotation.comment && boxes.length > 0) {
      const last = boxes[boxes.length - 1]
      const note = doc.createElement('div')
      note.className = `${NOTE_CLASS} ${colorClass}`
      note.dataset.annotationId = annotation.id
      note.setCssProps({
        left: `${last.right * 100}%`,
        top: `${(annotation.type === 'area' ? last.top : last.top + (last.bottom - last.top) * NOTE_LINE_FRACTION) * 100}%`,
      })
      children.push(note)
    }
  }
  layer.replaceChildren(...children)
}

/** Moves the active mark without redrawing the layer. */
export function markActiveAnnotation(
  layer: HTMLElement,
  activeId: string | null,
): void {
  for (const mark of Array.from(
    layer.querySelectorAll<HTMLElement | SVGElement>(
      `${SHAPE_SELECTOR}, .${HIGHLIGHT_OUTLINE_CLASS} path`,
    ),
  )) {
    mark.classList.toggle(
      MARK_ACTIVE_CLASS,
      mark.dataset.annotationId === activeId,
    )
  }
}

/** Where an annotation is drawn on screen, or null when it is not drawn. */
export function annotationClientRect(
  layer: HTMLElement,
  id: string,
): DOMRect | null {
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const mark of Array.from(
    layer.querySelectorAll<HTMLElement | SVGElement>(SHAPE_SELECTOR),
  )) {
    if (mark.dataset.annotationId !== id) continue
    const rect = mark.getBoundingClientRect()
    left = Math.min(left, rect.left)
    top = Math.min(top, rect.top)
    right = Math.max(right, rect.right)
    bottom = Math.max(bottom, rect.bottom)
  }
  if (!Number.isFinite(left)) return null
  const Rect = layer.ownerDocument.defaultView?.DOMRect ?? DOMRect
  return new Rect(left, top, right - left, bottom - top)
}

/** Polygons in page fractions as one path in the SVG's unit box. */
function outlinePath(polygons: readonly (readonly PagePoint[])[]): string {
  return polygons
    .map(
      (points) =>
        `M${points.map(([x, y]) => `${round(x)} ${round(y)}`).join('L')}Z`,
    )
    .join('')
}

function round(value: number): number {
  return Math.round(value * 1e5) / 1e5
}

export function placeBox(el: HTMLElement, box: PageBox): void {
  el.setCssProps({
    left: `${box.left * 100}%`,
    top: `${box.top * 100}%`,
    width: `${(box.right - box.left) * 100}%`,
    height: `${(box.bottom - box.top) * 100}%`,
  })
}
