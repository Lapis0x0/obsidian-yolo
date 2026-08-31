/**
 * pdfSelectionHighlightController.ts
 *
 * Persists visual highlights over selected text in Obsidian's built-in PDF
 * viewer using the CSS Custom Highlight API (`::highlight(yolo-pdf-selection)`).
 *
 * The highlight registry is keyed by an opaque string `id` rather than by
 * WorkspaceLeaf, so the same leaf can hold multiple independent highlights
 * (e.g. one sync + several pinned entries).
 *
 * The only stable identifier that survives PDF.js re-renders is:
 *   file + pageNumber + [startOffset, endOffset)
 * where offsets are character indices into the concatenated textContent of
 * all text-leaf nodes in DOM order.
 *
 * Lifecycle per entry:
 *   1. addHighlight(leaf, id, location, variant, owner) — compute offsets from
 *      the live Range, build per-text-node sub-ranges, add to the global
 *      Highlight, subscribe to `textlayerrendered` for re-render recovery.
 *   2. On each `textlayerrendered` for the pinned page, rebuild sub-ranges
 *      against freshly mounted text nodes.
 *   3. clearById(id) / reconcileActiveIds(ids) / clearAll() — remove ranges
 *      and unsubscribe from eventBus.
 *
 * PDF multi-quote annotation (docs/plans/2026-08-16-pdf-annotation-quotes.md)
 * layers a numbered "批注N" bubble + comment editor on top of a 'pinned'
 * entry via `enableAnnotation`. This is command-line/DOM-imperative, not a
 * React portal (architecture decision — see the plan's item 7): the bubble
 * is mounted as a plain child of the same `.page` element the highlight's
 * ranges live in, positioned with the exact same
 * `lastRange.getClientRects()` math `AssistantSelectionQuoteButton.
 * measureAnnotations` uses for its own markers, converted to page-relative
 * coordinates instead of a React container ref. Riding inside `.page` means
 * the bubble scrolls for free with zero extra scroll-tracking machinery;
 * `onTextLayerRendered` (already rebuilding ranges on re-render) is the one
 * hook point that also repositions it.
 *
 * The bubble's only communication channel back to chat state is the
 * `PdfAnnotationCallbacks` passed into `enableAnnotation` — architecture
 * decision B: one `onCommentChange` / `onDelete` pair, no polling.
 *
 * Anchor / paint / bubble are three independent layers (2026-08-16 addendum
 * to the plan, "锚点与涂色必须解耦"): `addHighlight` ALWAYS computes offsets,
 * builds ranges, and subscribes to `textlayerrendered` — an entry exists
 * whenever the anchor-layer geometry could be resolved, full stop. Painting
 * the range into the CSS Custom Highlight registry is a separate, optional
 * step gated by both the caller's `options.paint` (mirrors the
 * `persistSelectionHighlight` setting, which this controller has no
 * knowledge of) and `shouldCreateSelectionHighlight(owner)` (the existing
 * mobile policy — chat/quickask owners never paint on mobile). `enableAnnotation`
 * only ever depends on the entry existing, never on whether it was painted,
 * so a bubble + editor are available even when the highlight color never
 * renders (settings off, or the CSS Custom Highlight API is unsupported).
 */

import type { App, TFile, WorkspaceLeaf } from 'obsidian'

import {
  type HighlightOwner,
  shouldCreateSelectionHighlight,
} from './selectionHighlightPolicy'

const HIGHLIGHT_NAME = 'yolo-pdf-selection'

/**
 * The annotation bubble and its comment editor are mounted inside the PDF
 * page element, so every event they raise looks like it came from a `pdf`
 * workspace leaf. They are chat-owned UI, not the document — anything that
 * asks "did the user go back to editing a real document?" must exclude them,
 * or focusing the comment input reads as leaving chat. See
 * `useChatHighlightSession`, the one consumer.
 */
export const PDF_ANNOTATION_UI_SELECTOR =
  '.yolo-pdf-annotation-marker, .yolo-pdf-annotation-editor'

export type PdfAnnotationLabels = {
  commentPlaceholder: string
  saveLabel: string
  deleteLabel: string
}

