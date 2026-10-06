// Exporting part of a board as a picture: a PNG or a one-page PDF written to
// a file the user chose, or a PNG put on the clipboard.
//
// The board draws itself. An export does not have a renderer of its own: it
// covers the board (./exportOverlay.ts), walks the camera across what is
// being exported one part at a time (domain/exportLayout.ts) at scale 1, and
// at each stop waits for the board to have mounted and built everything
// there, exactly as it would for someone panning to it — then copies the DOM
// into a picture of that part (./boardSnapshot.ts) and draws it at the
// export's resolution. A row of parts is written out (domain/imageFiles.ts)
// before the next is begun, and the camera goes back where it was at the end,
// however the export ends.
//
// Popout safety: frames, observers and canvases come from the board's own
// window and document.

import {
  type ExportRect,
  exportPixelSize,
  exportRows,
} from '../../domain/exportLayout'
import {
  type ByteSink,
  ImagePdfWriter,
  PDF_POINTS_PER_WORLD_UNIT,
  PngWriter,
} from '../../domain/imageFiles'

import { BoardSnapshotter, type SnapshotServices } from './boardSnapshot'
import { createBrowserDeflater, deflateAll } from './deflate'
import { ExportOverlay } from './exportOverlay'

export type ExportFormat = 'png' | 'pdf'

/** How long the board must have changed nothing before a stop counts as
 * built, in milliseconds: the work it does arrives over several frames. */
const SETTLED_QUIET_MS = 150
/** How long a stop is waited on at most. Something on it that never
 * settles — a card still loading a file that is not coming — must not hold
 * the export up for ever; the stop is photographed as it stands. */
const STOP_TIMEOUT_MS = 8000
/** Bytes gathered before a write to the file: the encoders hand over
 * pieces as small as a chunk's four-byte length. */
const WRITE_BUFFER_BYTES = 1 << 20

export type BoardExportDeps = Readonly<{
  rootEl: HTMLElement
  viewportEl: HTMLElement
  worldEl: HTMLElement
  snapshot: SnapshotServices
  /** Puts the camera at scale 1 with world point (`x`, `y`) at the
   * viewport's top-left corner. */
  moveCamera(x: number, y: number): void
  /** Whether the board has nothing left to mount or build. */
  isSettled(): boolean
  text: Readonly<{
    title: string
    cancel: string
    progress: (done: number, total: number) => string
  }>
}>

export type ExportRequest = Readonly<{
  region: ExportRect
  pixelRatio: number
}>

export class ExportCancelled extends Error {
  constructor() {
    super('The export was cancelled')
    this.name = 'ExportCancelled'
  }
}

/**
 * Draws `request` and writes it as `format` to `sink`. Rejects with
 * `ExportCancelled` when the user stops it.
 */
export async function writeBoardPicture(
  deps: BoardExportDeps,
  request: ExportRequest,
  format: ExportFormat,
  sink: ByteSink,
): Promise<void> {
  const { width, height } = exportPixelSize(request.region, request.pixelRatio)
  const buffered = bufferedSink(sink)
  await tourBoard(deps, request, async () => {
    if (format === 'png') {
      const png = new PngWriter(
        width,
        height,
        buffered.write,
        createBrowserDeflater,
      )
      return {
        row: (rgb, h) => png.writeRows(rgb, h),
        finish: () => png.finish(),
      }
    }
    const pdf = new ImagePdfWriter(buffered.write, {
      pageWidth: request.region.w * PDF_POINTS_PER_WORLD_UNIT,
      pageHeight: request.region.h * PDF_POINTS_PER_WORLD_UNIT,
      pixelWidth: width,
      pixelHeight: height,
    })
    return {
      row: async (rgb, h) =>
        pdf.addBand(await deflateAll(rgb.subarray(0, h * width * 3)), h),
      finish: () => pdf.finish(),
    }
  })
  await buffered.flush()
}

type RowWriter = Readonly<{
  row(rgb: Uint8Array, rows: number): Promise<void>
  finish(): Promise<void>
}>

