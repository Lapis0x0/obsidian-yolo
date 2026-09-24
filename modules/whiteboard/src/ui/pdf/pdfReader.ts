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
//
// Two readers over one file — a card and the view's reading panel — follow
// each other through `onPositionChange` and `setPosition`. `setPosition` is
// the follower's half and is silent: the scroll it causes is not reported
// back, so the two cannot bounce a position between them.
//
// Annotations: given the PDF's annotation store (../../host/annotationStore.
// ts), every drawn page carries a layer of them between its picture and its
// text layer (./annotationLayer.ts), repainted whenever the store changes —
// which is how a highlight made in one reader appears in every other. What
// the reader reports is only what happened on its pages: text selected, an
// annotation clicked, an area framed. What to do about it (the toolbar, the
// store edits) is the owner's (./annotationController.ts).

import type { PdfRectTuple, SelectionTuple } from '../../domain/pdfAnnotations'
import type {
  AnnotationLease,
  AnnotationStore,
} from '../../host/annotationStore'
import { glideScrollBy } from '../wheelScroll'

import {
  type PageBox,
  type PageFrame,
  hitTestAnnotations,
  quadBoxes,
} from './annotationGeometry'
import {
  NOTE_CLASS,
  annotationClientRect,
  boxesFor,
  markActiveAnnotation,
  placeBox,
  renderAnnotationLayer,
} from './annotationLayer'
import { createReaderIconButton } from './icons'
import { PdfSearch } from './pdfSearch'
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
   * a search hit, or a relayout that moved the column under it. Not called
   * for a `setPosition`. */
  onPositionChange?: (position: number) => void
  /** The PDF's annotations, held for the reader: it lets go when destroyed. */
  annotations?: AnnotationLease
  annotationEvents?: ReaderAnnotationEvents
  reportError?: (stage: string, error: unknown) => void
}>

/** Text selected on a reader's pages, one piece per page it touches. */
export type ReaderTextSelection = Readonly<{
  pieces: readonly YoloModuleHostPdfTextSelectionV1[]
  /** Where the selection is on screen now — it moves as the reader scrolls
   * or the board pans — or null once it is not drawn. */
  getRect: () => DOMRect | null
}>

export type ReaderAnnotationEvents = Readonly<{
  /** A selection was made (on release), or the one reported went away. */
  onTextSelection: (
    reader: PdfReader,
    selection: ReaderTextSelection | null,
  ) => void
  /** A click on a page: on an annotation (`id`), or on none. */
  onAnnotationClick: (reader: PdfReader, id: string | null) => void
  onAnnotationContextMenu: (
    reader: PdfReader,
    id: string,
    event: MouseEvent,
  ) => void
  /** A frame was drawn in area mode: `rect` in the page's PDF space. The
   * frame stays drawn, as a selection does, until `clearPendingArea` or the
   * next press on the pages. */
  onAreaDrawn: (reader: PdfReader, page: number, rect: PdfRectTuple) => void
  /** A press on something a drag can take out: an annotation (`id`), or
   * the frame waiting on the page (null). Still a click if it does not move.
   * The press has been kept from selecting text or drawing a frame. `note`
   * when it was on the annotation's comment dot rather than on its mark. */
  onGrab: (
    reader: PdfReader,
    event: PointerEvent,
    id: string | null,
    note: boolean,
  ) => void
  /** The pointer came onto a comment dot (`id`), or left the one it
   * reported. */
  onNoteHover: (reader: PdfReader, id: string | null) => void
  /** The reader is being destroyed. */
  onReaderDestroyed: (reader: PdfReader) => void
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
const SEARCH_BUTTON_CLASS = 'yolo-whiteboard-pdf-search-open'
const AREA_BUTTON_CLASS = 'yolo-whiteboard-pdf-area-toggle'
const AREA_MODE_CLASS = 'yolo-whiteboard-pdf-reader-area-mode'
const MARKS_CLASS = 'yolo-whiteboard-pdf-marks'
const AREA_DRAFT_CLASS = 'yolo-whiteboard-pdf-area-draft'
/** On the pages while the pointer is over something a press would pick up. */
const GRABBABLE_CLASS = 'yolo-whiteboard-pdf-pages-grabbable'
/** On the pages while the pointer is over a comment dot. */
const ON_NOTE_CLASS = 'yolo-whiteboard-pdf-pages-on-note'
const FLASH_CLASS = 'yolo-whiteboard-pdf-flash'
const FLASH_SHOWN_CLASS = 'yolo-whiteboard-pdf-flash-shown'
/** How long the text a link names stays marked after the reader goes to
 * it, before it fades. */
const FLASH_HOLD_MS = 1400
/** Long enough for the fade out (style.css) to finish. */
const FLASH_FADE_MS = 400
/** A press that travels less than this is a click, not a drag. */
const CLICK_SLOP_PX = 4
/** How near a thin highlight a click still counts as on it, in CSS px. */
const HIT_SLOP_PX = 3
/** The smallest framed area kept, as a fraction of the page's width. */
const MIN_AREA_FRACTION = 0.01

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
  /** The annotation layer, while the page has a picture. */
  marksEl: HTMLElement | null
  /** The page's PDF-to-layout transform, once the page is loaded. */
  frame: PageFrame | null
}

