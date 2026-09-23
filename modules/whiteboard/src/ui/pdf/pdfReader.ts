// A self-contained PDF reader: one vault PDF as a continuous column of pages,
// drawn through the Host API's `pdf` facade. The whiteboard's PDF card is one
// instance (ui/canvas/cardRenderer.ts); the in-view reading panel is meant to
// be another over the same file, so nothing here knows about cards, the board
// or the camera — whoever mounts it says how much it is being zoomed
// (`setViewScale`), whether it is the one being read (`setInteractive`), and
// whether the frame it is in may take on work (`canStartWork`).
//
// Why not pdf.js's own `PDFViewer`: it owns scrolling, virtualization and
// resize observation for its container, which is exactly what the board
// already does for its cards; two of those nested inside each other fight
// (see design.md §3).
//
// Pages are virtualized. Every page has a sized placeholder, so the column is
// the document's real height and the scroll position means what it says; only
// pages near the reader's viewport get a canvas (and, while interactive, a
// text layer), and pages scrolled far away give theirs back along with what
// the engine held for drawing them (`page.cleanup`).
//
// Sharpness under zoom: the reader lays pages out in its own layout pixels,
// which the transform around it scales. A pan or zoom only moves that
// transform; once the zoom has held still for ZOOM_SETTLE_MS the visible
// pages are redrawn at the density the screen now shows them at. The engine
// keeps the previous picture until the new one is complete, so a redraw never
// flashes, and a new draw into a canvas cancels the one it supersedes.
//
// Every DOM object comes from the container's own document and window, so a
// reader in a popout window draws, observes and schedules in that window.

import {
  type PageSize,
  READER_METRICS,
  type ReaderLayout,
  layoutPages,
  needsSharperBitmap,
  pagesInBand,
  parsePageInput,
  positionAt,
  scrollTopFor,
} from './readerLayout'

type Translate = (key: string) => string
type PdfPage = YoloModuleHostPdfPageV1
type PdfTask<T> = YoloModuleHostPdfTaskV1<T>

export type PdfReaderOptions = Readonly<{
  pdf: YoloModuleHostPdfV1
  /** Vault path of the PDF. */
  path: string
  /** Emptied and given the reader. */
  container: HTMLElement
  /** Where to open, as a 1-based fractional page (readerLayout's
   * `positionAt`). Defaults to the top of page 1. */
  position?: number
  /** The scale of whatever transforms the reader on screen. */
  viewScale?: number
  interactive?: boolean
  t: Translate
  /** Asked before starting a draw or a text layer; a reader on a board holds
   * back while frames are late. Always yes when omitted. */
  canStartWork?: () => boolean
  /** Called when the reading position changes — by scrolling, a page jump,
   * or a relayout that moved the column under it. */
  onPositionChange?: (position: number) => void
  reportError?: (stage: string, error: unknown) => void
}>

/** How long a zoom (or a resize) has to hold still before the visible pages
 * are redrawn at the new density — the old spike's strategy B. */
const ZOOM_SETTLE_MS = 250
/** Pages within this many viewport heights above or below are drawn. */
const DRAW_OVERSCAN_VIEWPORTS = 0.5
/** Pages beyond this many viewport heights give their canvas back. The gap
 * between the two is the hysteresis that stops a page scrolled back and forth
 * across one line from being dropped and redrawn. */
const KEEP_OVERSCAN_VIEWPORTS = 2
/** Draws one reader may have running at once. The engine renders on the main
 * thread in slices; more than two at a time only interleaves them. */
const MAX_DRAWS_IN_FLIGHT = 2

const READER_CLASS = 'yolo-whiteboard-pdf-reader'
const SCROLLER_CLASS = 'yolo-whiteboard-pdf-scroller'
const PAGES_CLASS = 'yolo-whiteboard-pdf-pages'
const PAGE_CLASS = 'yolo-whiteboard-pdf-page'
const CANVAS_CLASS = 'yolo-whiteboard-pdf-canvas'
const TEXT_LAYER_HOST_CLASS = 'yolo-whiteboard-pdf-text'
const INDICATOR_CLASS = 'yolo-whiteboard-pdf-indicator'
const PAGE_INPUT_CLASS = 'yolo-whiteboard-pdf-page-input'
const PAGE_COUNT_CLASS = 'yolo-whiteboard-pdf-page-count'
const STATUS_CLASS = 'yolo-whiteboard-pdf-status'
const STATUS_ERROR_CLASS = 'yolo-whiteboard-pdf-status-error'
const STATUS_HINT_CLASS = 'yolo-whiteboard-pdf-status-hint'

