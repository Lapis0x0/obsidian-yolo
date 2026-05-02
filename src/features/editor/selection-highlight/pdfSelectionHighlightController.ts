/**
 * pdfSelectionHighlightController.ts
 *
 * Persists a visual highlight over selected text in Obsidian's built-in PDF
 * viewer.  Mirrors the behaviour of SelectionHighlightController for Markdown
 * editors, but works around the fact that PDF.js tears down and recreates the
 * `.textLayer` <span> nodes on every page render (zoom, scroll out/back, etc.).
 *
 * The only stable identifier that survives re-renders is:
 *   file + pageNumber + [startOffset, endOffset)
 * where offsets are character indices into the concatenated textContent of the
 * page's textLayer text nodes in DOM order.
 *
 * Painting uses the CSS Custom Highlight API: a singleton `Highlight` is
 * registered as `yolo-pdf-selection` and styled via `::highlight(...)` in
 * pdf-selection.css.  This gives character-level granularity without mutating
 * the textLayer DOM (so it never fights PDF.js's own reconciliation).
 *
 * Lifecycle per leaf:
 *   1. pin(leaf, range, pageNumber, file) — compute offsets from the live
 *      Range, build per-text-node sub-ranges, add them to the global Highlight,
 *      and subscribe to `textlayerrendered`.
 *   2. On each `textlayerrendered` event for the pinned page, rebuild the
 *      sub-ranges (old text nodes are detached after re-render) and replace the
 *      leaf's ranges in the Highlight.
 *   3. clear(leaf) / clearAll() — remove the leaf's ranges and unsubscribe.
 */

import type { App, TFile, WorkspaceLeaf } from 'obsidian'

const HIGHLIGHT_NAME = 'yolo-pdf-selection'

type PinnedHighlight = {
  pageNumber: number
  startOffset: number
  endOffset: number
  file: TFile
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PDF.js eventBus is untyped
  eventBus: any
  onTextLayerRendered: (evt: { pageNumber: number }) => void
  ranges: Range[]
}

// ──────────────────────────────────────────────────────────────────────────────
// CSS Custom Highlight registry
// ──────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Highlight / CSS.highlights are not in the TS DOM lib for ES6 target
type AnyHighlight = any

/**
 * Lazily get-or-create the singleton Highlight registered under HIGHLIGHT_NAME.
 *
 * Returns null when the runtime does not support the CSS Custom Highlight API
 * (e.g. older mobile webviews) — callers should silently no-op in that case
 * rather than fall back to a different rendering path that might mis-paint.
 */
function getOrCreateHighlight(): AnyHighlight | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- feature detection
  const w = window as any
  if (typeof w.Highlight !== 'function' || !w.CSS || !w.CSS.highlights) {
    return null
  }
  let highlight = w.CSS.highlights.get(HIGHLIGHT_NAME) as AnyHighlight | undefined
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
 *
 * Using text nodes (not spans) avoids double-counting when PDF.js uses nested
 * span structure: outer markedContent spans contain text-leaf spans, so
 * iterating spans makes textContent appear multiple times in the cursor sum.
 * Text nodes are always leaves, so each character is counted exactly once.
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
 * Given the text nodes of the page that contains `range`, compute the
 * character offsets of the selection into the concatenated text-node content.
 *
 * Text nodes are leaf nodes; `range.startContainer` / `range.endContainer`
 * point directly at them with character-index offsets, so there is no
 * double-counting risk.
 *
 * Returns null when the range does not overlap the textLayer at all.
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
 * Build per-text-node sub-Ranges that together cover exactly
 * [startOffset, endOffset) of the page's concatenated text content.
 *
 * Each text node that overlaps the selection contributes one Range whose
 * start/end offsets are clipped to the selection bounds — so partial-word
 * selections inside a single PDF.js span produce a Range that covers only the
 * selected characters, not the whole span.
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
 * Returns null when the internal structure is unavailable.
 */
