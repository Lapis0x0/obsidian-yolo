// Pictures of a PDF's pages (./pictures.ts's source 'pdf'): a group is a
// version of the file, a picture one of its pages, and beside each goes where
// the page's PDF points land on it (`PageGeometry`), measured as it is drawn —
// the overview draws a page's annotations over its picture by it, without
// opening the PDF.
//
// Drawn with the host's pdf.js through the board's draw queue
// (../pdf/drawQueue.ts), as one client behind every reader: a page on screen
// is never kept waiting for a picture's turn. A file's document is opened for
// the first page that has to be drawn and held until its group is let go of;
// a file that changes while it is held drops its pictures (`onStale`).

import type { PictureStore } from '../../host/pictureStore'
import type { PageFrame } from '../pdf/annotationGeometry'
import type { PdfDrawClient, PdfDrawQueue } from '../pdf/drawQueue'

import type {
  DrawnPicture,
  PictureRef,
  PictureSource,
  PictureTurn,
  WantedPicture,
} from './pictures'

/** A page picture's width in pixels, whatever the page's shape: sharp in
 * the overview (where a sheet is at most ~270 device pixels wide) up to the
 * threshold, and a fair stand-in for the moment before a sheet is drawn. */
export const PDF_PAGE_PICTURE_WIDTH = 160
/** Draws an ordinary page's slot always go ahead of: a picture is only ever
 * next when no reader is waiting. */
const BEHIND_READERS = 1e12

/**
 * Where a page's PDF points land on it: its size at scale 1, the page's own
 * rotation applied, and the affine transform `[a, b, c, d, e, f]` from PDF
 * user space to that size (the page's view box and rotation). Recorded as
 * the picture is made, with the page open — so what is drawn over a picture
 * by PDF coordinates (the overview's annotations) is placed without opening
 * the PDF. Of the file's version, like the picture.
 */
export type PageGeometry = Readonly<{
  width: number
  height: number
  transform: readonly number[]
}>

/** The picture of page `page` of the PDF at `path`. */
export function pdfPageRef(path: string, page: number): PictureRef {
  return { source: 'pdf', group: path, key: String(page) }
}

export type PdfPagesDeps = Readonly<{
  pdf: YoloModuleHostPdfV1
  store: PictureStore
  queue: PdfDrawQueue
  doc: Document
  /** When the file at `path` was last modified; null when it is not a
   * file now. */
  mtime: (path: string) => number | null
  /** An open file changed under its pictures. */
  onStale: (path: string) => void
}>

type OpenDocument = {
  readonly opened: Promise<YoloModuleHostPdfDocumentV1>
  disposeStale: (() => void) | null
}

/** By the meta object a page's picture carries, which stays the same
 * object for as long as the picture is held — what the overview caches a
 * page's annotation paths by. */
const frames = new WeakMap<object, PageFrame>()

export class PdfPages implements PictureSource {
  readonly id = 'pdf' as const
  readonly label = 'pdf thumbnail'
  /** The filter the stylesheet puts on a page in a dark theme
   * (styles/pdf/card.css). */
  readonly darkFilter = 'invert(0.88) hue-rotate(180deg)'
  readonly store: PictureStore
  readonly turn: PictureTurn
  private readonly documents = new Map<string, OpenDocument>()

  constructor(private readonly deps: PdfPagesDeps) {
    this.store = deps.store
    this.turn = new QueueTurn(deps.queue)
  }

  version(path: string): number | null {
    return this.deps.mtime(path)
  }

