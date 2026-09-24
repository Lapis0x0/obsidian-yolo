// Small pictures of the pages of every PDF spread open on a board.
//
// A spread puts hundreds of pages on the board, and a page's real picture is
// drawn only once it is on screen, at the density the screen shows it — which
// on a pan across a spread is later than the page arrives, so pages came in
// blank. And zoomed out past the overview threshold no page is drawn at all:
// the overview canvas showed each as a grey card.
//
// So while the board is idle, every page of an open spread is drawn once, a
// thumbnail wide, nearest the middle of the viewport first. A sheet shows its
// thumbnail until its real picture is ready, and the overview canvas draws
// thumbnails where it drew grey.
//
// The drawing goes through the board's draw queue (./drawQueue.ts) as one
// client behind every reader: a page on screen is never kept waiting for a
// thumbnail's turn.

import type { PdfDrawClient, PdfDrawQueue } from './drawQueue'

/** A thumbnail's width in pixels, whatever the page's shape: sharp in the
 * overview (where a sheet is at most ~270 device pixels wide) up to the
 * threshold, and a fair stand-in for the moment before a sheet is drawn. */
export const PDF_THUMBNAIL_WIDTH = 160
/** How much thumbnails may hold, in bytes: about 360 pages. Past it, pages
 * further out simply have none — a board with more open than that is not
 * the one this is shaped for, and thrashing to cover it would cost more
 * than it gives. */
const BUDGET_BYTES = 48 * 1024 * 1024
/** Draws an ordinary page's slot always go ahead of: a thumbnail is only
 * ever next when no reader is waiting. */
const BEHIND_READERS = 1e12

/** What the whiteboard's pages look like to this: a page of a file, and how
 * far it is from the middle of the viewport. */
export type WantedThumbnail = Readonly<{
  path: string
  page: number
  distance: number
}>

export type PdfThumbnailsDeps = Readonly<{
  pdf: YoloModuleHostPdfV1
  queue: PdfDrawQueue
  doc: Document
  /** Every page that should have a thumbnail, now. */
  wanted: () => Iterable<WantedThumbnail>
  /** Whether the board is still: thumbnails are drawn only then. */
  idle: () => boolean
  /** A page's thumbnail was made (or a file's were all dropped). */
  onChange: (path: string, page: number | null) => void
  reportError: (stage: string, error: unknown) => void
}>

type Entry = {
  bitmap: ImageBitmap
  /** The same picture as a dark theme shows the page, made when first
   * asked for. */
  dark: ImageBitmap | null
}

const key = (path: string, page: number): string => `${page}\n${path}`

export class PdfThumbnails {
  private readonly entries = new Map<string, Entry>()
  /** Pages that could not be drawn: not asked for again until their file
   * changes. */
  private readonly failed = new Set<string>()
  private bytes = 0
  private readonly documents = new Map<
    string,
    Promise<YoloModuleHostPdfDocumentV1>
  >()
  private readonly staleDisposers = new Map<string, () => void>()
  private drawing = false
  private destroyed = false
  /** Every wanted page had a thumbnail (or had failed) when last looked:
   * nothing to look for until the board's spreads change (`retain`). */
  private complete = false
  /** The page the queue last saw this client for, so its priority is
   * where the next thumbnail would go. */
  private next: WantedThumbnail | null = null
  private readonly client: PdfDrawClient = {
    priority: () => BEHIND_READERS + (this.next?.distance ?? 0),
    wake: () => this.pump(),
  }

  constructor(private readonly deps: PdfThumbnailsDeps) {}

  /** The page's thumbnail, as a dark theme shows it when `dark`. */
  get(path: string, page: number, dark = false): ImageBitmap | null {
    const entry = this.entries.get(key(path, page))
    if (!entry) return null
    if (!dark) return entry.bitmap
    entry.dark ??= this.inverted(entry.bitmap)
    return entry.dark ?? entry.bitmap
  }

  /**
   * Makes the next thumbnail if the board is idle and it is this client's
   * turn. Called by the board once a frame, and by the queue when a turn
   * opens; cheap when there is nothing to do.
   */
  pump(): void {
    if (this.destroyed || this.drawing || this.complete) return
    if (!this.deps.idle() || this.bytes >= BUDGET_BYTES) {
      this.deps.queue.withdraw(this.client)
      return
    }
    this.next = this.pickNext()
    if (!this.next) {
      this.complete = true
      this.deps.queue.withdraw(this.client)
      return
    }
    if (!this.deps.queue.tryStart(this.client)) return
    const wanted = this.next
    this.drawing = true
    void this.draw(wanted).finally(() => {
      this.drawing = false
      this.deps.queue.finish()
    })
  }

