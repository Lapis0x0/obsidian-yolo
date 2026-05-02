/**
 * RegionSelector.ts
 *
 * Vanilla-TS DOM component that overlays the entire PDF view container,
 * lets the user drag a selection rectangle, and calls `onComplete` with the
 * CSS-space rectangle (relative to the page canvas element that was under
 * the mouse-down point) when the mouse button is released.
 *
 * `onCancel` is called if the user presses ESC or clicks without dragging
 * (zero-area selection).
 *
 * Lifecycle:
 *   const sel = new RegionSelector(containerEl, { onComplete, onCancel })
 *   sel.mount()           // activates the overlay
 *   // … user drags …
 *   // onComplete / onCancel fires, selector auto-unmounts
 *   sel.unmount()         // safe to call more than once (idempotent)
 */

export type SelectedRegion = {
  /** The PDF.js canvas element for the page that was under mouse-down */
  canvas: HTMLCanvasElement
  /** CSS-pixel rect relative to that canvas's top-left corner */
  x: number
  y: number
  width: number
  height: number
  /** 1-indexed page number, read from data-page-number attribute */
  pageNumber: number
}

type RegionSelectorCallbacks = {
  onComplete: (region: SelectedRegion) => void
  onCancel: () => void
  /** Optional hint text rendered at the top of the overlay */
  hintText?: string
}

export class RegionSelector {
  private readonly container: HTMLElement
  private readonly callbacks: RegionSelectorCallbacks

  private overlayEl: HTMLElement | null = null
  private selectionEl: HTMLElement | null = null

  private isDragging = false
  private startX = 0 // viewport coordinates
  private startY = 0
  private anchorCanvas: HTMLCanvasElement | null = null
  private anchorPageNumber = 1

  // Bound event handlers (kept for removeEventListener)
  private readonly boundMouseDown: (e: MouseEvent) => void
  private readonly boundMouseMove: (e: MouseEvent) => void
  private readonly boundMouseUp: (e: MouseEvent) => void
  private readonly boundKeyDown: (e: KeyboardEvent) => void

  constructor(container: HTMLElement, callbacks: RegionSelectorCallbacks) {
    this.container = container
    this.callbacks = callbacks

    this.boundMouseDown = (e) => { this.onMouseDown(e) }
    this.boundMouseMove = (e) => { this.onMouseMove(e) }
    this.boundMouseUp = (e) => { this.onMouseUp(e) }
    this.boundKeyDown = (e) => { this.onKeyDown(e) }
  }

  mount(): void {
    if (this.overlayEl) return // already mounted

    const overlay = document.createElement('div')
    overlay.className = 'yolo-pdf-region-overlay'
    overlay.setAttribute('data-yolo-region-selector', 'true')

    const hint = document.createElement('div')
    hint.className = 'yolo-pdf-region-hint'
    hint.textContent = this.callbacks.hintText ?? ''
    overlay.appendChild(hint)

    const selEl = document.createElement('div')
    selEl.className = 'yolo-pdf-region-selection'
    overlay.appendChild(selEl)
    this.selectionEl = selEl

    this.container.appendChild(overlay)
    this.overlayEl = overlay

    overlay.addEventListener('mousedown', this.boundMouseDown)
    document.addEventListener('mousemove', this.boundMouseMove)
    document.addEventListener('mouseup', this.boundMouseUp)
    document.addEventListener('keydown', this.boundKeyDown, { capture: true })
  }

