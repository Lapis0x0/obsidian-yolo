// Small pictures of the pages of every PDF spread open on a board.
//
// A spread puts hundreds of pages on the board, and a page's real picture is
// drawn only once it is on screen, at the density the screen shows it — which
// on a pan across a spread is later than the page arrives, so pages came in
// blank. And zoomed out past the overview threshold no page is drawn at all:
// the overview canvas showed each as a grey card.
//
// So every page of an open spread gets a thumbnail, nearest the middle of the
// viewport first. A sheet shows its thumbnail until its real picture is
// ready, and the overview canvas draws thumbnails where it drew grey.
//
// A thumbnail is drawn once per version of its file: it is kept on this
// device (host/pdfThumbnailStore.ts), and a page that has one there is read
// back instead — at any time, since that costs pdf.js nothing. Drawing waits
// for the board to be still and goes through the board's draw queue
// (./drawQueue.ts) as one client behind every reader: a page on screen is
// never kept waiting for a thumbnail's turn.
//
// What is held here is only what the board shows: a spread folded away lets
// go of its pictures, and over the budget the pages furthest from the
// viewport do.

import type { PdfThumbnailStore } from '../../host/pdfThumbnailStore'

import type { PdfDrawClient, PdfDrawQueue } from './drawQueue'

/** A thumbnail's width in pixels, whatever the page's shape: sharp in the
 * overview (where a sheet is at most ~270 device pixels wide) up to the
 * threshold, and a fair stand-in for the moment before a sheet is drawn. */
export const PDF_THUMBNAIL_WIDTH = 160
/** How much the pictures held may take, in bytes: about 360 pages. */
const BUDGET_BYTES = 48 * 1024 * 1024
/** Pages read back from the device at once. */
const READS_AT_ONCE = 6
/** Draws an ordinary page's slot always go ahead of: a thumbnail is only
 * ever next when no reader is waiting. */
const BEHIND_READERS = 1e12
/** How a thumbnail is kept: a few kilobytes a page. A WebView that cannot
 * write it gives PNG, which is larger and as good. */
const ENCODING = 'image/webp'
const ENCODING_QUALITY = 0.8

/** What the whiteboard's pages look like to this: a page of a file, and how
 * far it is from the middle of the viewport. */
export type WantedThumbnail = Readonly<{
  path: string
  page: number
  distance: number
}>

export type PdfThumbnailsDeps = Readonly<{
  pdf: YoloModuleHostPdfV1
  store: PdfThumbnailStore
  queue: PdfDrawQueue
  doc: Document
  /** When the file at `path` was last modified; null when it is not a
   * file now. */
  mtime: (path: string) => number | null
  /** Every page that should have a thumbnail, now. */
  wanted: () => Iterable<WantedThumbnail>
  /** Whether the board is still: thumbnails are drawn only then. */
  idle: () => boolean
  /** A page's thumbnail arrived (or a file's were all dropped). */
  onChange: (path: string, page: number | null) => void
  reportError: (stage: string, error: unknown) => void
}>

type Entry = {
  bitmap: ImageBitmap
  /** The same picture as a dark theme shows it, made when first asked
   * for. */
  dark: ImageBitmap | null
}

/** A file whose pages are wanted: the version they are of, and what of it
 * the device has. */
type FileState = {
  readonly path: string
  readonly mtime: number
  /** The pages kept on the device; null until the store has answered. */
  stored: Set<number> | null
  /** Opened for the first page that has to be drawn. */
  document: Promise<YoloModuleHostPdfDocumentV1> | null
  disposeStale: (() => void) | null
}

const key = (path: string, page: number): string => `${page}\n${path}`