  /** Lets go of the thumbnails of every file not in `paths` — the spreads
   * that were closed or deleted. */
  retain(paths: ReadonlySet<string>): void {
    // The spreads, their pages or where they are may have changed.
    this.complete = false
    for (const path of [...this.documents.keys()]) {
      if (!paths.has(path)) this.dropFile(path)
    }
  }

  destroy(): void {
    this.destroyed = true
    this.deps.queue.withdraw(this.client)
    for (const path of [...this.documents.keys()]) this.dropFile(path)
    for (const entry of this.entries.values()) this.close(entry)
    this.entries.clear()
    this.bytes = 0
  }

  private pickNext(): WantedThumbnail | null {
    let best: WantedThumbnail | null = null
    for (const wanted of this.deps.wanted()) {
      const k = key(wanted.path, wanted.page)
      if (this.entries.has(k) || this.failed.has(k)) continue
      if (!best || wanted.distance < best.distance) best = wanted
    }
    return best
  }

  private async draw(wanted: WantedThumbnail): Promise<void> {
    const canvas = this.deps.doc.createElement('canvas')
    try {
      const handle = await this.document(wanted.path)
      if (this.destroyed || handle.isStale()) return
      const page = await handle.getPage(wanted.page)
      await page.render({
        canvas,
        scale: PDF_THUMBNAIL_WIDTH / page.width,
        pixelRatio: 1,
      }).promise
      // A page far from anything drawn keeps its parsed operations only
      // for the reader that draws it next; there may be none.
      page.cleanup()
      const win = this.deps.doc.defaultView
      if (!win || this.destroyed || !this.documents.has(wanted.path)) return
      const bitmap = await win.createImageBitmap(canvas)
      if (this.destroyed || !this.documents.has(wanted.path)) {
        bitmap.close()
        return
      }
      const k = key(wanted.path, wanted.page)
      const old = this.entries.get(k)
      if (old) this.forget(k, old)
      this.entries.set(k, { bitmap, dark: null })
      this.bytes += bitmap.width * bitmap.height * 4
      this.deps.onChange(wanted.path, wanted.page)
    } catch (error) {
      // A file dropped meanwhile was closed under the draw: not a failure.
      if (!this.documents.has(wanted.path)) return
      this.deps.reportError('pdf thumbnail', error)
      this.failed.add(key(wanted.path, wanted.page))
    } finally {
      canvas.width = 0
      canvas.height = 0
    }
  }

  private document(path: string): Promise<YoloModuleHostPdfDocumentV1> {
    let opened = this.documents.get(path)
    if (!opened) {
      opened = this.deps.pdf.open(path)
      this.documents.set(path, opened)
      void opened.then(
        (handle) => {
          // Dropped before it opened: `dropFile` has released it.
          if (this.documents.get(path) !== opened) return
          // A changed file's pictures are of the old file.
          this.staleDisposers.set(
            path,
            handle.subscribe(() => this.dropFile(path)),
          )
        },
        () => {
          if (this.documents.get(path) === opened) this.documents.delete(path)
        },
      )
    }
    return opened
  }

  private dropFile(path: string): void {
    this.complete = false
    const opened = this.documents.get(path)
    this.documents.delete(path)
    this.staleDisposers.get(path)?.()
    this.staleDisposers.delete(path)
    void opened?.then(
      (handle) => handle.release(),
      () => undefined,
    )
    const suffix = `\n${path}`
    for (const [k, entry] of [...this.entries]) {
      if (k.endsWith(suffix)) this.forget(k, entry)
    }
    for (const k of [...this.failed]) {
      if (k.endsWith(suffix)) this.failed.delete(k)
    }
    if (!this.destroyed) this.deps.onChange(path, null)
  }

  private forget(k: string, entry: Entry): void {
    this.entries.delete(k)
    this.bytes -= entry.bitmap.width * entry.bitmap.height * 4
    this.close(entry)
  }

  private close(entry: Entry): void {
    entry.bitmap.close()
    entry.dark?.close()
  }

  /** The picture through the filter the stylesheet puts on a page in a dark
   * theme (styles/pdf/card.css), baked once. */
  private inverted(bitmap: ImageBitmap): ImageBitmap | null {
    const win = this.deps.doc.defaultView
    if (!win || typeof win.OffscreenCanvas !== 'function') return null
    const canvas = new win.OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.filter = 'invert(0.88) hue-rotate(180deg)'
    ctx.drawImage(bitmap, 0, 0)
    return canvas.transferToImageBitmap()
  }
}
