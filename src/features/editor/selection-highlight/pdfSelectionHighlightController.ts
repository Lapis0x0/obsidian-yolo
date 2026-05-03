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
 */

import type { App, TFile, WorkspaceLeaf } from 'obsidian'

const HIGHLIGHT_NAME = 'yolo-pdf-selection'

export type HighlightOwner = 'chat' | 'quickask' | 'transient'

type PdfHighlightEntry = {
  leaf: WorkspaceLeaf
  pageNumber: number
  startOffset: number
  endOffset: number
  file: TFile
  variant: 'sync' | 'pinned'
  owner: HighlightOwner

  eventBus: any
  onTextLayerRendered: (evt: { pageNumber: number }) => void
  ranges: Range[]
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
function getOrCreateHighlight(): AnyHighlight | null {
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
 * Given text nodes of the page, compute character offsets of the selection
 * into the concatenated text-node content.
 */
function computeOffsets(
  textNodes: Text[],
  range: Range,
): { startOffset: number; endOffset: number } | null {
  let cursor = 0
  let startOffset: number | null = null
  let endOffset: number | null = null

  for (const node of textNodes) {
    const len = node.length
    const nodeStart = cursor

    if (node === range.startContainer) {
      startOffset = nodeStart + range.startOffset
    }

    if (node === range.endContainer) {
      endOffset = nodeStart + range.endOffset
    }

    cursor = nodeStart + len

    if (startOffset !== null && endOffset !== null) break
  }

  if (startOffset === null || endOffset === null) return null
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
function resolveEventBus(leaf: WorkspaceLeaf): unknown | null {
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
   */
  addHighlight(
    leaf: WorkspaceLeaf,
    id: string,
    location: { range: Range; pageNumber: number; file: TFile },
    variant: 'sync' | 'pinned',
    owner: HighlightOwner,
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

    const highlight = getOrCreateHighlight()
    if (!highlight) return // CSS Custom Highlight API unavailable — silent no-op.

    const pageEl = resolvePageEl(leaf, location.pageNumber)
    if (!pageEl) return

    const textNodes = getTextNodes(pageEl)
    const offsets = computeOffsets(textNodes, location.range)
    if (!offsets) return

    const eventBus = resolveEventBus(leaf)
    if (!eventBus) return

    const { startOffset, endOffset } = offsets
    const ranges = buildRanges(textNodes, startOffset, endOffset)
    for (const r of ranges) highlight.add(r)

    const entry: PdfHighlightEntry = {
      leaf,
      pageNumber: location.pageNumber,
      startOffset,
      endOffset,
      file: location.file,
      variant,
      owner,
      eventBus,
      ranges,
      onTextLayerRendered: () => {}, // assigned below
    }

    entry.onTextLayerRendered = (evt: { pageNumber: number }): void => {
      if (evt.pageNumber !== location.pageNumber) return
      const el = resolvePageEl(leaf, location.pageNumber)
      if (!el) return

      const hl = getOrCreateHighlight()
      if (!hl) return
      for (const r of entry.ranges) hl.delete(r)
      entry.ranges = buildRanges(getTextNodes(el), startOffset, endOffset)
      for (const r of entry.ranges) hl.add(r)
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

    const highlight = getOrCreateHighlight()
    if (highlight) {
      for (const r of entry.ranges) highlight.delete(r)
    }

    this.entries.delete(id)
  }
}

export const pdfSelectionHighlightController =
  new PdfSelectionHighlightController()