export type PdfAnnotationCallbacks = {
  /** Fired on every keystroke in the comment input — mirrors
   * `AssistantSelectionQuoteButton.handleCommentChange`. */
  onCommentChange: (highlightId: string, comment: string) => void
  /** Right-click on the marker, or Esc while the draft is still new. */
  onDelete: (highlightId: string) => void
  /** Resolved lazily (at editor-open time) so a locale change between
   * annotations is picked up without this controller needing to own i18n. */
  getLabels: () => PdfAnnotationLabels
}

type PdfAnnotationRuntime = {
  annotationNumber: number
  comment: string
  isNew: boolean
  callbacks: PdfAnnotationCallbacks
  markerEl: HTMLButtonElement
  markerIndexEl: HTMLElement
  markerPreviewEl: HTMLElement
  /** Page-relative position the marker was last placed at — reused as the
   * editor's anchor so editor positioning never re-derives geometry. */
  position: { left: number; top: number }
  editorEl: HTMLDivElement | null
  editorInputEl: HTMLInputElement | null
  removeOutsideClickListener: (() => void) | null
}

type PdfHighlightEntry = {
  leaf: WorkspaceLeaf
  pageNumber: number
  startOffset: number
  endOffset: number
  file: TFile
  variant: 'sync' | 'pinned'
  owner: HighlightOwner
  /**
   * Whether this entry's ranges are (or should be, once the CSS Custom
   * Highlight API becomes available) added to the paint registry. Decided
   * once at `addHighlight` time from `options.paint && shouldCreateSelectionHighlight(owner)`
   * and re-used on every `textlayerrendered` rebuild — the anchor layer
   * exists regardless of this flag.
   */
  paint: boolean

  eventBus: any
  onTextLayerRendered: (evt: { pageNumber: number }) => void
  ranges: Range[]
  annotation?: PdfAnnotationRuntime
}

// ──────────────────────────────────────────────────────────────────────────────
// CSS Custom Highlight registry
// ──────────────────────────────────────────────────────────────────────────────

type AnyHighlight = any

/**
 * Lazily get-or-create the singleton Highlight registered under HIGHLIGHT_NAME.
 *
 * Returns null when the runtime does not support the CSS Custom Highlight API
 * (e.g. older mobile webviews).
 */
