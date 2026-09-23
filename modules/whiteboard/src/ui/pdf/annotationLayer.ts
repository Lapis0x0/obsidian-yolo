// Drawing a page's annotations (../../domain/pdfAnnotations.ts) into the
// layer each page of a reader (./pdfReader.ts) carries between its picture
// and its text layer.
//
// Plain positioned boxes, in percentages of the page (./annotationGeometry.ts
// explains the space), so a layer never has to be redrawn for a resize or a
// zoom — only when the page's annotations change. The layer takes no pointer
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
  annotationBoxes,
} from './annotationGeometry'

const MARK_CLASS = 'yolo-whiteboard-pdf-mark'
const MARK_AREA_CLASS = 'yolo-whiteboard-pdf-mark-area'
const MARK_ACTIVE_CLASS = 'yolo-whiteboard-pdf-mark-active'
const NOTE_CLASS = 'yolo-whiteboard-pdf-mark-note'

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

/** Redraws `layer` with `annotations`, marking `activeId`. */
export function renderAnnotationLayer(
  layer: HTMLElement,
  annotations: readonly PdfAnnotation[],
  frame: PageFrame,
  activeId: string | null,
): void {
  const doc = layer.ownerDocument
  const children: HTMLElement[] = []
  for (const annotation of annotations) {
    const boxes = boxesFor(annotation, frame)
    const colorClass = annotationColorClass(annotation.color)
    for (const box of boxes) {
      const mark = doc.createElement('div')
      mark.className = `${MARK_CLASS} ${colorClass}`
      if (annotation.type === 'area') mark.classList.add(MARK_AREA_CLASS)
      if (annotation.id === activeId) mark.classList.add(MARK_ACTIVE_CLASS)
      mark.dataset.annotationId = annotation.id
      placeBox(mark, box)
      children.push(mark)
    }
    // A commented annotation says so just past the end of its first line
    // (or the corner of its frame): a dot in its own colour.
    if (annotation.comment && boxes.length > 0) {
      const first = boxes[0]
      const note = doc.createElement('div')
      note.className = `${NOTE_CLASS} ${colorClass}`
      note.dataset.annotationId = annotation.id
      note.setCssProps({
        left: `${first.right * 100}%`,
        top: `${(annotation.type === 'area' ? first.top : (first.top + first.bottom) / 2) * 100}%`,
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
    layer.querySelectorAll<HTMLElement>(`.${MARK_CLASS}`),
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
    layer.querySelectorAll<HTMLElement>(`.${MARK_CLASS}`),
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

export function placeBox(el: HTMLElement, box: PageBox): void {
  el.setCssProps({
    left: `${box.left * 100}%`,
    top: `${box.top * 100}%`,
    width: `${(box.right - box.left) * 100}%`,
    height: `${(box.bottom - box.top) * 100}%`,
  })
}
