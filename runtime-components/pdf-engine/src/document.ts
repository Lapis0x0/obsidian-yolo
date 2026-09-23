import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type {
  PDFDocumentLoadingTask,
  PDFPageProxy,
  PageViewport,
} from 'pdfjs-dist/legacy/build/pdf.mjs'

import type {
  PdfEngineDocument,
  PdfEnginePage,
  PdfPoint,
  PdfRect,
  PdfTask,
  PdfTextLayer,
  PdfTextSelection,
  PdfTextSelectionTuple,
} from '../../../src/core/runtime-components/contracts'

import {
  MAX_CANVAS_PIXELS,
  type ViewportBox,
  capPixelRatio,
  mergeBoxesIntoLines,
} from './geometry'

const TEXT_LAYER_CLASS = 'yolo-pdf-text-layer'
const TEXT_LAYER_SELECTING_CLASS = 'yolo-pdf-text-layer--selecting'
const TEXT_LAYER_END_CLASS = 'yolo-pdf-text-layer__end'

/** The task currently drawing into a canvas / building into a container. */
const activeRenders = new WeakMap<HTMLCanvasElement, { cancel(): void }>()
const activeTextLayers = new WeakMap<HTMLElement, PdfTextLayer>()

export async function createPdfDocument(
  loadingTask: PDFDocumentLoadingTask,
): Promise<PdfEngineDocument> {
  let proxy
  try {
    proxy = await loadingTask.promise
  } catch (error) {
    await loadingTask.destroy()
    throw error
  }
  const pages = new Map<number, Promise<PdfEnginePage>>()
  let destroyed: Promise<void> | null = null

  return Object.freeze({
    pageCount: proxy.numPages,
    getPage(pageNumber: number): Promise<PdfEnginePage> {
      if (destroyed) {
        return Promise.reject(new Error('PDF document is destroyed'))
      }
      if (
        !Number.isInteger(pageNumber) ||
        pageNumber < 1 ||
        pageNumber > proxy.numPages
      ) {
        return Promise.reject(
          new RangeError(
            `PDF page ${pageNumber} is outside 1-${proxy.numPages}`,
          ),
        )
      }
      let page = pages.get(pageNumber)
      if (!page) {
        page = proxy.getPage(pageNumber).then(createPage)
        pages.set(pageNumber, page)
        page.catch(() => pages.delete(pageNumber))
      }
      return page
    },
    destroy(): Promise<void> {
      destroyed ??= loadingTask.destroy()
      return destroyed
    },
  })
}