type Slot = {
  readonly index: number
  readonly el: HTMLElement
  /** The page's own size, once it has been loaded; until then the layout
   * uses the first page's (`estimate`). */
  size: PageSize | null
  page: PdfPage | null
  loading: boolean
  canvas: HTMLCanvasElement | null
  draw: PdfTask<unknown> | null
  /** The layout scale and pixel ratio the canvas's picture was drawn at, or
   * 0 when it holds none worth keeping (never drawn, or drawn from a file
   * that has since changed). */
  drawnScale: number
  drawnRatio: number
  textEl: HTMLElement | null
  textLayer: YoloModuleHostPdfTextLayerV1 | null
  textTask: PdfTask<YoloModuleHostPdfTextLayerV1> | null
  textScale: number
}

export class PdfReader {
  readonly path: string
  private readonly options: PdfReaderOptions
  private readonly rootEl: HTMLElement
  private readonly scrollerEl: HTMLElement
  private readonly pagesEl: HTMLElement
  private readonly indicatorEl: HTMLElement
  private readonly inputEl: HTMLInputElement
  private readonly countEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly resizeObserver: ResizeObserver | null

  private handle: YoloModuleHostPdfDocumentV1 | null = null
  private unsubscribeStale: (() => void) | null = null
  /** Bumped by every open and by destroy; an async result from an older one
   * is dropped rather than applied to a document it does not belong to. */
  private generation = 0
  private slots: Slot[] = []
  /** Slots holding a canvas, a text layer or work in flight — the only ones
   * a scroll has to consider releasing. */
  private readonly active = new Set<Slot>()
  private estimate: PageSize = { width: 612, height: 792 }
  private layout: ReaderLayout | null = null
  private layoutWidth = 0
  /** The position to restore once the reader has a size to lay out at. */
  private position: number
  /**
   * A position the scroller could not be put at yet, because it was not
   * scrollable when asked — measured in a popout the leaf has just migrated
   * to, whose stylesheet arrives after the view is rebuilt, so for a moment
   * the scroller is as tall as the whole column. Until it can be applied it
   * is the reader's position; reading the scroll offset instead would read
   * the top of the document and save that.
   */
  private pendingPosition: number | null = null
  private reportedPosition: number | null = null

  private viewScale: number
  private settledViewScale: number
  private settleTimer: number | null = null
  private interactive: boolean
  private visible = true
  private frameId: number | null = null
  private drawsInFlight = 0
  private failed = false
  private destroyed = false

  constructor(options: PdfReaderOptions) {
    this.options = options
    this.path = options.path
    this.position = options.position ?? 1
    this.viewScale = options.viewScale ?? 1
    this.settledViewScale = this.viewScale
    this.interactive = options.interactive ?? false

    const doc = options.container.ownerDocument
    this.rootEl = doc.createElement('div')
    this.rootEl.className = READER_CLASS
    this.scrollerEl = doc.createElement('div')
    this.scrollerEl.className = SCROLLER_CLASS
    this.pagesEl = doc.createElement('div')
    this.pagesEl.className = PAGES_CLASS
    this.scrollerEl.appendChild(this.pagesEl)

    this.indicatorEl = doc.createElement('div')
    this.indicatorEl.className = INDICATOR_CLASS
    this.inputEl = doc.createElement('input')
    this.inputEl.className = PAGE_INPUT_CLASS
    this.inputEl.type = 'text'
    this.inputEl.inputMode = 'numeric'
    this.inputEl.spellcheck = false
    this.inputEl.setAttribute('aria-label', options.t('pdf.pageInput'))
    this.countEl = doc.createElement('span')
    this.countEl.className = PAGE_COUNT_CLASS
    this.indicatorEl.append(this.inputEl, this.countEl)
    this.indicatorEl.hidden = true

    this.statusEl = doc.createElement('div')
    this.statusEl.className = STATUS_CLASS

    this.rootEl.append(this.scrollerEl, this.indicatorEl, this.statusEl)
    options.container.replaceChildren(this.rootEl)

    this.scrollerEl.addEventListener('scroll', this.onScroll, { passive: true })
    this.inputEl.addEventListener('focus', this.onInputFocus)
    this.inputEl.addEventListener('blur', this.onInputBlur)
    this.inputEl.addEventListener('keydown', this.onInputKeyDown)

    const win = doc.defaultView
    this.resizeObserver = win?.ResizeObserver
      ? new win.ResizeObserver(() => this.schedule())
      : null
    this.resizeObserver?.observe(this.scrollerEl)

    this.showStatus(options.t('pdf.loading'))
    void this.open()
  }