async function tourBoard(
  deps: BoardExportDeps,
  request: ExportRequest,
  begin: () => Promise<RowWriter>,
): Promise<void> {
  const doc = deps.rootEl.ownerDocument
  const win = doc.defaultView
  if (!win) throw new Error('The board has no window')
  let cancelled = false
  const overlay = new ExportOverlay(
    deps.rootEl,
    { title: deps.text.title, cancel: deps.text.cancel },
    () => {
      cancelled = true
    },
  )
  const check = (): void => {
    if (cancelled) throw new ExportCancelled()
  }
  try {
    const { width } = exportPixelSize(request.region, request.pixelRatio)
    const rows = exportRows(request.region, request.pixelRatio, {
      w: deps.viewportEl.clientWidth,
      h: deps.viewportEl.clientHeight,
    })
    const total = rows.reduce((sum, row) => sum + row.tiles.length, 0)
    let done = 0
    overlay.setProgress(0, total, deps.text.progress(0, total))
    const snapshotter = new BoardSnapshotter(
      deps.rootEl,
      deps.worldEl,
      deps.snapshot,
    )
    const background = snapshotter.background()
    const writer = await begin()
    const rowBytes = new Uint8Array(width * 3 * (rows[0]?.h ?? 0))
    const canvas = doc.createElement('canvas')
    for (const row of rows) {
      for (const tile of row.tiles) {
        check()
        deps.moveCamera(tile.world.x, tile.world.y)
        await settle(deps, win, check)
        const svg = await snapshotter.tile(
          tile.world,
          tile.px.w,
          tile.px.h,
          request.pixelRatio,
        )
        check()
        const pixels = await rasterize(
          canvas,
          svg,
          tile.px.w,
          tile.px.h,
          background,
        )
        copyRgb(pixels, rowBytes, tile.px.x, tile.px.w, tile.px.h, width)
        done += 1
        overlay.setProgress(done, total, deps.text.progress(done, total))
      }
      check()
      await writer.row(rowBytes, row.h)
    }
    await writer.finish()
  } finally {
    overlay.destroy()
  }
}

/** Waits for the board to have built what the camera now shows. */
async function settle(
  deps: BoardExportDeps,
  win: Window,
  check: () => void,
): Promise<void> {
  const started = win.performance.now()
  let changedAt = started
  const observer = new (win as Window & typeof globalThis).MutationObserver(
    () => {
      changedAt = win.performance.now()
    },
  )
  observer.observe(deps.worldEl, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  })
  try {
    for (;;) {
      await new Promise<void>((resolve) =>
        win.requestAnimationFrame(() => resolve()),
      )
      check()
      const now = win.performance.now()
      if (deps.isSettled() && now - changedAt >= SETTLED_QUIET_MS) break
      if (now - started >= STOP_TIMEOUT_MS) break
    }
  } finally {
    observer.disconnect()
  }
  await Promise.all(
    Array.from(deps.worldEl.querySelectorAll('img'), (img) =>
      img.decode().catch(() => undefined),
    ),
  )
}

/** The pixels of one part, drawn from its SVG onto the board's background. */
async function rasterize(
  canvas: HTMLCanvasElement,
  svg: string,
  width: number,
  height: number,
  background: string,
): Promise<Uint8ClampedArray> {
  const doc = canvas.ownerDocument
  const img = doc.createElement('img')
  // A data URL, not a blob URL: Chromium counts an SVG holding a
  // `<foreignObject>` as cross-origin when it comes from a blob, and a
  // canvas it is drawn on can no longer be read back.
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await img.decode()
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('No 2D context for the export')
  ctx.fillStyle = background
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(img, 0, 0, width, height)
  return ctx.getImageData(0, 0, width, height).data
}

/** One part's RGBA pixels into its place in the row's RGB bytes. */
function copyRgb(
  rgba: Uint8ClampedArray,
  row: Uint8Array,
  left: number,
  width: number,
  height: number,
  rowWidth: number,
): void {
  for (let y = 0; y < height; y += 1) {
    let from = y * width * 4
    let to = (y * rowWidth + left) * 3
    for (let x = 0; x < width; x += 1) {
      row[to] = rgba[from]
      row[to + 1] = rgba[from + 1]
      row[to + 2] = rgba[from + 2]
      from += 4
      to += 3
    }
  }
}

/** `sink`, written to in pieces of about `WRITE_BUFFER_BYTES`. */
function bufferedSink(sink: ByteSink): Readonly<{
  write: ByteSink
  flush(): Promise<void>
}> {
  let parts: Uint8Array[] = []
  let size = 0
  const flush = async (): Promise<void> => {
    if (size === 0) return
    const out = new Uint8Array(size)
    let offset = 0
    for (const part of parts) {
      out.set(part, offset)
      offset += part.length
    }
    parts = []
    size = 0
    await sink(out)
  }
  return {
    write: async (chunk) => {
      if (chunk.length >= WRITE_BUFFER_BYTES) {
        await flush()
        await sink(chunk)
        return
      }
      parts.push(chunk.slice())
      size += chunk.length
      if (size >= WRITE_BUFFER_BYTES) await flush()
    },
    flush,
  }
}