function createPage(proxy: PDFPageProxy): PdfEnginePage {
  const base = proxy.getViewport({ scale: 1 })
  const viewportAt = (scale: number): PageViewport => {
    if (!(Number.isFinite(scale) && scale > 0)) {
      throw new RangeError(`PDF scale must be a positive number, got ${scale}`)
    }
    return proxy.getViewport({ scale })
  }

  return Object.freeze({
    pageNumber: proxy.pageNumber,
    width: base.width,
    height: base.height,
    rotation: normalizeRotation(base.rotation),

    render({ canvas, scale, pixelRatio }) {
      activeRenders.get(canvas)?.cancel()
      const viewport = viewportAt(scale)
      const ratio = capPixelRatio(
        viewport.width,
        viewport.height,
        pixelRatio ?? canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1,
      )
      // Drawn off to the side so the caller's canvas keeps its old picture
      // until the new one is complete (and forever, if this is cancelled).
      const scratch = canvas.ownerDocument.createElement('canvas')
      scratch.width = Math.max(1, Math.floor(viewport.width * ratio))
      scratch.height = Math.max(1, Math.floor(viewport.height * ratio))
      const renderTask = proxy.render({
        canvas: scratch,
        viewport,
        transform: [
          scratch.width / viewport.width,
          0,
          0,
          scratch.height / viewport.height,
          0,
          0,
        ],
      })
      const entry = { cancel: () => renderTask.cancel() }
      activeRenders.set(canvas, entry)
      const promise = renderTask.promise
        .then(() => {
          canvas.width = scratch.width
          canvas.height = scratch.height
          canvas.getContext('2d')?.drawImage(scratch, 0, 0)
          return Object.freeze({ pixelRatio: ratio })
        }, rethrowAsAbort)
        .finally(() => {
          if (activeRenders.get(canvas) === entry) activeRenders.delete(canvas)
          releaseCanvas(scratch)
        })
      return Object.freeze({ promise, cancel: entry.cancel })
    },

    renderTextLayer({ container, scale }) {
      activeTextLayers.get(container)?.destroy()
      return buildTextLayer(proxy, container, viewportAt(scale))
    },

    async renderRegion(rect: PdfRect, { scale }) {
      const viewport = viewportAt(scale)
      const [ax, ay] = viewport.convertToViewportPoint(rect[0], rect[1])
      const [bx, by] = viewport.convertToViewportPoint(rect[2], rect[3])
      const left = Math.min(ax, bx)
      const top = Math.min(ay, by)
      const width = Math.abs(bx - ax)
      const height = Math.abs(by - ay)
      if (!(width >= 1 && height >= 1)) {
        throw new RangeError('PDF region is empty at this scale')
      }
      const ratio = capPixelRatio(width, height, 1, MAX_CANVAS_PIXELS)
      const canvas = globalThis.document.createElement('canvas')
      try {
        canvas.width = Math.max(1, Math.round(width * ratio))
        canvas.height = Math.max(1, Math.round(height * ratio))
        await proxy.render({
          canvas,
          viewport,
          transform: [ratio, 0, 0, ratio, -left * ratio, -top * ratio],
        }).promise
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/png'),
        )
        if (!blob) throw new Error('PDF region could not be encoded as PNG')
        return await blob.arrayBuffer()
      } finally {
        releaseCanvas(canvas)
      }
    },

    toViewportPoint(point: PdfPoint, scale: number): PdfPoint {
      const [x, y] = viewportAt(scale).convertToViewportPoint(
        point[0],
        point[1],
      )
      return [x, y]
    },

    toPdfPoint(point: PdfPoint, scale: number): PdfPoint {
      const [x, y] = viewportAt(scale).convertToPdfPoint(point[0], point[1])
      return [x, y]
    },

    cleanup(): void {
      // pdf.js declines while a render of the page is running and cleans up
      // when the last one ends, so this is safe to call at any time.
      proxy.cleanup()
    },
  })
}