  // -----------------------------------------------------------------------
  // Public surface
  // -----------------------------------------------------------------------

  /** Where the reader is, as a 1-based fractional page. */
  getPosition(): number {
    if (this.pendingPosition !== null) return this.pendingPosition
    if (!this.layout) return this.position
    return positionAt(this.layout, this.scrollerEl.scrollTop)
  }

  /** Scrolls to a 1-based fractional page. */
  setPosition(position: number): void {
    if (!Number.isFinite(position)) return
    this.position = position
    this.pendingPosition = null
    if (!this.layout) return
    this.applyScroll(this.layout, position)
    this.schedule()
  }

  goToPage(page: number): void {
    this.setPosition(Math.floor(page))
  }

  /**
   * Scrolls by a wheel delta, reporting whether there was anywhere to go —
   * false hands the gesture back to whoever asked (the board pans instead).
   */
  scrollBy(deltaX: number, deltaY: number): boolean {
    if (!this.layout) return false
    const scroller = this.scrollerEl
    const room = scroller.scrollHeight - scroller.clientHeight
    if (room <= 0) return false
    this.pendingPosition = null
    scroller.scrollTop = Math.max(
      0,
      Math.min(room, scroller.scrollTop + deltaY),
    )
    scroller.scrollLeft += deltaX
    return true
  }

  /**
   * The scale of the transform the reader is shown under. Pages are redrawn
   * for it only once it has held still (ZOOM_SETTLE_MS); in between, the
   * transform scales the pictures already drawn.
   */
  setViewScale(scale: number): void {
    if (!(scale > 0) || scale === this.viewScale) return
    this.viewScale = scale
    this.unsettle()
  }

  /** Whether this reader is the one being read: only then do its pages carry
   * text layers, which are what selection needs and what a board full of
   * PDFs should not pay for. */
  setInteractive(interactive: boolean): void {
    if (interactive === this.interactive) return
    this.interactive = interactive
    if (!interactive) {
      for (const slot of this.active) this.releaseTextLayer(slot)
    }
    this.schedule()
  }