function getOrCreateHighlight(): AnyHighlight {
  const w = window as any
  if (typeof w.Highlight !== 'function' || !w.CSS || !w.CSS.highlights) {
    return null
  }
  let highlight = w.CSS.highlights.get(HIGHLIGHT_NAME)
  if (!highlight) {
    highlight = new w.Highlight()
    w.CSS.highlights.set(HIGHLIGHT_NAME, highlight)
  }
  return highlight
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Walk all text nodes inside the `.textLayer` element of `pageEl` in DOM order
 * via TreeWalker and return them as an ordered array.
 */
function getTextNodes(pageEl: Element): Text[] {
  const textLayer = pageEl.querySelector('.textLayer')
  if (!textLayer) return []
  const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let node = walker.nextNode()
  while (node) {
    nodes.push(node as Text)
    node = walker.nextNode()
  }
  return nodes
}

/**
 * Character offsets of `range` into the page's concatenated text-node content.
 *
 * Measured with a second Range rather than by matching `range.startContainer` /
 * `endContainer` against individual text nodes: a selection boundary does not
 * have to land *inside* a text node. Dragging to the end of a line — e.g. just
 * past a trailing period — routinely leaves the boundary on the `<span>` or on
 * `.textLayer` itself, with the offset counting child nodes instead of
 * characters. Identity matching finds no text node there and yields nothing,
 * which killed the whole entry (no highlight, and with it no annotation bubble
 * or comment editor). `Range.setEnd` accepts element boundaries natively, so
 * measuring the prefix sidesteps the problem entirely.
 *
 * `toString()` concatenates only text, and the `<br>` / `.endOfContent` nodes
 * PDF.js puts in the text layer contribute none — so these offsets share the
 * exact basis `getTextNodes` walks and `buildRanges` rebuilds against.
 */
function computeOffsets(
  textLayer: Element,
  range: Range,
): { startOffset: number; endOffset: number } | null {
  const prefixRange = textLayer.ownerDocument.createRange()
  prefixRange.selectNodeContents(textLayer)
  try {
    prefixRange.setEnd(range.startContainer, range.startOffset)
  } catch {
    // Boundary outside this text layer (e.g. a cross-page selection).
    return null
  }

  const startOffset = prefixRange.toString().length
  const endOffset = startOffset + range.toString().length
  if (startOffset >= endOffset) return null
  return { startOffset, endOffset }
}

/**
 * Build per-text-node sub-Ranges covering exactly [startOffset, endOffset)
 * of the page's concatenated text content.
 */
function buildRanges(
  textNodes: Text[],
  startOffset: number,
  endOffset: number,
): Range[] {
  const ranges: Range[] = []
  let cursor = 0
  for (const node of textNodes) {
    const nodeStart = cursor
    const nodeEnd = cursor + node.length

    if (nodeEnd > startOffset && nodeStart < endOffset) {
      const localStart = Math.max(0, startOffset - nodeStart)
      const localEnd = Math.min(node.length, endOffset - nodeStart)
      const r = document.createRange()
      r.setStart(node, localStart)
      r.setEnd(node, localEnd)
      ranges.push(r)
    }

    cursor = nodeEnd
    if (cursor >= endOffset) break
  }
  return ranges
}

/**
 * Resolve the PDF.js eventBus from a WorkspaceLeaf that holds a PDF view.
 */
function resolveEventBus(leaf: WorkspaceLeaf): unknown {
  try {
    const viewer = (leaf.view as any)?.viewer?.child?.pdfViewer
    return viewer?.eventBus ?? null
  } catch {
    return null
  }
}

/**
 * Resolve the `.page[data-page-number="N"]` element inside the leaf's PDF
 * viewer for the given 1-based page number.
 */
function resolvePageEl(
  leaf: WorkspaceLeaf,
  pageNumber: number,
): Element | null {
  try {
    const containerEl = (leaf.view as any)?.containerEl as Element | undefined
    if (!containerEl) return null
    return (
      containerEl.querySelector(`.page[data-page-number="${pageNumber}"]`) ??
      null
    )
  } catch {
    return null
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Annotation bubble — plain DOM, mounted as a child of the `.page` element
// (see the annotation section of the file header comment).
// ──────────────────────────────────────────────────────────────────────────────

// Lucide icon path data (message-circle / check / trash-2), inlined as static
// markup — matches the icons `AssistantSelectionQuoteButton` renders via
// lucide-react, reproduced here because this DOM is built imperatively, not
// through React. No user data is ever interpolated into these strings.
const MESSAGE_CIRCLE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>'
const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
const TRASH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>'

/**
 * Resolve the `.page` element as an `HTMLElement` (needed for style writes
 * and as a mount point), or null if unavailable / not yet rendered.
 *
 * Obsidian popouts are separate BrowserWindows with their own realm — a
 * `.page` element living there fails `instanceof HTMLElement` against the
 * *main* window's `HTMLElement` constructor. Resolve the constructor from
 * the element's own `ownerDocument`/`defaultView` instead (see CLAUDE.md's
 * popout constraints), falling back to the global only when the element has
 * no `defaultView` (e.g. a detached/test document).
 */
function resolvePageHtmlEl(
  leaf: WorkspaceLeaf,
  pageNumber: number,
): HTMLElement | null {
  const el = resolvePageEl(leaf, pageNumber)
  if (!el) return null
  const HTMLElementCtor =
    el.ownerDocument?.defaultView?.HTMLElement ?? HTMLElement
  return el instanceof HTMLElementCtor ? el : null
}

/**
 * The same "last range's last non-empty rect" algorithm
 * `AssistantSelectionQuoteButton.measureAnnotations` uses, converted to
 * page-relative coordinates instead of a React container ref.
 */
function resolveAnnotationAnchor(
  entry: PdfHighlightEntry,
): { pageEl: HTMLElement; left: number; top: number } | null {
  const pageEl = resolvePageHtmlEl(entry.leaf, entry.pageNumber)
  if (!pageEl) return null
  const lastRange = entry.ranges.at(-1)
  if (!lastRange) return null
  const rects = Array.from(lastRange.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  )
  const rect = rects.at(-1) ?? lastRange.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  const pageRect = pageEl.getBoundingClientRect()
  return {
    pageEl,
    left: rect.right - pageRect.left,
    top: rect.top - pageRect.top,
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Controller
// ──────────────────────────────────────────────────────────────────────────────

export class PdfSelectionHighlightController {
  /** Map from highlight id to its entry. */
  private entries = new Map<string, PdfHighlightEntry>()

  /**
   * Add (or replace) a highlight identified by `id`.
   *
   * - variant 'sync': at most one sync entry per leaf; adding a new sync entry
   *   for the same leaf first removes the previous one.
   * - variant 'pinned': entries accumulate; same id replaces, different id adds.
   *
   * @param leaf       The WorkspaceLeaf that owns the PDF view.
   * @param id         Opaque id that links this highlight to a chat mention.
   * @param location   The live browser Range + page number + TFile.
   * @param variant    'sync' (auto-cleared on selection change) or 'pinned'.
   * @param owner      Who manages this highlight; reconcile only clears 'chat' entries.
   * @param options.paint  Caller's paint intent (mirrors e.g. the
   *   `persistSelectionHighlight` setting, which this controller doesn't read
   *   itself). Defaults to `true`. Combined with `shouldCreateSelectionHighlight(owner)`
   *   — the existing mobile policy still wins even when `paint` is true.
   *   The anchor (offsets/ranges/textlayerrendered subscription) is created
   *   unconditionally regardless of this flag — see the file header comment.
   */
  addHighlight(
    leaf: WorkspaceLeaf,
    id: string,
    location: { range: Range; pageNumber: number; file: TFile },
    variant: 'sync' | 'pinned',
    owner: HighlightOwner,
    options?: { paint?: boolean },
  ): void {
    // For sync variant: remove any existing sync entry on the same leaf first.
    if (variant === 'sync') {
      for (const [existingId, entry] of this.entries) {
        if (entry.leaf === leaf && entry.variant === 'sync') {
          this._removeEntry(existingId, entry)
        }
      }
    } else {
      // For pinned: if same id already exists, replace it.
      const existing = this.entries.get(id)
      if (existing) {
        this._removeEntry(id, existing)
      }
    }

    const pageEl = resolvePageEl(leaf, location.pageNumber)
    if (!pageEl) return

    const textLayer = pageEl.querySelector('.textLayer')
    if (!textLayer) return

    const textNodes = getTextNodes(pageEl)
    const offsets = computeOffsets(textLayer, location.range)
    if (!offsets) return

    const eventBus = resolveEventBus(leaf)
    if (!eventBus) return

    const { startOffset, endOffset } = offsets
    const ranges = buildRanges(textNodes, startOffset, endOffset)

    const paint =
      (options?.paint ?? true) && shouldCreateSelectionHighlight(owner)
    if (paint) {
      const highlight = getOrCreateHighlight()
      if (highlight) {
        for (const r of ranges) highlight.add(r)
      }
    }

    const entry: PdfHighlightEntry = {
      leaf,
      pageNumber: location.pageNumber,
      startOffset,
      endOffset,
      file: location.file,
      variant,
      owner,
      paint,
      eventBus,
      ranges,
      onTextLayerRendered: () => {}, // assigned below
    }

    entry.onTextLayerRendered = (evt: { pageNumber: number }): void => {
      if (evt.pageNumber !== location.pageNumber) return
      const el = resolvePageEl(leaf, location.pageNumber)
      if (!el) return

      const hl = entry.paint ? getOrCreateHighlight() : null
      if (hl) {
        for (const r of entry.ranges) hl.delete(r)
      }
      entry.ranges = buildRanges(getTextNodes(el), startOffset, endOffset)
      if (hl) {
        for (const r of entry.ranges) hl.add(r)
      }

      // PDF.js re-rendered this page (scale change, or the page's DOM was
      // recreated) — the annotation bubble, if any, must follow along
      // regardless of whether this entry is painted.
      if (entry.annotation) {
        this.repositionAnnotation(entry)
      }
    }
    ;(eventBus as any).on('textlayerrendered', entry.onTextLayerRendered)

    this.entries.set(id, entry)
  }

  /**
   * Remove the highlight with the given id.
   */
  clearById(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this._removeEntry(id, entry)
  }

  /**
   * Layer a numbered "批注N" bubble + comment editor onto an existing
   * 'pinned' entry (docs/plans/2026-08-16-pdf-annotation-quotes.md item 4).
   * `id` must already have been registered via `addHighlight` — a no-op when
   * it hasn't. Since anchor and paint are decoupled (see the file header
   * comment), this is unaffected by whether the entry is actually painted:
   * the CSS Custom Highlight API being unavailable and `persistSelectionHighlight`
   * being off both still leave a usable anchor, so the bubble renders either
   * way. The only remaining silent-degrade case is the anchor itself failing
   * to resolve (e.g. `addHighlight` couldn't compute offsets).
   *
   * `initial.annotationNumber` is chat-assigned and only ever rendered here
   * — this controller never invents or changes it (architecture decision A).
   * `initial.isNew: true` opens the editor immediately, focused — mirrors
   * `AssistantSelectionQuoteButton.handleCreateQuote`.
   */
  enableAnnotation(
    id: string,
    initial: { annotationNumber: number; comment: string; isNew: boolean },
    callbacks: PdfAnnotationCallbacks,
  ): void {
    const entry = this.entries.get(id)
    if (!entry) return

    const anchor = resolveAnnotationAnchor(entry)
    if (!anchor) return

    const doc = anchor.pageEl.ownerDocument
    const markerEl = doc.createElement('button')
    markerEl.type = 'button'
    markerEl.className = 'yolo-pdf-annotation-marker'
    // eslint-disable-next-line @microsoft/sdl/no-inner-html -- static SVG markup, no user input
    markerEl.innerHTML = `${MESSAGE_CIRCLE_SVG}<span class="yolo-pdf-annotation-marker-index"></span><span class="yolo-pdf-annotation-marker-preview" role="tooltip"></span>`
    const svgEl = markerEl.querySelector('svg')
    svgEl?.classList.add('yolo-pdf-annotation-marker-shape')
    const markerIndexEl = markerEl.querySelector(
      '.yolo-pdf-annotation-marker-index',
    ) as HTMLElement
    const markerPreviewEl = markerEl.querySelector(
      '.yolo-pdf-annotation-marker-preview',
    ) as HTMLElement

    const runtime: PdfAnnotationRuntime = {
      annotationNumber: initial.annotationNumber,
      comment: initial.comment,
      isNew: initial.isNew,
      callbacks,
      markerEl,
      markerIndexEl,
      markerPreviewEl,
      position: { left: anchor.left, top: anchor.top },
      editorEl: null,
      editorInputEl: null,
      removeOutsideClickListener: null,
    }
    entry.annotation = runtime

    markerIndexEl.textContent = String(initial.annotationNumber)
    this.updateMarkerPreview(runtime)
    markerEl.style.left = `${anchor.left}px`
    markerEl.style.top = `${anchor.top}px`
    markerEl.addEventListener('mousedown', (event) => event.preventDefault())
    markerEl.addEventListener('click', () => this.openAnnotationEditor(id))
    markerEl.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.removeAnnotationAndHighlight(id)
    })
    anchor.pageEl.appendChild(markerEl)

    if (initial.isNew) {
      this.openAnnotationEditor(id)
    }
  }

  /**
   * Recompute the marker's (and, if open, the editor's) page-relative
   * position after `entry.ranges` was rebuilt for a PDF.js re-render.
   */
  private repositionAnnotation(entry: PdfHighlightEntry): void {
    const runtime = entry.annotation
    if (!runtime) return
    const anchor = resolveAnnotationAnchor(entry)
    if (!anchor) return

    if (runtime.markerEl.parentElement !== anchor.pageEl) {
      anchor.pageEl.appendChild(runtime.markerEl)
    }
    runtime.position = { left: anchor.left, top: anchor.top }
    runtime.markerEl.style.left = `${anchor.left}px`
    runtime.markerEl.style.top = `${anchor.top}px`

    if (runtime.editorEl) {
      if (runtime.editorEl.parentElement !== anchor.pageEl) {
        anchor.pageEl.appendChild(runtime.editorEl)
      }
      const editorPosition = this.computeEditorPosition(runtime, {
        left: anchor.left,
        top: anchor.top,
      })
      runtime.editorEl.style.left = `${editorPosition.left}px`
      runtime.editorEl.style.top = `${editorPosition.top}px`
    }
  }

  /**
   * Clamp the editor's left within the page element's width — same
   * `boundaryLeft` / `boundaryRight - editorWidth` clamp
   * `AssistantSelectionQuoteButton.openEditor` applies against its message
   * container. The marker itself is intentionally left unclamped, matching
   * `measureAnnotations` there.
   */
  private computeEditorPosition(
    runtime: PdfAnnotationRuntime,
    position: { left: number; top: number },
  ): { left: number; top: number } {
    const pageEl = runtime.markerEl.parentElement
    const pageWidth = pageEl?.getBoundingClientRect().width ?? 0
    const editorWidth = runtime.isNew ? 300 : 320
    const boundaryLeft = 8
    const boundaryRight =
      pageWidth > 0 ? pageWidth - 8 : position.left + editorWidth
    return {
      left: Math.min(
        Math.max(position.left, boundaryLeft),
        Math.max(boundaryRight - editorWidth, boundaryLeft),
      ),
      top: Math.max(position.top + 16, 8),
    }
  }

  private updateMarkerPreview(runtime: PdfAnnotationRuntime): void {
    const trimmed = runtime.comment.trim()
    runtime.markerPreviewEl.textContent = trimmed
    runtime.markerPreviewEl.classList.toggle('has-content', trimmed.length > 0)
  }

  /**
   * Open (or refocus) the comment editor for `id`. Visual/interaction spec
   * mirrors `AssistantSelectionQuoteButton`'s editor: Enter or blur outside
   * saves and closes (keeping the annotation); Esc on a still-new draft
   * deletes the whole annotation; Esc otherwise just closes, same as Enter.
   * Non-new drafts get delete/save icon buttons.
   */
  private openAnnotationEditor(id: string): void {
    const entry = this.entries.get(id)
    const runtime = entry?.annotation
    if (!entry || !runtime) return

    if (runtime.editorEl) {
      runtime.editorInputEl?.focus()
      return
    }

    // Mirrors `AssistantSelectionQuoteButton`'s
    // `activeDraft?.id !== quote.id` guard on its preview span: suppress the
    // hover preview while this annotation's own editor is open.
    runtime.markerEl.classList.add('is-editing')

    const doc = runtime.markerEl.ownerDocument
    const labels = runtime.callbacks.getLabels()
    const editorEl = doc.createElement('div')
    editorEl.className = `yolo-pdf-annotation-editor${runtime.isNew ? ' is-new' : ''}`

    const inputEl = doc.createElement('input')
    inputEl.type = 'text'
    inputEl.value = runtime.comment
    inputEl.placeholder = labels.commentPlaceholder
    editorEl.appendChild(inputEl)

    const commitClose = (): void => {
      this.closeAnnotationEditor(id)
    }

    inputEl.addEventListener('input', () => {
      runtime.comment = inputEl.value
      this.updateMarkerPreview(runtime)
      runtime.callbacks.onCommentChange(id, inputEl.value)
    })
    inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        commitClose()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        if (runtime.isNew) {
          this.removeAnnotationAndHighlight(id)
        } else {
          commitClose()
        }
      }
    })
    inputEl.addEventListener('focusout', (event) => {
      const next = event.relatedTarget
      const NodeCtor = doc.defaultView?.Node ?? Node
      if (next instanceof NodeCtor && editorEl.contains(next)) {
        return
      }
      commitClose()
    })

    if (!runtime.isNew) {
      const actionsEl = doc.createElement('div')
      actionsEl.className = 'yolo-pdf-annotation-editor-actions'

      const deleteButton = doc.createElement('button')
      deleteButton.type = 'button'
      deleteButton.className = 'clickable-icon'
      deleteButton.setAttribute('aria-label', labels.deleteLabel)
      deleteButton.title = labels.deleteLabel
      // eslint-disable-next-line @microsoft/sdl/no-inner-html -- static SVG markup, no user input
      deleteButton.innerHTML = TRASH_SVG
      deleteButton.addEventListener('click', () =>
        this.removeAnnotationAndHighlight(id),
      )
      actionsEl.appendChild(deleteButton)

      const saveButton = doc.createElement('button')
      saveButton.type = 'button'
      saveButton.className = 'clickable-icon'
      saveButton.setAttribute('aria-label', labels.saveLabel)
      saveButton.title = labels.saveLabel
      // eslint-disable-next-line @microsoft/sdl/no-inner-html -- static SVG markup, no user input
      saveButton.innerHTML = CHECK_SVG
      saveButton.addEventListener('click', commitClose)
      actionsEl.appendChild(saveButton)

      editorEl.appendChild(actionsEl)
    }

    const editorPosition = this.computeEditorPosition(runtime, runtime.position)
    editorEl.style.left = `${editorPosition.left}px`
    editorEl.style.top = `${editorPosition.top}px`
    editorEl.addEventListener('mousedown', (event) => event.stopPropagation())

    const handleOutsidePointerDown = (event: PointerEvent): void => {
      const target = event.target
      const NodeCtor = doc.defaultView?.Node ?? Node
      if (target instanceof NodeCtor && editorEl.contains(target)) {
        return
      }
      commitClose()
    }
    doc.addEventListener('pointerdown', handleOutsidePointerDown, true)
    runtime.removeOutsideClickListener = () =>
      doc.removeEventListener('pointerdown', handleOutsidePointerDown, true)

    runtime.editorEl = editorEl
    runtime.editorInputEl = inputEl
    runtime.markerEl.parentElement?.appendChild(editorEl)

    const win = doc.defaultView
    if (win) {
      win.requestAnimationFrame(() => inputEl.focus())
    } else {
      inputEl.focus()
    }
  }

  /**
   * Close the editor but keep the annotation (Enter, blur, or Esc on a
   * non-new draft) — mirrors `AssistantSelectionQuoteButton.handleSave`.
   */
  private closeAnnotationEditor(id: string): void {
    const runtime = this.entries.get(id)?.annotation
    if (!runtime?.editorEl) return
    runtime.removeOutsideClickListener?.()
    runtime.removeOutsideClickListener = null
    runtime.editorEl.remove()
    runtime.editorEl = null
    runtime.editorInputEl = null
    runtime.isNew = false
    runtime.markerEl.classList.remove('is-editing')
  }

  /**
   * User-initiated deletion (right-click on the marker, or Esc on a still-
   * new draft): notify chat via `onDelete`, then tear down the highlight —
   * which also removes the bubble DOM through `_removeEntry`.
   */
  private removeAnnotationAndHighlight(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.annotation?.callbacks.onDelete(id)
    this._removeEntry(id, entry)
  }

  /**
   * Tear down the bubble DOM for `entry`, if any. Does NOT call
   * `onDelete` — `_removeEntry` runs on every removal path (explicit
   * deletion, `reconcileActiveIds`, `pruneDetachedLeaves`, `clearAll`), and
   * only the explicit-deletion path (`removeAnnotationAndHighlight`) is a
   * genuine "the user deleted this" event; the others just mean the chat
   * mention it tracked is already gone (or its leaf is), so notifying chat
   * again would be a no-op at best.
   */
  private teardownAnnotation(entry: PdfHighlightEntry): void {
    const runtime = entry.annotation
    if (!runtime) return
    runtime.removeOutsideClickListener?.()
    runtime.editorEl?.remove()
    runtime.markerEl.remove()
    entry.annotation = undefined
  }

  /**
   * Remove all highlights whose owner is 'chat' and whose id is NOT in `ids`.
   * Highlights belonging to other owners (quickask, transient) are never touched.
   */
  reconcileActiveIds(ids: Set<string>): void {
    for (const [id, entry] of Array.from(this.entries)) {
      if (entry.owner === 'chat' && !ids.has(id)) {
        this._removeEntry(id, entry)
      }
    }
  }

  /**
   * Remove all pinned highlights (e.g. on plugin unload).
   */
  clearAll(): void {
    for (const [id, entry] of Array.from(this.entries)) {
      this._removeEntry(id, entry)
    }
  }

  /**
   * Remove pinned highlights for leaves that are no longer open in the
   * workspace.  Call this on every `layout-change` event.
   */
  pruneDetachedLeaves(app: App): void {
    const openPdfLeaves = app.workspace.getLeavesOfType('pdf')
    for (const [id, entry] of Array.from(this.entries)) {
      if (!openPdfLeaves.includes(entry.leaf)) {
        this._removeEntry(id, entry)
      }
    }
  }

  private _removeEntry(id: string, entry: PdfHighlightEntry): void {
    entry.eventBus.off('textlayerrendered', entry.onTextLayerRendered)
    this.teardownAnnotation(entry)

    const highlight = getOrCreateHighlight()
    if (highlight) {
      for (const r of entry.ranges) highlight.delete(r)
    }

    this.entries.delete(id)
  }
}

export const pdfSelectionHighlightController =
  new PdfSelectionHighlightController()