function resolveEventBus(leaf: WorkspaceLeaf): unknown | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Obsidian private API
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Obsidian private API
    const containerEl = (leaf.view as any)?.containerEl as Element | undefined
    if (!containerEl) return null
    return (
      containerEl.querySelector(
        `.page[data-page-number="${pageNumber}"]`,
      ) ?? null
    )
  } catch {
    return null
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Controller
// ──────────────────────────────────────────────────────────────────────────────

export class PdfSelectionHighlightController {
  private pinned = new Map<WorkspaceLeaf, PinnedHighlight>()

  /**
   * Pin a highlight for the given leaf.
   *
   * @param leaf        The WorkspaceLeaf that owns the PDF view.
   * @param range       The live browser Range for the current selection.
   *                    Must be captured before `window.getSelection()` changes.
   * @param pageNumber  1-based page number that the selection lives on.
   * @param file        The TFile being displayed in the leaf.
   */
  pin(
    leaf: WorkspaceLeaf,
    range: Range,
    pageNumber: number,
    file: TFile,
  ): void {
    // Clear any previous highlight on this leaf first.
    this.clear(leaf)

    const highlight = getOrCreateHighlight()
    if (!highlight) return // CSS Custom Highlight API unavailable — silent no-op.

    const pageEl = resolvePageEl(leaf, pageNumber)
    if (!pageEl) return

    const textNodes = getTextNodes(pageEl)
    const offsets = computeOffsets(textNodes, range)
    if (!offsets) return

    const eventBus = resolveEventBus(leaf)
    if (!eventBus) return

    const { startOffset, endOffset } = offsets

    const ranges = buildRanges(textNodes, startOffset, endOffset)
    for (const r of ranges) highlight.add(r)

    const entry: PinnedHighlight = {
      pageNumber,
      startOffset,
      endOffset,
      file,
      eventBus,
      ranges,
      onTextLayerRendered: () => {}, // assigned below
    }

    entry.onTextLayerRendered = (evt: { pageNumber: number }): void => {
      if (evt.pageNumber !== pageNumber) return
      const el = resolvePageEl(leaf, pageNumber)
      if (!el) return

      // Old ranges point to detached text nodes after re-render — drop them
      // and rebuild against the freshly mounted text nodes.
      const hl = getOrCreateHighlight()
      if (!hl) return
      for (const r of entry.ranges) hl.delete(r)
      entry.ranges = buildRanges(getTextNodes(el), startOffset, endOffset)
      for (const r of entry.ranges) hl.add(r)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PDF.js eventBus is untyped
    ;(eventBus as any).on('textlayerrendered', entry.onTextLayerRendered)

    this.pinned.set(leaf, entry)
  }

  /**
   * Remove the highlight and event listener for the given leaf.
   */
  clear(leaf: WorkspaceLeaf): void {
    const entry = this.pinned.get(leaf)
    if (!entry) return

    const { eventBus, onTextLayerRendered, ranges } = entry

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PDF.js eventBus is untyped
    ;(eventBus as any).off('textlayerrendered', onTextLayerRendered)

    const highlight = getOrCreateHighlight()
    if (highlight) {
      for (const r of ranges) highlight.delete(r)
    }

    this.pinned.delete(leaf)
  }

  /**
   * Remove all pinned highlights (e.g. on plugin unload).
   */
  clearAll(): void {
    for (const leaf of Array.from(this.pinned.keys())) {
      this.clear(leaf)
    }
  }

  /**
   * Remove pinned highlights for leaves that are no longer open in the
   * workspace.  Call this on every `layout-change` event to avoid leaking
   * Map entries and eventBus listeners when the user closes a PDF tab.
   */
  pruneDetachedLeaves(app: App): void {
    const openPdfLeaves = app.workspace.getLeavesOfType('pdf')
    for (const leaf of Array.from(this.pinned.keys())) {
      if (!openPdfLeaves.includes(leaf)) {
        this.clear(leaf)
      }
    }
  }
}

export const pdfSelectionHighlightController =
  new PdfSelectionHighlightController()