  /** Whether the reader is on screen at all. A hidden one does no work; the
   * pictures it has drawn stay. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    if (visible) this.schedule()
    else this.cancelFrame()
  }

  /** Opens the file again if the last attempt failed — the file may have
   * been repaired, or the engine installed, since. */
  retryIfFailed(): void {
    if (this.failed && !this.destroyed) void this.open()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.generation += 1
    this.cancelFrame()
    if (this.settleTimer !== null) {
      this.window()?.clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
    this.resizeObserver?.disconnect()
    this.scrollerEl.removeEventListener('scroll', this.onScroll)
    this.inputEl.removeEventListener('focus', this.onInputFocus)
    this.inputEl.removeEventListener('blur', this.onInputBlur)
    this.inputEl.removeEventListener('keydown', this.onInputKeyDown)
    for (const slot of this.slots) this.releaseSlot(slot)
    this.slots = []
    this.unsubscribeStale?.()
    this.unsubscribeStale = null
    this.handle?.release()
    this.handle = null
    this.rootEl.remove()
  }

  // -----------------------------------------------------------------------
  // Opening, and reopening a file that changed
  // -----------------------------------------------------------------------

  private async open(): Promise<void> {
    const generation = ++this.generation
    let handle: YoloModuleHostPdfDocumentV1
    let first: PdfPage
    try {
      handle = await this.options.pdf.open(this.path)
    } catch (error) {
      if (generation === this.generation) this.fail(error)
      return
    }
    try {
      if (generation !== this.generation) throw abortError()
      first = await handle.getPage(1)
      if (generation !== this.generation) throw abortError()
    } catch (error) {
      handle.release()
      if (generation === this.generation) this.fail(error)
      return
    }

    // Where the reader was, read before anything moves: a reopen keeps the
    // place, and a first open goes where it was asked to.
    const position = this.layout ? this.getPosition() : this.position
    this.unsubscribeStale?.()
    this.handle?.release()
    this.handle = handle
    // A file that changes on disk is reopened in place: the old pictures stay
    // up until the new ones replace them, and the position survives.
    this.unsubscribeStale = handle.subscribe(() => {
      if (!this.destroyed) void this.open()
    })
    this.failed = false
    this.hideStatus()
    this.estimate = { width: first.width, height: first.height }
    this.rebuildSlots(handle.pageCount)
    this.slots[0].page = first
    this.slots[0].size = this.estimate
    this.countEl.textContent = `/ ${handle.pageCount}`
    this.indicatorEl.hidden = false
    this.layout = null
    this.relayout(position)
    this.schedule()
  }

  private fail(error: unknown): void {
    this.failed = true
    this.options.reportError?.('pdf open', error)
    // A file that went bad after it had been read keeps showing what it was;
    // only a reader with nothing to show says it has nothing.
    if (this.slots.length > 0) return
    this.showStatus(
      this.options.t('pdf.openFailed'),
      error instanceof Error ? error.message : String(error),
    )
  }

  /**
   * Sizes the slot list to the document. Slots that survive a reopen keep
   * their elements and their pictures — marked as needing a redraw, and
   * handed no page until the new document gives them one.
   */
  private rebuildSlots(pageCount: number): void {
    for (const slot of this.slots.slice(pageCount)) {
      this.releaseSlot(slot)
      slot.el.remove()
    }
    this.slots = this.slots.slice(0, pageCount)
    for (const slot of this.slots) {
      slot.draw?.cancel()
      slot.draw = null
      slot.drawnScale = 0
      slot.drawnRatio = 0
      slot.page = null
      slot.loading = false
      slot.size = null
      this.releaseTextLayer(slot)
    }
    const doc = this.rootEl.ownerDocument
    for (let index = this.slots.length; index < pageCount; index += 1) {
      const el = doc.createElement('div')
      el.className = PAGE_CLASS
      this.pagesEl.appendChild(el)
      this.slots.push({
        index,
        el,
        size: null,
        page: null,
        loading: false,
        canvas: null,
        draw: null,
        drawnScale: 0,
        drawnRatio: 0,
        textEl: null,
        textLayer: null,
        textTask: null,
        textScale: 0,
      })
    }
  }

  // -----------------------------------------------------------------------
  // Layout
  // -----------------------------------------------------------------------

  /**
   * Lays every page out at the reader's current width and puts `position`
   * back at the top. Waits (keeping `position`) while the reader has no width
   * — it is not in the document, or is hidden.
   */
  private relayout(position: number): void {
    const width = this.scrollerEl.clientWidth
    if (!(width > 0)) {
      this.position = position
      return
    }
    const layout = layoutPages(
      this.slots.map((slot) => slot.size ?? this.estimate),
      width,
    )
    this.layout = layout
    this.layoutWidth = width
    this.pagesEl.style.padding = `${READER_METRICS.padding}px`
    this.slots.forEach((slot, index) => {
      slot.el.style.width = `${layout.pageWidth}px`
      slot.el.style.height = `${layout.heights[index]}px`
      slot.el.style.marginTop = index === 0 ? '0' : `${READER_METRICS.gap}px`
      // A text layer is laid out in the page's own pixels, so a new width is
      // a new scale for it — cheap to apply, and needed at once, because the
      // spans are what a selection lands on.
      if (slot.textLayer && slot.textScale !== layout.scales[index]) {
        slot.textScale = layout.scales[index]
        slot.textLayer.setScale(slot.textScale)
      }
    })
    this.applyScroll(layout, position)
    this.position = position
  }

  /** Puts `position` at the top, or holds it (`pendingPosition`) while the
   * scroller has nowhere to scroll. */
  private applyScroll(layout: ReaderLayout, position: number): void {
    const scroller = this.scrollerEl
    const target = scrollTopFor(layout, position)
    if (target > 1 && scroller.scrollHeight - scroller.clientHeight < 1) {
      this.pendingPosition = position
      return
    }
    scroller.scrollTop = target
    this.pendingPosition = null
  }

  // -----------------------------------------------------------------------
  // The work loop: one pass per frame while there is anything to do
  // -----------------------------------------------------------------------

  private readonly onScroll = (): void => {
    this.schedule()
  }

  private schedule(): void {
    if (this.destroyed || !this.visible || this.frameId !== null) return
    const win = this.window()
    if (!win) return
    this.frameId = win.requestAnimationFrame(this.update)
  }

  private cancelFrame(): void {
    if (this.frameId === null) return
    this.window()?.cancelAnimationFrame(this.frameId)
    this.frameId = null
  }

  private readonly update = (): void => {
    this.frameId = null
    if (this.destroyed || !this.visible || !this.handle) return
    const scroller = this.scrollerEl
    const width = scroller.clientWidth
    if (!(width > 0)) return
    if (!this.layout || Math.abs(width - this.layoutWidth) > 0.5) {
      const hadLayout = this.layout !== null
      this.relayout(hadLayout ? this.getPosition() : this.position)
      // A resize is settled like a zoom: the pictures stretch with their
      // pages until the width holds still, then they are redrawn.
      if (hadLayout) this.unsettle()
    }
    const layout = this.layout
    if (!layout) return
    if (this.pendingPosition !== null) {
      this.applyScroll(layout, this.pendingPosition)
      // Still nowhere to scroll. The scroller's resize observer asks again
      // when it gets its real size; a document that simply fits never
      // scrolls, so there is nothing to wait for in a loop.
      if (this.pendingPosition !== null) return
    }
    const scrollTop = scroller.scrollTop
    const height = scroller.clientHeight
    if (!(height > 0)) return

    this.reportPosition(positionAt(layout, scrollTop))

    const draw = pagesInBand(
      layout,
      scrollTop,
      height,
      height * DRAW_OVERSCAN_VIEWPORTS,
    )
    const keep = pagesInBand(
      layout,
      scrollTop,
      height,
      height * KEEP_OVERSCAN_VIEWPORTS,
    )
    for (const slot of [...this.active]) {
      if (!keep || slot.index < keep.first || slot.index > keep.last) {
        this.releaseSlot(slot)
      }
    }
    if (!draw) return

    // Nearest the middle of the viewport first, so what is being looked at
    // is what gets drawn first.
    const middle = scrollTop + height / 2
    const order: Slot[] = []
    for (let index = draw.first; index <= draw.last; index += 1) {
      order.push(this.slots[index])
    }
    order.sort(
      (a, b) =>
        Math.abs(layout.tops[a.index] + layout.heights[a.index] / 2 - middle) -
        Math.abs(layout.tops[b.index] + layout.heights[b.index] / 2 - middle),
    )
    let deferred = false
    for (const slot of order) {
      if (!slot.page) {
        this.loadPage(slot)
        continue
      }
      if (this.needsDraw(slot, layout)) {
        if (this.drawsInFlight >= MAX_DRAWS_IN_FLIGHT) continue
        if (!this.mayStartWork()) {
          deferred = true
          continue
        }
        this.drawPage(slot, layout)
      }
      if (this.interactive && !slot.textLayer && !slot.textTask) {
        if (!this.mayStartWork()) {
          deferred = true
          continue
        }
        this.buildTextLayer(slot, layout)
      }
    }
    // Held back by a late frame: ask again on the next one. Everything else
    // that is pending (a page loading, a draw running) schedules the next pass
    // itself when it lands.
    if (deferred) this.schedule()
  }

  private mayStartWork(): boolean {
    return this.options.canStartWork?.() ?? true
  }

  private get settled(): boolean {
    return this.settleTimer === null
  }

  /** A zoom or a resize just happened: hold redraws until it stops. */
  private unsettle(): void {
    const win = this.window()
    if (!win) return
    if (this.settleTimer !== null) win.clearTimeout(this.settleTimer)
    this.settleTimer = win.setTimeout(() => {
      this.settleTimer = null
      this.settledViewScale = this.viewScale
      this.schedule()
    }, ZOOM_SETTLE_MS)
  }

  /**
   * Device pixels per layout pixel to draw a page at: the density the screen
   * shows it at once the zoom has settled. A page with no picture yet is
   * drawn for the zoom as it is right now instead — it is going to be drawn
   * either way, and drawing it for a scale the camera has already left would
   * only mean drawing it again.
   */
  private wantedRatio(fresh = false): number {
    const dpr = this.window()?.devicePixelRatio ?? 1
    return (fresh ? this.viewScale : this.settledViewScale) * dpr
  }

  private needsDraw(slot: Slot, layout: ReaderLayout): boolean {
    if (slot.draw) return false
    if (!slot.canvas || slot.drawnRatio === 0) return true
    // A picture that is merely the wrong density waits for the zoom or the
    // resize to stop; one that is missing or stale (above) never waits.
    if (!this.settled) return false
    const scale = layout.scales[slot.index]
    const shown = (slot.drawnScale * slot.drawnRatio) / scale
    return needsSharperBitmap(shown, this.wantedRatio())
  }

  private loadPage(slot: Slot): void {
    if (slot.loading || !this.handle) return
    slot.loading = true
    this.active.add(slot)
    const generation = this.generation
    this.handle.getPage(slot.index + 1).then(
      (page) => {
        if (generation !== this.generation) return
        slot.loading = false
        slot.page = page
        const size = { width: page.width, height: page.height }
        const known = slot.size ?? this.estimate
        slot.size = size
        // Pages are laid out at the first page's size until they are loaded;
        // one that turns out different moves everything below it, so the
        // column is laid out again around where the reader is.
        if (
          Math.abs(known.width - size.width) > 0.5 ||
          Math.abs(known.height - size.height) > 0.5
        ) {
          this.relayout(this.getPosition())
        }
        this.schedule()
      },
      (error: unknown) => {
        if (generation !== this.generation) return
        slot.loading = false
        this.options.reportError?.('pdf page', error)
      },
    )
  }

  private drawPage(slot: Slot, layout: ReaderLayout): void {
    const page = slot.page
    if (!page) return
    let canvas = slot.canvas
    if (!canvas) {
      canvas = this.rootEl.ownerDocument.createElement('canvas')
      canvas.className = CANVAS_CLASS
      slot.el.prepend(canvas)
      slot.canvas = canvas
    }
    const scale = layout.scales[slot.index]
    const ratio = this.wantedRatio(slot.drawnRatio === 0)
    const generation = this.generation
    this.active.add(slot)
    this.drawsInFlight += 1
    const task = page.render({ canvas, scale, pixelRatio: ratio })
    slot.draw = task
    task.promise
      .then(
        () => {
          if (slot.draw !== task || generation !== this.generation) return
          // The ratio asked for, not the one the engine settled on: it lowers
          // the ratio for very large pages, and comparing against that would
          // ask for the same unreachable density on every pass.
          slot.drawnScale = scale
          slot.drawnRatio = ratio
        },
        (error: unknown) => {
          if (isAbort(error)) return
          this.options.reportError?.('pdf render', error)
        },
      )
      .finally(() => {
        this.drawsInFlight -= 1
        if (slot.draw === task) slot.draw = null
        this.schedule()
      })
  }

  private buildTextLayer(slot: Slot, layout: ReaderLayout): void {
    const page = slot.page
    if (!page) return
    let textEl = slot.textEl
    if (!textEl) {
      textEl = this.rootEl.ownerDocument.createElement('div')
      textEl.className = TEXT_LAYER_HOST_CLASS
      slot.el.appendChild(textEl)
      slot.textEl = textEl
    }
    const scale = layout.scales[slot.index]
    const task = page.renderTextLayer({ container: textEl, scale })
    slot.textTask = task
    slot.textScale = scale
    this.active.add(slot)
    task.promise.then(
      (layer) => {
        if (slot.textTask !== task) return
        slot.textTask = null
        slot.textLayer = layer
        // Laid out while it was building: catch up.
        const current = this.layout?.scales[slot.index]
        if (current !== undefined && current !== slot.textScale) {
          slot.textScale = current
          layer.setScale(current)
        }
      },
      (error: unknown) => {
        if (slot.textTask === task) slot.textTask = null
        if (isAbort(error)) return
        this.options.reportError?.('pdf text layer', error)
      },
    )
  }

  private releaseTextLayer(slot: Slot): void {
    slot.textTask?.cancel()
    slot.textTask = null
    slot.textLayer?.destroy()
    slot.textLayer = null
    slot.textEl?.remove()
    slot.textEl = null
    slot.textScale = 0
  }

  /** Gives back everything a page far from the viewport holds: its picture,
   * its text layer, and what the engine kept from drawing it. */
  private releaseSlot(slot: Slot): void {
    slot.draw?.cancel()
    slot.draw = null
    if (slot.canvas) {
      // Zeroing the backing store frees it now rather than whenever the
      // element is collected.
      slot.canvas.width = 0
      slot.canvas.height = 0
      slot.canvas.remove()
      slot.canvas = null
    }
    slot.drawnScale = 0
    slot.drawnRatio = 0
    this.releaseTextLayer(slot)
    try {
      slot.page?.cleanup()
    } catch (error) {
      // A page from a document the engine has already closed has nothing
      // left to free.
      this.options.reportError?.('pdf page cleanup', error)
    }
    if (!slot.loading) this.active.delete(slot)
  }

  // -----------------------------------------------------------------------
  // Page indicator
  // -----------------------------------------------------------------------

  private reportPosition(position: number): void {
    if (
      this.reportedPosition !== null &&
      Math.abs(this.reportedPosition - position) < 0.001
    ) {
      return
    }
    const pageChanged =
      this.reportedPosition === null ||
      Math.floor(this.reportedPosition) !== Math.floor(position)
    this.reportedPosition = position
    this.position = position
    if (pageChanged) this.syncIndicator()
    this.options.onPositionChange?.(position)
  }

  private syncIndicator(): void {
    // Never under the caret: a page typed halfway is not overwritten by the
    // page the reader happens to scroll past.
    if (this.rootEl.ownerDocument.activeElement === this.inputEl) return
    this.inputEl.value = String(Math.floor(this.position))
  }

  private readonly onInputFocus = (): void => {
    this.inputEl.select()
  }

  private readonly onInputBlur = (): void => {
    this.inputEl.value = String(Math.floor(this.getPosition()))
  }

  private readonly onInputKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      const page = parsePageInput(this.inputEl.value, this.slots.length)
      if (page !== null) this.goToPage(page)
      this.inputEl.blur()
      return
    }
    if (event.key === 'Escape') {
      this.inputEl.blur()
    }
  }

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  private showStatus(title: string, hint?: string): void {
    const doc = this.rootEl.ownerDocument
    const titleEl = doc.createElement('div')
    titleEl.textContent = title
    const children: HTMLElement[] = [titleEl]
    if (hint) {
      const hintEl = doc.createElement('div')
      hintEl.className = STATUS_HINT_CLASS
      hintEl.textContent = hint
      children.push(hintEl)
    }
    this.statusEl.replaceChildren(...children)
    this.statusEl.classList.toggle(STATUS_ERROR_CLASS, hint !== undefined)
    this.statusEl.hidden = false
  }

  private hideStatus(): void {
    this.statusEl.hidden = true
    this.statusEl.replaceChildren()
  }

  private window(): Window | null {
    return this.rootEl.ownerDocument.defaultView
  }
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

function abortError(): Error {
  const error = new Error('Superseded')
  error.name = 'AbortError'
  return error
}
