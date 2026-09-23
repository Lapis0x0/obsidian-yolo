// The whiteboard view's reading panel: a column on the right of the board
// that reads one PDF at full height, next to the canvas rather than inside
// it (design.md §4). It is the same reader a PDF card holds (./pdfReader.ts),
// mounted a second time over the same file — the host shares the parsed
// document between the two — and always interactive, since it only exists
// to be read.
//
// This class is the panel's chrome and nothing else: the divider that
// resizes it, the header naming the file, the close button, and the reader's
// container. Which card it belongs to, and keeping it and that card's reader
// at the same place, is the canvas's business (ui/canvas.ts); so is making
// room for it, since the board's viewport is what has to shrink.
//
// Every element and listener belongs to the document the panel was built in,
// so it keeps working in a popout window.

import type { AnnotationLease } from '../../host/annotationStore'

import { createReaderIconButton } from './icons'
import { PdfReader, type ReaderAnnotationEvents } from './pdfReader'

type Translate = (key: string) => string

export type ReaderPanelOptions = Readonly<{
  pdf: YoloModuleHostPdfV1
  /** The view root; the panel is appended to it. */
  parent: HTMLElement
  t: Translate
  /** The width to open at, in CSS pixels. */
  width: number
  /** The widest the panel may be, given the view it is in. */
  maxWidth: () => number
  /** Called on every frame of a resize, and once more when it ends
   * (`done`), with the width the panel now has. */
  onResize: (width: number, done: boolean) => void
  onClose: () => void
  onPositionChange: (position: number) => void
  /** The annotations of a PDF, for the panel's reader to hold. */
  openAnnotations: (path: string) => AnnotationLease
  annotationEvents: ReaderAnnotationEvents
  reportError?: (stage: string, error: unknown) => void
}>

export const READER_PANEL_MIN_WIDTH = 320
export const READER_PANEL_DEFAULT_WIDTH = 520

const PANEL_CLASS = 'yolo-whiteboard-reader-panel'
const DIVIDER_CLASS = 'yolo-whiteboard-reader-panel-divider'
const DIVIDER_ACTIVE_CLASS = 'yolo-whiteboard-reader-panel-divider-active'
const HEADER_CLASS = 'yolo-whiteboard-reader-panel-header'
const TITLE_CLASS = 'yolo-whiteboard-reader-panel-title'
const BUTTON_CLASS = 'yolo-whiteboard-reader-panel-button'
const BODY_CLASS = 'yolo-whiteboard-reader-panel-body'

export class ReaderPanel {
  private readonly el: HTMLElement
  private readonly dividerEl: HTMLElement
  private readonly titleEl: HTMLElement
  private readonly bodyEl: HTMLElement
  private reader: PdfReader | null = null
  private widthPx: number
  private drag: Readonly<{
    pointerId: number
    startX: number
    startWidth: number
  }> | null = null
  private frameId: number | null = null

  constructor(private readonly options: ReaderPanelOptions) {
    const doc = options.parent.ownerDocument
    this.el = doc.createElement('div')
    this.el.className = PANEL_CLASS
    // Focusable, so that a press anywhere in the panel makes it the element
    // with focus — which is how the view's Mod+F knows the panel is the
    // reader being read (canvas.ts). Not in the tab order: it is a region,
    // not a control.
    this.el.tabIndex = -1

    this.dividerEl = doc.createElement('div')
    this.dividerEl.className = DIVIDER_CLASS
    this.dividerEl.setAttribute('role', 'separator')
    this.dividerEl.setAttribute('aria-orientation', 'vertical')

    const header = doc.createElement('div')
    header.className = HEADER_CLASS
    this.titleEl = doc.createElement('div')
    this.titleEl.className = TITLE_CLASS
    header.append(
      this.titleEl,
      createReaderIconButton(
        doc,
        BUTTON_CLASS,
        'search',
        options.t('pdf.search'),
        () => this.openSearch(),
      ),
      createReaderIconButton(
        doc,
        BUTTON_CLASS,
        'x',
        options.t('pdf.closePanel'),
        () => options.onClose(),
      ),
    )

    this.bodyEl = doc.createElement('div')
    this.bodyEl.className = BODY_CLASS

    this.el.append(this.dividerEl, header, this.bodyEl)
    options.parent.appendChild(this.el)

    this.widthPx = this.clampWidth(options.width)
    this.applyWidth()

    this.dividerEl.addEventListener('pointerdown', this.onDividerDown)
    this.dividerEl.addEventListener('pointermove', this.onDividerMove)
    this.dividerEl.addEventListener('pointerup', this.onDividerUp)
    this.dividerEl.addEventListener('pointercancel', this.onDividerUp)
  }