type Press = Readonly<{
  pointerId: number
  x: number
  y: number
}>

/** A frame drawn in area mode, still on the page, waiting for what to do
 * with it (the owner's toolbar). */
type PendingArea = Readonly<{
  slot: Slot
  el: HTMLElement
}>

type AreaDraft = {
  readonly pointerId: number
  readonly slot: Slot
  readonly el: HTMLElement
  readonly startX: number
  readonly startY: number
  x: number
  y: number
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
  private readonly search: PdfSearch

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
  /** The pending position came from `setPosition`, so applying it is not
   * news to report. */
  private pendingSilently = false
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

  private readonly store: AnnotationStore | null
  private unsubscribeAnnotations: (() => void) | null = null
  private readonly areaButton: HTMLButtonElement | null = null
  private areaMode = false
  private areaDraft: AreaDraft | null = null
  private pendingArea: PendingArea | null = null
  /** A link's selection waiting for its page's text layer (`revealLocation`). */
  private pendingReveal: Readonly<{
    page: number
    selection: SelectionTuple
  }> | null = null
  private press: Press | null = null
  /** A selection was reported and has not been reported gone. */
  private selectionReported = false
  private activeAnnotationId: string | null = null
  /** The comment dot last reported under the pointer. */
  private hoveredNote: string | null = null

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
    this.store = options.annotations?.store ?? null
    if (this.store) {
      this.areaButton = createReaderIconButton(
        doc,
        AREA_BUTTON_CLASS,
        'square-dashed',
        options.t('pdf.areaMode'),
        () => this.setAreaMode(!this.areaMode),
      )
      this.areaButton.setAttribute('aria-pressed', 'false')
      this.indicatorEl.append(this.areaButton)
    }
    this.indicatorEl.append(
      createReaderIconButton(
        doc,
        SEARCH_BUTTON_CLASS,
        'search',
        options.t('pdf.search'),
        () => this.openSearch(),
      ),
      this.inputEl,
      this.countEl,
    )
    this.indicatorEl.hidden = true

    this.statusEl = doc.createElement('div')
    this.statusEl.className = STATUS_CLASS

    this.rootEl.append(this.scrollerEl, this.indicatorEl, this.statusEl)
    options.container.replaceChildren(this.rootEl)

    this.search = new PdfSearch({
      root: this.rootEl,
      t: options.t,
      getDocument: () => this.handle,
      getPosition: () => this.getPosition(),
      getTextLayer: (index) => this.slots[index]?.textLayer ?? null,
      reveal: (index, range) => this.revealSearchHit(index, range),
      reportError: options.reportError,
    })

    this.scrollerEl.addEventListener('scroll', this.onScroll, { passive: true })
    this.inputEl.addEventListener('focus', this.onInputFocus)
    this.inputEl.addEventListener('blur', this.onInputBlur)
    this.inputEl.addEventListener('keydown', this.onInputKeyDown)

    if (this.store) {
      this.unsubscribeAnnotations = this.store.subscribe(() =>
        this.renderAllMarks(),
      )
      this.pagesEl.addEventListener('pointerdown', this.onPagesPointerDown)
      this.pagesEl.addEventListener('pointermove', this.onPagesPointerMove)
      this.pagesEl.addEventListener('pointerleave', this.onPagesPointerLeave)
      this.pagesEl.addEventListener('contextmenu', this.onPagesContextMenu)
      doc.addEventListener('pointerup', this.onDocumentPointerUp)
      doc.addEventListener('pointercancel', this.onDocumentPointerUp)
      doc.addEventListener('selectionchange', this.onSelectionChange)
    }

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

  /**
   * Scrolls to a 1-based fractional page, without reporting it: this is how
   * a reader is made to follow another one, and the other one already knows
   * where it is. A reader that is hidden (parked) holds the position until
   * it is shown, since its scroller cannot be scrolled while out of layout.
   */
  setPosition(position: number): void {
    this.moveTo(position, true)
  }

  /** A page jump someone asked this reader for — reported like a scroll. */
  goToPage(page: number): void {
    this.moveTo(Math.floor(page), false)
  }

  private moveTo(position: number, silent: boolean): void {
    if (!Number.isFinite(position)) return
    this.position = position
    this.pendingPosition = null
    this.pendingSilently = silent
    if (this.layout && this.visible) {
      this.applyScroll(this.layout, position)
      if (silent && this.pendingPosition === null) {
        this.pendingSilently = false
        this.markReported()
      }
    } else if (this.layout) {
      this.pendingPosition = position
    }
    this.syncIndicator()
    this.schedule()
  }

  /** Takes where the scroller now is as already reported. */
  private markReported(): void {
    if (!this.layout) return
    this.reportedPosition = positionAt(this.layout, this.scrollerEl.scrollTop)
    this.position = this.reportedPosition
  }

  /** Opens the search bar, with the caret in it. */
  openSearch(): void {
    if (this.destroyed || !this.handle) return
    this.search.open()
  }

  closeSearch(): void {
    this.search.close()
  }

  isSearchOpen(): boolean {
    return this.search.isOpen()
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
    glideScrollBy(scroller, deltaX, deltaY)
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
      // Search paints on text layers; a reader without them has nothing to
      // show its hits on.
      this.search.close()
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

  /** The annotation store this reader draws, if it was given one. */
  getAnnotationStore(): AnnotationStore | null {
    return this.store
  }

  /** Marks one annotation as the one being acted on (or none). */
  setActiveAnnotation(id: string | null): void {
    if (id === this.activeAnnotationId) return
    this.activeAnnotationId = id
    this.pagesEl.classList.remove(GRABBABLE_CLASS)
    for (const slot of this.active) {
      if (slot.marksEl) markActiveAnnotation(slot.marksEl, id)
    }
  }

  /** Where an annotation is on screen, or null when its page is not drawn. */
  getAnnotationRect(id: string): DOMRect | null {
    const annotation = this.store?.get(id)
    if (!annotation) return null
    const marks = this.slots[annotation.anchor.page - 1]?.marksEl
    return marks ? annotationClientRect(marks, id) : null
  }

  /** Where an annotation's last line (or its frame) is on screen: what its
   * comment is written under. Null when its page is not drawn. */
  getAnnotationEndRect(id: string): DOMRect | null {
    const annotation = this.store?.get(id)
    if (!annotation) return null
    const slot = this.slots[annotation.anchor.page - 1]
    if (!slot?.marksEl || !slot.frame) return null
    const last = boxesFor(annotation, slot.frame).at(-1)
    const page = slot.el.getBoundingClientRect()
    if (!last || !(page.width > 0)) return null
    const Rect = this.rootEl.ownerDocument.defaultView?.DOMRect ?? DOMRect
    return new Rect(
      page.left + last.left * page.width,
      page.top + last.top * page.height,
      (last.right - last.left) * page.width,
      (last.bottom - last.top) * page.height,
    )
  }

  /** Where an annotation's comment dot is on screen, or null when it has
   * none drawn. */
  getNoteRect(id: string): DOMRect | null {
    const annotation = this.store?.get(id)
    if (!annotation) return null
    const marks = this.slots[annotation.anchor.page - 1]?.marksEl
    for (const note of this.notesIn(marks)) {
      if (note.dataset.annotationId === id) return note.getBoundingClientRect()
    }
    return null
  }

  /** The annotation whose comment dot is at a point on screen, or null.
   * The dots are drawn in the annotation layer, which takes no pointer,
   * so they are found by where they are drawn. */
  noteAtPoint(clientX: number, clientY: number): string | null {
    if (this.areaMode) return null
    for (const slot of this.active) {
      for (const note of this.notesIn(slot.marksEl)) {
        const rect = note.getBoundingClientRect()
        if (
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        ) {
          return note.dataset.annotationId ?? null
        }
      }
    }
    return null
  }

  private notesIn(marks: HTMLElement | null | undefined): HTMLElement[] {
    return marks
      ? Array.from(marks.querySelectorAll<HTMLElement>(`.${NOTE_CLASS}`))
      : []
  }

  /** A copy of the page picture under `rect` (client pixels), no wider than
   * `maxWidth` CSS pixels — what a drag of a framed area carries — or null
   * where no picture is drawn. */
  snapshot(rect: DOMRect, maxWidth: number): HTMLCanvasElement | null {
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    for (const slot of this.active) {
      const source = slot.canvas
      if (!source || source.width === 0 || slot.drawnRatio === 0) continue
      const box = source.getBoundingClientRect()
      if (cx < box.left || cx > box.right || cy < box.top || cy > box.bottom) {
        continue
      }
      if (!(box.width > 0 && box.height > 0)) return null
      const sx = source.width / box.width
      const sy = source.height / box.height
      const width = Math.min(rect.width, maxWidth)
      const height = rect.height * (width / rect.width)
      const ratio = this.window()?.devicePixelRatio ?? 1
      const copy = this.rootEl.ownerDocument.createElement('canvas')
      copy.width = Math.max(1, Math.round(width * ratio))
      copy.height = Math.max(1, Math.round(height * ratio))
      copy.style.width = `${width}px`
      copy.style.height = `${height}px`
      copy
        .getContext('2d')
        ?.drawImage(
          source,
          (rect.left - box.left) * sx,
          (rect.top - box.top) * sy,
          rect.width * sx,
          rect.height * sy,
          0,
          0,
          copy.width,
          copy.height,
        )
      return copy
    }
    return null
  }

  /** A page's text items, as its text layer numbers them. */
  async getTextItems(
    page: number,
  ): Promise<readonly YoloModuleHostPdfTextItemV1[]> {
    const handle = this.handle
    if (!handle) throw new Error('PDF is not open')
    return (await handle.getPage(page)).getTextItems()
  }

  /** PNG bytes of a region of a page (`scale` CSS pixels per PDF unit). */
  async renderRegion(
    page: number,
    rect: PdfRectTuple,
    scale: number,
  ): Promise<ArrayBuffer> {
    const handle = this.handle
    if (!handle) throw new Error('PDF is not open')
    return (await handle.getPage(page)).renderRegion(rect, { scale })
  }

  /** Whether a node is on this reader's pages — where its text is. */
  containsPageNode(node: Node | null): boolean {
    return node !== null && this.pagesEl.contains(node)
  }

  /** In area mode a drag on a page frames a region instead of selecting
   * text. */
  setAreaMode(on: boolean): void {
    if (!this.store || on === this.areaMode) return
    this.areaMode = on
    this.rootEl.classList.toggle(AREA_MODE_CLASS, on)
    this.areaButton?.setAttribute('aria-pressed', String(on))
    this.areaButton?.classList.toggle('is-active', on)
    if (!on) {
      this.cancelAreaDraft()
      this.clearPendingArea()
    }
  }

  /** Where the frame last drawn in area mode is on screen, while it is still
   * waiting to be acted on. */
  getPendingAreaRect(): DOMRect | null {
    const pending = this.pendingArea
    if (!pending?.el.isConnected) return null
    const rect = pending.el.getBoundingClientRect()
    return rect.width > 0 || rect.height > 0 ? rect : null
  }

  /** Takes the waiting frame off the page. */
  clearPendingArea(): void {
    this.pendingArea?.el.remove()
    this.pendingArea = null
    this.pagesEl.classList.remove(GRABBABLE_CLASS)
  }

  /**
   * Goes where a link points: to `page`, and with a `selection`, to the text
   * it names there, marked for a moment. The text is found on the page's
   * text layer, so it waits for one — a reader that is not being read
   * (`setInteractive`) builds none, and the mark comes when it is. A tuple
   * that names no text on the page — a link Obsidian's own viewer wrote,
   * whose pdf.js split this page differently — leaves the page.
   */
  revealLocation(page: number, selection: SelectionTuple | null): void {
    if (this.destroyed) return
    const count = this.handle?.pageCount ?? 0
    const target = count > 0 ? Math.min(Math.max(1, page), count) : page
    this.goToPage(target)
    this.pendingReveal = selection ? { page: target, selection } : null
    this.finishReveal()
  }

  isAreaMode(): boolean {
    return this.areaMode
  }

  /** Clears the text selection if it is on this reader's pages. */
  clearTextSelection(): void {
    const selection = this.rootEl.ownerDocument.getSelection()
    if (selection && this.selectionInPages(selection)) {
      selection.removeAllRanges()
    }
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
    const doc = this.rootEl.ownerDocument
    this.pagesEl.removeEventListener('pointerdown', this.onPagesPointerDown)
    this.pagesEl.removeEventListener('pointermove', this.onPagesPointerMove)
    this.pagesEl.removeEventListener('pointerleave', this.onPagesPointerLeave)
    this.pagesEl.removeEventListener('contextmenu', this.onPagesContextMenu)
    doc.removeEventListener('pointerup', this.onDocumentPointerUp)
    doc.removeEventListener('pointercancel', this.onDocumentPointerUp)
    doc.removeEventListener('selectionchange', this.onSelectionChange)
    this.unsubscribeAnnotations?.()
    this.unsubscribeAnnotations = null
    this.selectionReported = false
    this.options.annotationEvents?.onReaderDestroyed(this)
    this.options.annotations?.release()
    this.search.destroy()
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
    this.setPage(this.slots[0], first)
    this.slots[0].size = this.estimate
    this.countEl.textContent = `/ ${handle.pageCount}`
    this.indicatorEl.hidden = false
    this.layout = null
    this.relayout(position)
    this.schedule()
    this.search.reset()
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
      slot.frame = null
      this.releaseTextLayer(slot)
    }
    const doc = this.rootEl.ownerDocument
    for (let index = this.slots.length; index < pageCount; index += 1) {
      const el = doc.createElement('div')
      el.className = PAGE_CLASS
      el.dataset.page = String(index + 1)
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
        marksEl: null,
        frame: null,
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
    // Put here by `setPosition`: where the scroller landed is the position
    // the other reader already has, not news.
    if (this.pendingSilently) {
      this.pendingSilently = false
      this.markReported()
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
        this.setPage(slot, page)
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
      if (this.store) {
        const marks = this.rootEl.ownerDocument.createElement('div')
        marks.className = MARKS_CLASS
        canvas.after(marks)
        slot.marksEl = marks
        this.renderMarks(slot)
      }
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
        this.search.onTextLayer(slot.index)
        if (this.pendingReveal?.page === slot.index + 1) this.finishReveal()
      },
      (error: unknown) => {
        if (slot.textTask === task) slot.textTask = null
        if (isAbort(error)) return
        this.options.reportError?.('pdf text layer', error)
      },
    )
  }

  private releaseTextLayer(slot: Slot): void {
    if (slot.textLayer) this.search.onTextLayerGone(slot.index)
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
    slot.marksEl?.remove()
    slot.marksEl = null
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

  /**
   * Brings a search hit into view. With its range (its page has a text
   * layer), scrolls so the hit sits a third of the way down unless it is
   * already comfortably on screen; without one, goes to its page, and the
   * search finishes the jump when that page's layer is built.
   *
   * Measured with client rects, which a board's camera scales, and brought
   * back into the reader's own pixels by the scroller's ratio of layout
   * height to on-screen height — the same correction selection geometry uses.
   */
  private revealSearchHit(pageIndex: number, range: Range | null): void {
    if (!this.layout) return
    if (!range) {
      this.goToPage(pageIndex + 1)
      return
    }
    const scroller = this.scrollerEl
    const box = scroller.getBoundingClientRect()
    const rect = range.getBoundingClientRect()
    const height = scroller.clientHeight
    if (!(box.height > 0) || !(height > 0)) return
    const factor = height / box.height
    const top = (rect.top - box.top) * factor
    const bottom = (rect.bottom - box.top) * factor
    if (top >= height * 0.1 && bottom <= height * 0.9) return
    const room = scroller.scrollHeight - height
    this.pendingPosition = null
    scroller.scrollTop = Math.max(
      0,
      Math.min(room, scroller.scrollTop + top - height / 3),
    )
  }

  private finishReveal(): void {
    const reveal = this.pendingReveal
    if (!reveal) return
    const slot = this.slots[reveal.page - 1]
    const layer = slot?.textLayer
    if (!slot || !layer || !slot.frame) return
    this.pendingReveal = null
    const range = layer.createRange(reveal.selection)
    if (!range) return
    const described = layer.describeRange(range)
    this.revealSearchHit(slot.index, range)
    if (described) this.flash(slot, quadBoxes(described.quadPoints, slot.frame))
  }

  /** Marks boxes on a page for a moment: in, held, faded out, removed. */
  private flash(slot: Slot, boxes: readonly PageBox[]): void {
    const win = this.window()
    if (!win || boxes.length === 0) return
    const doc = this.rootEl.ownerDocument
    const els = boxes.map((box) => {
      const el = doc.createElement('div')
      el.className = FLASH_CLASS
      placeBox(el, box)
      slot.el.appendChild(el)
      return el
    })
    // Laid out once without the shown state, so turning it on transitions.
    void els[0].offsetWidth
    for (const el of els) el.classList.add(FLASH_SHOWN_CLASS)
    win.setTimeout(() => {
      for (const el of els) el.classList.remove(FLASH_SHOWN_CLASS)
      win.setTimeout(() => {
        for (const el of els) el.remove()
      }, FLASH_FADE_MS)
    }, FLASH_HOLD_MS)
  }

  // -----------------------------------------------------------------------
  // Annotations
  // -----------------------------------------------------------------------

  private setPage(slot: Slot, page: PdfPage): void {
    slot.page = page
    slot.frame = {
      width: page.width,
      height: page.height,
      toViewport: (point) => page.toViewportPoint(point, 1),
    }
    this.renderMarks(slot)
  }

  private renderMarks(slot: Slot): void {
    if (!this.store || !slot.marksEl) return
    if (!slot.frame) {
      slot.marksEl.replaceChildren()
      return
    }
    renderAnnotationLayer(
      slot.marksEl,
      this.store.forPage(slot.index + 1),
      slot.frame,
      this.activeAnnotationId,
    )
  }

  private renderAllMarks(): void {
    for (const slot of this.active) this.renderMarks(slot)
    if (this.activeAnnotationId && !this.store?.get(this.activeAnnotationId)) {
      this.activeAnnotationId = null
    }
  }

  /** The page slot under a pointer event, and where on it as page
   * fractions — measured against the page's on-screen box, a ratio a board
   * camera's scale does not distort. */
  private pointOnPage(
    event: MouseEvent,
  ): { slot: Slot; x: number; y: number; rect: DOMRect } | null {
    const target = event.target as Element | null
    const pageEl = target?.closest?.(`.${PAGE_CLASS}`) as HTMLElement | null
    if (!pageEl || !this.pagesEl.contains(pageEl)) return null
    const slot = this.slots[Number(pageEl.dataset.page) - 1]
    if (!slot) return null
    const rect = pageEl.getBoundingClientRect()
    if (!(rect.width > 0 && rect.height > 0)) return null
    return {
      slot,
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
      rect,
    }
  }

  private annotationAt(event: MouseEvent): string | null {
    const at = this.pointOnPage(event)
    return at ? this.annotationOnPage(at.slot, at.x, at.y, at.rect) : null
  }

  /**
   * The annotation drawn at a point on screen, or null — for a press the
   * pages never received, such as one on a card whose content has not been
   * entered, where the card's mask takes every press.
   */
  annotationAtPoint(clientX: number, clientY: number): string | null {
    for (const slot of this.active) {
      const rect = slot.el.getBoundingClientRect()
      if (
        !(rect.width > 0 && rect.height > 0) ||
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        continue
      }
      return this.annotationOnPage(
        slot,
        (clientX - rect.left) / rect.width,
        (clientY - rect.top) / rect.height,
        rect,
      )
    }
    return null
  }

  /** The annotation at page fractions `x`, `y` of a page shown at `rect`. */
  private annotationOnPage(
    slot: Slot,
    x: number,
    y: number,
    rect: DOMRect,
  ): string | null {
    const store = this.store
    const frame = slot.frame
    if (!store || !frame) return null
    const entries = store.forPage(slot.index + 1).map((annotation) => ({
      id: annotation.id,
      boxes: boxesFor(annotation, frame),
    }))
    return hitTestAnnotations(entries, [x, y], HIT_SLOP_PX / rect.width)
  }

  /**
   * What a press at the pointer would pick up: the waiting frame (null), an
   * annotation (its id), or nothing (undefined). An annotation is taken by
   * the press rather than the text under it — a drag from inside a
   * highlight takes the highlight out instead of selecting its words; one
   * started outside it still selects across it. Not in area mode, where a
   * press anywhere draws a frame.
   */
  private grabbableAt(event: MouseEvent): string | null | undefined {
    const pending = this.getPendingAreaRect()
    if (
      pending &&
      event.clientX >= pending.left &&
      event.clientX <= pending.right &&
      event.clientY >= pending.top &&
      event.clientY <= pending.bottom
    ) {
      return null
    }
    if (this.areaMode) return undefined
    return this.annotationAt(event) ?? undefined
  }

  private readonly onPagesPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    const events = this.options.annotationEvents
    const note = events ? this.noteAtPoint(event.clientX, event.clientY) : null
    if (events && note !== null) {
      event.preventDefault()
      events.onGrab(this, event, note, true)
      return
    }
    const grabbed = events ? this.grabbableAt(event) : undefined
    if (events && grabbed !== undefined) {
      event.preventDefault()
      events.onGrab(this, event, grabbed, false)
      return
    }
    // A frame left waiting is let go by the next press, as a text selection
    // is by a click elsewhere.
    this.clearPendingArea()
    this.press = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    }
    if (!this.areaMode) return
    const at = this.pointOnPage(event)
    if (!at) return
    // The press is the frame's, not the start of a text selection.
    event.preventDefault()
    const el = this.rootEl.ownerDocument.createElement('div')
    el.className = AREA_DRAFT_CLASS
    at.slot.el.appendChild(el)
    at.slot.el.setPointerCapture(event.pointerId)
    this.areaDraft = {
      pointerId: event.pointerId,
      slot: at.slot,
      el,
      startX: at.x,
      startY: at.y,
      x: at.x,
      y: at.y,
    }
    this.placeAreaDraft()
  }

  private readonly onPagesPointerMove = (event: PointerEvent): void => {
    const draft = this.areaDraft
    if (!draft) {
      const note =
        event.buttons === 0
          ? this.noteAtPoint(event.clientX, event.clientY)
          : null
      this.hoverNote(note)
      // What a press would pick up says so before the press.
      this.pagesEl.classList.toggle(ON_NOTE_CLASS, note !== null)
      this.pagesEl.classList.toggle(
        GRABBABLE_CLASS,
        note === null &&
          event.buttons === 0 &&
          this.grabbableAt(event) !== undefined,
      )
      return
    }
    if (event.pointerId !== draft.pointerId) return
    const rect = draft.slot.el.getBoundingClientRect()
    if (!(rect.width > 0 && rect.height > 0)) return
    draft.x = clamp01((event.clientX - rect.left) / rect.width)
    draft.y = clamp01((event.clientY - rect.top) / rect.height)
    this.placeAreaDraft()
  }

  private readonly onPagesPointerLeave = (): void => {
    this.pagesEl.classList.remove(ON_NOTE_CLASS)
    this.hoverNote(null)
  }

  private hoverNote(id: string | null): void {
    if (id === this.hoveredNote) return
    this.hoveredNote = id
    this.options.annotationEvents?.onNoteHover(this, id)
  }

  private placeAreaDraft(): void {
    const draft = this.areaDraft
    if (!draft) return
    placeBox(draft.el, {
      left: Math.min(draft.startX, draft.x),
      top: Math.min(draft.startY, draft.y),
      right: Math.max(draft.startX, draft.x),
      bottom: Math.max(draft.startY, draft.y),
    })
  }

  private cancelAreaDraft(): void {
    const draft = this.areaDraft
    if (!draft) return
    this.areaDraft = null
    draft.el.remove()
    if (draft.slot.el.hasPointerCapture(draft.pointerId)) {
      draft.slot.el.releasePointerCapture(draft.pointerId)
    }
  }

  /** Ends a drag in area mode. A frame big enough to mean something stays
   * on the page, waiting (`pendingArea`), and is reported. */
  private finishAreaDraft(): void {
    const draft = this.areaDraft
    if (!draft) return
    this.areaDraft = null
    if (draft.slot.el.hasPointerCapture(draft.pointerId)) {
      draft.slot.el.releasePointerCapture(draft.pointerId)
    }
    const page = draft.slot.page
    const events = this.options.annotationEvents
    const left = Math.min(draft.startX, draft.x)
    const right = Math.max(draft.startX, draft.x)
    const top = Math.min(draft.startY, draft.y)
    const bottom = Math.max(draft.startY, draft.y)
    const minHeight = page ? (MIN_AREA_FRACTION * page.width) / page.height : 0
    if (
      !page ||
      !events ||
      right - left < MIN_AREA_FRACTION ||
      bottom - top < minHeight
    ) {
      draft.el.remove()
      return
    }
    this.pendingArea = { slot: draft.slot, el: draft.el }
    const [x1, y1] = page.toPdfPoint([left * page.width, top * page.height], 1)
    const [x2, y2] = page.toPdfPoint(
      [right * page.width, bottom * page.height],
      1,
    )
    events.onAreaDrawn(this, draft.slot.index + 1, [
      Math.min(x1, x2),
      Math.min(y1, y2),
      Math.max(x1, x2),
      Math.max(y1, y2),
    ])
  }

  private readonly onDocumentPointerUp = (event: PointerEvent): void => {
    const press = this.press
    if (!press || event.pointerId !== press.pointerId) return
    this.press = null
    if (this.areaDraft) {
      if (event.type === 'pointerup') this.finishAreaDraft()
      else this.cancelAreaDraft()
      return
    }
    if (event.type !== 'pointerup') return
    const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y)
    // Read on the next frame: the browser settles a drag-selection, and
    // collapses the old one on a click, after pointerup.
    const win = this.window()
    const clickTarget = moved < CLICK_SLOP_PX ? event : null
    const hit = clickTarget ? this.annotationAt(clickTarget) : null
    win?.requestAnimationFrame(() => {
      if (this.destroyed) return
      if (this.reportSelection()) return
      if (clickTarget) {
        this.options.annotationEvents?.onAnnotationClick(this, hit)
      }
    })
  }

  private readonly onPagesContextMenu = (event: MouseEvent): void => {
    const id = this.annotationAt(event)
    if (!id) return
    event.preventDefault()
    event.stopPropagation()
    this.options.annotationEvents?.onAnnotationContextMenu(this, id, event)
  }

  private readonly onSelectionChange = (): void => {
    if (!this.selectionReported) return
    const selection = this.rootEl.ownerDocument.getSelection()
    if (
      selection &&
      !selection.isCollapsed &&
      this.selectionInPages(selection)
    ) {
      return
    }
    this.selectionReported = false
    this.options.annotationEvents?.onTextSelection(this, null)
  }

  private selectionInPages(selection: Selection): boolean {
    if (selection.rangeCount === 0) return false
    const range = selection.getRangeAt(0)
    return (
      this.pagesEl.contains(range.startContainer) ||
      this.pagesEl.contains(range.endContainer)
    )
  }

  /** Reports the selection on this reader's pages, if there is one. */
  private reportSelection(): boolean {
    const events = this.options.annotationEvents
    const selection = this.rootEl.ownerDocument.getSelection()
    if (
      !events ||
      !selection ||
      selection.isCollapsed ||
      !this.selectionInPages(selection)
    ) {
      return false
    }
    const range = selection.getRangeAt(0)
    const pieces: YoloModuleHostPdfTextSelectionV1[] = []
    for (const slot of this.slots) {
      const piece = slot.textLayer?.describeRange(range)
      if (piece && piece.text.trim() !== '') pieces.push(piece)
    }
    if (pieces.length === 0) return false
    this.selectionReported = true
    events.onTextSelection(this, {
      pieces,
      getRect: () => {
        const current = this.rootEl.ownerDocument.getSelection()
        if (!current || current.rangeCount === 0 || current.isCollapsed) {
          return null
        }
        const rect = current.getRangeAt(0).getBoundingClientRect()
        return rect.width > 0 || rect.height > 0 ? rect : null
      },
    })
    return true
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

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
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