  unmount(): void {
    if (!this.overlayEl) return

    document.removeEventListener('mousemove', this.boundMouseMove)
    document.removeEventListener('mouseup', this.boundMouseUp)
    document.removeEventListener('keydown', this.boundKeyDown, { capture: true })

    this.overlayEl.removeEventListener('mousedown', this.boundMouseDown)
    this.overlayEl.remove()
    this.overlayEl = null
    this.selectionEl = null
    this.isDragging = false
    this.anchorCanvas = null
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()

    this.isDragging = true
    this.startX = e.clientX
    this.startY = e.clientY

    // Find the PDF.js page canvas under the cursor.
    // PDF.js renders each page inside a `.page[data-page-number]` div
    // containing `.canvasWrapper > canvas`.
    const canvas = this.findPageCanvasAt(e.clientX, e.clientY)
    this.anchorCanvas = canvas
    this.anchorPageNumber = canvas
      ? parseInt(
          canvas.closest('.page')?.getAttribute('data-page-number') ?? '1',
          10,
        )
      : 1

    if (this.selectionEl) {
      this.selectionEl.style.display = 'none'
    }
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.isDragging || !this.selectionEl) return
    e.preventDefault()

    const { left, top, width, height } = this.computeViewportRect(
      this.startX,
      this.startY,
      e.clientX,
      e.clientY,
    )

    const selEl = this.selectionEl
    selEl.style.display = 'block'
    selEl.style.left = `${left}px`
    selEl.style.top = `${top}px`
    selEl.style.width = `${width}px`
    selEl.style.height = `${height}px`
  }

  private onMouseUp(e: MouseEvent): void {
    if (!this.isDragging) return
    e.preventDefault()

    // Capture state before unmount() clears it
    const canvas = this.anchorCanvas
    const pageNumber = this.anchorPageNumber

    // Compute the selection rect while overlayEl is still valid
    const selectionRect = this.computeViewportRect(
      this.startX,
      this.startY,
      e.clientX,
      e.clientY,
    )

    this.isDragging = false
    this.unmount()

    if (!canvas) {
      this.callbacks.onCancel()
      return
    }

    const { left, top, width, height } = selectionRect

    if (width < 4 || height < 4) {
      // Treat as accidental click, not a real selection
      this.callbacks.onCancel()
      return
    }

    // Convert viewport-overlay-relative coordinates to CSS-space coordinates
    // relative to the anchor canvas. The overlay is positioned at inset:0 of
    // the container, so we need the canvas's bounding rect (not the overlay's).
    const canvasRect = canvas.getBoundingClientRect()
    // `left` and `top` are already relative to the overlay's top-left corner.
    // The overlay starts at the container's top-left, but the canvas may be
    // offset inside. We need absolute viewport coords for the selection rect,
    // then subtract the canvas's viewport offset.
    const overlayRect = this.container.getBoundingClientRect()
    const region: SelectedRegion = {
      canvas,
      x: overlayRect.left + left - canvasRect.left,
      y: overlayRect.top + top - canvasRect.top,
      width,
      height,
      pageNumber,
    }

    this.callbacks.onComplete(region)
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      this.unmount()
      this.callbacks.onCancel()
    }
  }

  /**
   * Given two viewport anchor points, return a normalised {left, top, width, height}
   * rectangle in viewport coordinates (so it can be positioned relative to the overlay).
   */
  private computeViewportRect(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): { left: number; top: number; width: number; height: number } {
    const overlayRect = this.overlayEl!.getBoundingClientRect()
    const left = Math.min(x1, x2) - overlayRect.left
    const top = Math.min(y1, y2) - overlayRect.top
    const width = Math.abs(x2 - x1)
    const height = Math.abs(y2 - y1)
    return { left, top, width, height }
  }

  /**
   * Walk the element tree at the given viewport point to find a PDF.js page canvas.
   *
   * PDF.js structure (Obsidian's bundled version):
   *   .pdfViewer
   *     .page[data-page-number="N"]
   *       .canvasWrapper
   *         canvas          ← we want this
   *
   * We use elementsFromPoint so the overlay (which is above everything) does
   * not block us from reading the canvas below it.
   */
  private findPageCanvasAt(
    clientX: number,
    clientY: number,
  ): HTMLCanvasElement | null {
    try {
      const elements = document.elementsFromPoint(clientX, clientY)
      for (const el of elements) {
        if (
          el instanceof HTMLCanvasElement &&
          el.closest('.page[data-page-number]')
        ) {
          return el
        }
      }
    } catch {
      // elementsFromPoint can throw in some environments
    }
    return null
  }
}