export class PdfThumbnails {
  private readonly entries = new Map<string, Entry>()
  private readonly files = new Map<string, FileState>()
  /** Pages that could not be drawn: not asked for again until their file
   * changes. */
  private readonly failed = new Set<string>()
  /** Pages being read back from the device. */
  private readonly reading = new Set<string>()
  private bytes = 0
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
   * Reads back the nearest pages the device has, and draws the next one it
   * has not if the board is idle and it is this client's turn. Called by the
   * board once a frame, and by the queue when a turn opens; cheap when there
   * is nothing to do.
   */
  pump(): void {
    if (this.destroyed || this.complete) return
    const toRead: WantedThumbnail[] = []
    let toDraw: WantedThumbnail | null = null
    let farthestHeld: WantedThumbnail | null = null
    /** Some page's file has not been answered for yet by the store. */
    let waiting = false
    for (const wanted of this.deps.wanted()) {
      const k = key(wanted.path, wanted.page)
      if (this.entries.has(k)) {
        if (!farthestHeld || wanted.distance > farthestHeld.distance) {
          farthestHeld = wanted
        }
        continue
      }
      if (this.failed.has(k) || this.reading.has(k)) continue
      const file = this.file(wanted.path)
      if (!file) continue
      if (!file.stored) {
        waiting = true
      } else if (file.stored.has(wanted.page)) {
        toRead.push(wanted)
      } else if (!toDraw || wanted.distance < toDraw.distance) {
        toDraw = wanted
      }
    }

    toRead.sort((a, b) => a.distance - b.distance)
    const nearest =
      toDraw && (!toRead[0] || toDraw.distance < toRead[0].distance)
        ? toDraw
        : (toRead[0] ?? null)
    if (!nearest) {
      if (!waiting && this.reading.size === 0 && !this.drawing) {
        this.complete = true
      }
      this.deps.queue.withdraw(this.client)
      return
    }
    const canDraw = !this.drawing && this.deps.idle()
    if (this.bytes >= BUDGET_BYTES) {
      // Full: a page nearer than the farthest one held takes its place —
      // once it can be had now, or a page would go for nothing.
      const canTake =
        nearest === toDraw ? canDraw : this.reading.size < READS_AT_ONCE
      if (
        !canTake ||
        !farthestHeld ||
        farthestHeld.distance <= nearest.distance
      ) {
        this.deps.queue.withdraw(this.client)
        return
      }
      this.forget(key(farthestHeld.path, farthestHeld.page))
    }

    for (const wanted of toRead) {
      if (this.reading.size >= READS_AT_ONCE) break
      if (toDraw && wanted.distance > toDraw.distance) break
      this.read(wanted)
    }

    if (!toDraw || !canDraw) {
      this.deps.queue.withdraw(this.client)
      return
    }
    this.next = toDraw
    if (!this.deps.queue.tryStart(this.client)) return
    const drawn = toDraw
    this.drawing = true
    void this.draw(drawn).finally(() => {
      this.drawing = false
      this.deps.queue.finish()
    })
  }

  /** Lets go of the pictures the board no longer shows — a spread folded
   * away, a card read on, a file closed or deleted. The device keeps them.
   * Called whenever the board changes. */
  retain(): void {
    // The pages wanted, or where they are, may have changed.
    this.complete = false
    const keys = new Set<string>()
    const paths = new Set<string>()
    for (const wanted of this.deps.wanted()) {
      keys.add(key(wanted.path, wanted.page))
      paths.add(wanted.path)
    }
    for (const path of [...this.files.keys()]) {
      if (!paths.has(path)) this.dropFile(path)
    }
    for (const k of [...this.entries.keys()]) {
      if (!keys.has(k)) this.forget(k)
    }
  }

  /** The file at `path` was modified, renamed or deleted: what is held of
   * it is of the old file. */
  fileChanged(path: string): void {
    if (this.files.has(path)) this.dropFile(path)
  }

  destroy(): void {
    this.destroyed = true
    this.deps.queue.withdraw(this.client)
    for (const path of [...this.files.keys()]) this.dropFile(path)
    for (const entry of this.entries.values()) this.close(entry)
    this.entries.clear()
    this.bytes = 0
  }

  /** The state of a file whose pages are wanted, asking the store what it
   * has of it on first sight. */
  private file(path: string): FileState | null {
    const known = this.files.get(path)
    if (known) return known
    const mtime = this.deps.mtime(path)
    if (mtime === null) return null
    const file: FileState = {
      path,
      mtime,
      stored: null,
      document: null,
      disposeStale: null,
    }
    this.files.set(path, file)
    void this.deps.store.pages(path, mtime).then(
      (pages) => {
        if (this.files.get(path) === file) file.stored = new Set(pages)
      },
      (error: unknown) => {
        this.deps.reportError('pdf thumbnail pages', error)
        if (this.files.get(path) === file) file.stored = new Set()
      },
    )
    return file
  }