  /** The panel's width in CSS pixels, divider included — how much room the
   * board has to give up. */
  get width(): number {
    return this.widthPx
  }

  get path(): string | null {
    return this.reader?.path ?? null
  }

  /** Reads `path` from `position`, replacing whatever the panel was
   * reading. */
  show(path: string, title: string, position: number | undefined): void {
    this.titleEl.textContent = title
    if (this.reader?.path === path) {
      if (position !== undefined) this.reader.setPosition(position)
      return
    }
    this.reader?.destroy()
    this.reader = new PdfReader({
      pdf: this.options.pdf,
      path,
      container: this.bodyEl,
      position,
      interactive: true,
      t: this.options.t,
      onPositionChange: (next) => this.options.onPositionChange(next),
      annotations: this.options.openAnnotations(path),
      annotationEvents: this.options.annotationEvents,
      reportError: this.options.reportError,
    })
  }

  /** The panel's reader, while it is reading something. */
  getReader(): PdfReader | null {
    return this.reader
  }

  setTitle(title: string): void {
    this.titleEl.textContent = title
  }

  getPosition(): number | null {
    return this.reader?.getPosition() ?? null
  }

  /** Follows another reader: silent, so it is not reported back. */
  setPosition(position: number): void {
    this.reader?.setPosition(position)
  }

  openSearch(): void {
    this.reader?.openSearch()
  }

  /** Closes the search bar if it is open; true when it was. */
  closeSearch(): boolean {
    if (!this.reader?.isSearchOpen()) return false
    this.reader.closeSearch()
    return true
  }

  contains(node: Node | null): boolean {
    return node !== null && this.el.contains(node)
  }

  /** The view got a new size: a panel wider than it may now be gives the
   * difference back. */
  refit(): void {
    const width = this.clampWidth(this.widthPx)
    if (width === this.widthPx) return
    this.widthPx = width
    this.applyWidth()
    this.options.onResize(width, true)
  }

  destroy(): void {
    this.cancelFrame()
    this.dividerEl.removeEventListener('pointerdown', this.onDividerDown)
    this.dividerEl.removeEventListener('pointermove', this.onDividerMove)
    this.dividerEl.removeEventListener('pointerup', this.onDividerUp)
    this.dividerEl.removeEventListener('pointercancel', this.onDividerUp)
    this.reader?.destroy()
    this.reader = null
    this.el.remove()
  }

  // -----------------------------------------------------------------------
  // Resizing. The divider captures the pointer, so the drag keeps going
  // over the board or the page and ends wherever it is let go — in this
  // window, since capture is per element.
  // -----------------------------------------------------------------------

  private readonly onDividerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    event.preventDefault()
    this.dividerEl.setPointerCapture(event.pointerId)
    this.dividerEl.classList.add(DIVIDER_ACTIVE_CLASS)
    this.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: this.widthPx,
    }
  }

  private readonly onDividerMove = (event: PointerEvent): void => {
    const drag = this.drag
    if (!drag || event.pointerId !== drag.pointerId) return
    // The panel is on the right: dragging the divider left widens it.
    const width = this.clampWidth(drag.startWidth + drag.startX - event.clientX)
    if (width === this.widthPx) return
    this.widthPx = width
    this.applyWidth()
    // Once a frame: every resize re-measures the board.
    if (this.frameId !== null) return
    const win = this.el.ownerDocument.defaultView
    if (!win) return
    this.frameId = win.requestAnimationFrame(() => {
      this.frameId = null
      this.options.onResize(this.widthPx, false)
    })
  }

  private readonly onDividerUp = (event: PointerEvent): void => {
    const drag = this.drag
    if (!drag || event.pointerId !== drag.pointerId) return
    this.drag = null
    this.dividerEl.classList.remove(DIVIDER_ACTIVE_CLASS)
    if (this.dividerEl.hasPointerCapture(event.pointerId)) {
      this.dividerEl.releasePointerCapture(event.pointerId)
    }
    this.cancelFrame()
    this.options.onResize(this.widthPx, true)
  }

  private cancelFrame(): void {
    if (this.frameId === null) return
    this.el.ownerDocument.defaultView?.cancelAnimationFrame(this.frameId)
    this.frameId = null
  }

  private clampWidth(width: number): number {
    const max = Math.max(READER_PANEL_MIN_WIDTH, this.options.maxWidth())
    return Math.round(Math.min(max, Math.max(READER_PANEL_MIN_WIDTH, width)))
  }

  private applyWidth(): void {
    this.el.style.width = `${this.widthPx}px`
  }
}