function buildTextLayer(
  proxy: PDFPageProxy,
  container: HTMLElement,
  initialViewport: PageViewport,
): PdfTask<PdfTextLayer> {
  const doc = container.ownerDocument
  const win = doc.defaultView
  let viewport = initialViewport
  container.replaceChildren()
  container.classList.add(TEXT_LAYER_CLASS)
  applyScale(container, viewport)
  const textLayer = new pdfjs.TextLayer({
    // The parameters pdf.js's own viewer (and so Obsidian's) builds its text
    // layer from: the same item list, un-normalized, so span indices and
    // in-span character offsets agree with native selection links.
    textContentSource: proxy.streamTextContent({
      includeMarkedContent: true,
      disableNormalization: true,
    }),
    container,
    viewport,
  })

  const end = doc.createElement('div')
  end.className = TEXT_LAYER_END_CLASS
  // While a drag-selection is in progress the end element covers the whole
  // layer beneath the spans, so the pointer over blank page area hits a
  // non-selectable box instead of making the browser extend the selection to
  // the end of the layer.
  const startSelecting = (): void => {
    container.classList.add(TEXT_LAYER_SELECTING_CLASS)
  }
  const stopSelecting = (): void => {
    container.classList.remove(TEXT_LAYER_SELECTING_CLASS)
  }
  let destroyed = false
  const destroy = (): void => {
    if (destroyed) return
    destroyed = true
    textLayer.cancel()
    container.removeEventListener('pointerdown', startSelecting)
    win?.removeEventListener('pointerup', stopSelecting)
    win?.removeEventListener('blur', stopSelecting)
    container.replaceChildren()
    container.classList.remove(TEXT_LAYER_CLASS, TEXT_LAYER_SELECTING_CLASS)
    if (activeTextLayers.get(container) === handle) {
      activeTextLayers.delete(container)
    }
  }

  const spans = (): readonly HTMLElement[] => textLayer.textDivs

  const handle: PdfTextLayer = Object.freeze({
    pageNumber: proxy.pageNumber,
    describeRange: (range: Range) =>
      describeRange(proxy.pageNumber, container, spans(), viewport, range),
    createRange: (tuple: PdfTextSelectionTuple) =>
      createRange(container, spans(), tuple),
    setScale(scale: number) {
      if (destroyed) return
      viewport = proxy.getViewport({ scale })
      applyScale(container, viewport)
      textLayer.update({ viewport })
    },
    destroy,
  })
  activeTextLayers.set(container, handle)

  const promise = textLayer.render().then(
    () => {
      if (destroyed) throw abortError()
      textLayer.textDivs.forEach((span, index) => {
        span.dataset.idx = String(index)
      })
      container.append(end)
      container.addEventListener('pointerdown', startSelecting)
      win?.addEventListener('pointerup', stopSelecting)
      win?.addEventListener('blur', stopSelecting)
      return handle
    },
    (error: unknown) => {
      destroy()
      return rethrowAsAbort(error)
    },
  )
  return Object.freeze({ promise, cancel: destroy })
}

/** What pdf.js's viewer sets on the page: CSS px per unscaled PDF unit. */
function applyScale(container: HTMLElement, viewport: PageViewport): void {
  container.style.setProperty(
    '--total-scale-factor',
    String(viewport.scale * viewport.userUnit),
  )
}

function describeRange(
  pageNumber: number,
  container: HTMLElement,
  spans: readonly HTMLElement[],
  viewport: PageViewport,
  range: Range,
): PdfTextSelection | null {
  const doc = container.ownerDocument
  const pieces: { index: number; start: number; end: number }[] = []
  spans.forEach((span, index) => {
    if (!span.isConnected || !container.contains(span)) return
    if (!range.intersectsNode(span)) return
    const length = span.textContent?.length ?? 0
    const start = containsBoundary(span, range.startContainer)
      ? offsetWithin(span, range.startContainer, range.startOffset)
      : 0
    const end = containsBoundary(span, range.endContainer)
      ? offsetWithin(span, range.endContainer, range.endOffset)
      : length
    if (end > start) pieces.push({ index, start, end })
  })
  if (pieces.length === 0) return null

  const box = container.getBoundingClientRect()
  if (!(box.width > 0 && box.height > 0)) return null
  // The container may sit under CSS transforms (a zoomed canvas); client
  // rects are measured against its on-screen box and mapped back onto the
  // viewport, which is exactly the space pdf.js converts from.
  const sx = viewport.width / box.width
  const sy = viewport.height / box.height
  const fragments: ViewportBox[] = []
  let text = ''
  pieces.forEach((piece, order) => {
    const span = spans[piece.index]
    const pieceRange = doc.createRange()
    const startPoint = pointAt(span, piece.start)
    const endPoint = pointAt(span, piece.end)
    pieceRange.setStart(startPoint.node, startPoint.offset)
    pieceRange.setEnd(endPoint.node, endPoint.offset)
    for (const rect of Array.from(pieceRange.getClientRects())) {
      fragments.push({
        left: (rect.left - box.left) * sx,
        top: (rect.top - box.top) * sy,
        right: (rect.right - box.left) * sx,
        bottom: (rect.bottom - box.top) * sy,
      })
    }
    if (order > 0 && lineBreakBetween(spans[pieces[order - 1].index], span)) {
      text += '\n'
    }
    text += pieceRange.toString()
  })

  const quadPoints: number[] = []
  for (const line of mergeBoxesIntoLines(fragments)) {
    for (const [x, y] of [
      [line.left, line.top],
      [line.right, line.top],
      [line.left, line.bottom],
      [line.right, line.bottom],
    ] as const) {
      const [px, py] = viewport.convertToPdfPoint(x, y)
      quadPoints.push(px, py)
    }
  }
  const first = pieces[0]
  const last = pieces[pieces.length - 1]
  return Object.freeze({
    pageNumber,
    text: String(pdfjs.normalizeUnicode(text)),
    quadPoints: Object.freeze(quadPoints),
    tuple: Object.freeze([
      first.index,
      first.start,
      last.index,
      last.end,
    ] as const),
  })
}