  private read(wanted: WantedThumbnail): void {
    const file = this.files.get(wanted.path)
    if (!file?.stored) return
    const k = key(wanted.path, wanted.page)
    this.reading.add(k)
    void (async () => {
      const data = await this.deps.store.read(
        file.path,
        file.mtime,
        wanted.page,
      )
      if (this.files.get(file.path) !== file) return
      if (!data) {
        // Gone from the device after all: drawn instead.
        file.stored?.delete(wanted.page)
        return
      }
      const win = this.deps.doc.defaultView
      if (!win) return
      const bitmap = await win.createImageBitmap(new Blob([data]))
      if (this.destroyed || this.files.get(file.path) !== file) {
        bitmap.close()
        return
      }
      this.hold(k, bitmap)
      this.deps.onChange(file.path, wanted.page)
    })()
      .catch((error: unknown) => {
        if (this.files.get(file.path) !== file) return
        // An unreadable image is drawn again, over it.
        this.deps.reportError('pdf thumbnail read', error)
        file.stored?.delete(wanted.page)
      })
      .finally(() => {
        this.reading.delete(k)
      })
  }

  private async draw(wanted: WantedThumbnail): Promise<void> {
    const file = this.files.get(wanted.path)
    if (!file) return
    const canvas = this.deps.doc.createElement('canvas')
    try {
      const handle = await this.document(file)
      if (this.destroyed || handle.isStale()) return
      // A folded card asks for the pages its reader could show below where
      // it was left, which near the end runs past the last.
      if (wanted.page > handle.pageCount) {
        this.failed.add(key(wanted.path, wanted.page))
        return
      }
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
      if (!win || this.destroyed || this.files.get(file.path) !== file) return
      const [bitmap, encoded] = await Promise.all([
        win.createImageBitmap(canvas),
        encode(canvas),
      ])
      if (this.destroyed || this.files.get(file.path) !== file) {
        bitmap.close()
        return
      }
      this.hold(key(wanted.path, wanted.page), bitmap)
      if (encoded) {
        this.deps.store.write(
          file.path,
          file.mtime,
          wanted.page,
          await encoded.arrayBuffer(),
        )
        file.stored?.add(wanted.page)
      }
      this.deps.onChange(wanted.path, wanted.page)
    } catch (error) {
      // A file dropped meanwhile was closed under the draw: not a failure.
      if (this.files.get(file.path) !== file) return
      this.deps.reportError('pdf thumbnail', error)
      this.failed.add(key(wanted.path, wanted.page))
    } finally {
      canvas.width = 0
      canvas.height = 0
    }
  }

  private document(file: FileState): Promise<YoloModuleHostPdfDocumentV1> {
    if (file.document) return file.document
    const opened = this.deps.pdf.open(file.path)
    file.document = opened
    void opened.then(
      (handle) => {
        // Dropped before it opened: `dropFile` has released it.
        if (this.files.get(file.path) !== file) return
        // A changed file's pictures are of the old file.
        file.disposeStale = handle.subscribe(() => this.dropFile(file.path))
      },
      () => {
        if (this.files.get(file.path) === file) file.document = null
      },
    )
    return opened
  }

  private hold(k: string, bitmap: ImageBitmap): void {
    this.forget(k)
    this.entries.set(k, { bitmap, dark: null })
    this.bytes += bitmap.width * bitmap.height * 4
  }

  private dropFile(path: string): void {
    this.complete = false
    const file = this.files.get(path)
    this.files.delete(path)
    file?.disposeStale?.()
    void file?.document?.then(
      (handle) => handle.release(),
      () => undefined,
    )
    const suffix = `\n${path}`
    for (const k of [...this.entries.keys()]) {
      if (k.endsWith(suffix)) this.forget(k)
    }
    for (const k of [...this.failed]) {
      if (k.endsWith(suffix)) this.failed.delete(k)
    }
    if (!this.destroyed) this.deps.onChange(path, null)
  }

  private forget(k: string): void {
    const entry = this.entries.get(k)
    if (!entry) return
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

function encode(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) =>
    canvas.toBlob(resolve, ENCODING, ENCODING_QUALITY),
  )
}