  async draw(
    want: WantedPicture,
    _version: number,
  ): Promise<DrawnPicture | 'unavailable' | null> {
    const pageNumber = Number(want.key)
    const canvas = this.deps.doc.createElement('canvas')
    try {
      const handle = await this.document(want.group)
      if (handle.isStale()) return emptied(canvas)
      // A folded card asks for the pages its reader could show below where
      // it was left, which near the end runs past the last.
      if (pageNumber > handle.pageCount) {
        emptied(canvas)
        return 'unavailable'
      }
      const page = await handle.getPage(pageNumber)
      await page.render({
        canvas,
        scale: PDF_PAGE_PICTURE_WIDTH / page.width,
        pixelRatio: 1,
      }).promise
      const meta = measureGeometry(page)
      // A page far from anything drawn keeps its parsed operations only
      // for the reader that draws it next; there may be none.
      page.cleanup()
      return { canvas, meta }
    } catch (error) {
      emptied(canvas)
      throw error
    }
  }

  release(path: string): void {
    const open = this.documents.get(path)
    if (!open) return
    this.documents.delete(path)
    open.disposeStale?.()
    void open.opened.then(
      (handle) => handle.release(),
      () => undefined,
    )
  }

  private document(path: string): Promise<YoloModuleHostPdfDocumentV1> {
    const known = this.documents.get(path)
    if (known) return known.opened
    const open: OpenDocument = {
      opened: this.deps.pdf.open(path),
      disposeStale: null,
    }
    this.documents.set(path, open)
    void open.opened.then(
      (handle) => {
        // Let go of before it opened: `release` has released it.
        if (this.documents.get(path) !== open) return
        // A changed file's pictures are of the old file.
        open.disposeStale = handle.subscribe(() => this.deps.onStale(path))
      },
      () => {
        if (this.documents.get(path) === open) this.documents.delete(path)
      },
    )
    return open.opened
  }
}

/** Where a page's PDF points land on its picture, from what the picture
 * carries (`PdfPages`' meta); null when it carries nothing usable. */
export function pageFrame(meta: unknown): PageFrame | null {
  if (typeof meta !== 'object' || meta === null) return null
  const known = frames.get(meta)
  if (known) return known
  const geometry = parseGeometry(meta)
  if (!geometry) return null
  const [a, b, c, d, e, f] = geometry.transform
  const frame: PageFrame = {
    width: geometry.width,
    height: geometry.height,
    toViewport: ([x, y]) => [a * x + c * y + e, b * x + d * y + f],
  }
  frames.set(meta, frame)
  return frame
}

/** The board's draw queue, as a source's turn: one client, behind every
 * reader, nearest picture first. */
class QueueTurn implements PictureTurn {
  /** The page the queue last saw this client for, so its priority is where
   * the next picture would go. */
  private next: WantedPicture | null = null
  private wake: (() => void) | null = null
  private readonly client: PdfDrawClient = {
    priority: () => BEHIND_READERS + (this.next?.distance ?? 0),
    wake: () => this.wake?.(),
  }

  constructor(private readonly queue: PdfDrawQueue) {}

  begin(next: WantedPicture, wake: () => void): boolean {
    this.next = next
    this.wake = wake
    return this.queue.tryStart(this.client)
  }

  end(): void {
    this.queue.finish()
  }

  withdraw(): void {
    this.queue.withdraw(this.client)
  }
}

/** The page's size and its PDF-to-viewport transform at scale 1, read off
 * three points: the transform is affine. */
function measureGeometry(page: YoloModuleHostPdfPageV1): PageGeometry {
  const [e, f] = page.toViewportPoint([0, 0], 1)
  const [ax, bx] = page.toViewportPoint([1, 0], 1)
  const [cy, dy] = page.toViewportPoint([0, 1], 1)
  return {
    width: page.width,
    height: page.height,
    transform: [ax - e, bx - f, cy - e, dy - f, e, f],
  }
}

function parseGeometry(value: object): PageGeometry | null {
  const { width, height, transform } = value as Record<string, unknown>
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Array.isArray(transform) ||
    transform.length !== 6 ||
    !transform.every((n) => typeof n === 'number')
  ) {
    return null
  }
  return { width, height, transform: transform }
}

/** Empties a canvas no picture is coming from. */
function emptied(canvas: HTMLCanvasElement): null {
  canvas.width = 0
  canvas.height = 0
  return null
}