function createRange(
  container: HTMLElement,
  spans: readonly HTMLElement[],
  [startIndex, startOffset, endIndex, endOffset]: PdfTextSelectionTuple,
): Range | null {
  const attached = (index: number): boolean =>
    spans[index]?.isConnected === true && container.contains(spans[index])
  // Indices of empty text items name spans pdf.js never attaches; a tuple
  // that starts or ends on one still means "from here", so step onto the
  // nearest attached span in the direction of the selection.
  if (![startIndex, startOffset, endIndex, endOffset].every(Number.isInteger)) {
    return null
  }
  let start = Math.max(0, startIndex)
  let startAt = start === startIndex ? startOffset : 0
  let end = Math.min(spans.length - 1, endIndex)
  let endAt = end === endIndex ? endOffset : Number.POSITIVE_INFINITY
  while (start <= end && !attached(start)) {
    start += 1
    startAt = 0
  }
  while (end >= start && !attached(end)) {
    end -= 1
    endAt = Number.POSITIVE_INFINITY
  }
  if (end < start) return null
  const from = pointAt(spans[start], startAt)
  const to = pointAt(spans[end], endAt)
  const range = container.ownerDocument.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  return range.collapsed ? null : range
}

function containsBoundary(span: HTMLElement, node: Node): boolean {
  return span === node || span.contains(node)
}

/**
 * A boundary point as a character offset into the span's text — Obsidian's
 * "offset within the span", counted over every text node the span holds so
 * it survives highlight markup nested inside spans.
 */
function offsetWithin(span: HTMLElement, node: Node, offset: number): number {
  const prefix = span.ownerDocument.createRange()
  prefix.setStart(span, 0)
  prefix.setEnd(node, offset)
  return prefix.toString().length
}

/** The DOM boundary point `offset` characters into the span (clamped). */
function pointAt(
  span: HTMLElement,
  offset: number,
): { node: Node; offset: number } {
  const walker = span.ownerDocument.createTreeWalker(span, NodeFilter.SHOW_TEXT)
  let remaining = Math.max(0, offset)
  let last: Text | null = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    if (remaining <= text.length) return { node: text, offset: remaining }
    remaining -= text.length
    last = text
  }
  return last
    ? { node: last, offset: last.length }
    : { node: span, offset: span.childNodes.length }
}

/** pdf.js marks the end of a text line with a `<br>` after its span. */
function lineBreakBetween(before: HTMLElement, after: HTMLElement): boolean {
  const gap = before.ownerDocument.createRange()
  gap.setStartAfter(before)
  gap.setEndBefore(after)
  return gap.cloneContents().querySelector('br') !== null
}

function normalizeRotation(rotation: number): 0 | 90 | 180 | 270 {
  const value = ((rotation % 360) + 360) % 360
  return value === 90 || value === 180 || value === 270 ? value : 0
}

function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0
  canvas.height = 0
}

function abortError(): DOMException {
  return new DOMException('PDF task cancelled', 'AbortError')
}

function rethrowAsAbort(error: unknown): never {
  if (
    error instanceof Error &&
    (error.name === 'RenderingCancelledException' ||
      error.name === 'AbortException')
  ) {
    throw abortError()
  }
  throw error
}
