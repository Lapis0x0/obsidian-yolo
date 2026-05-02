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
 * page's textLayer spans in DOM order.
 *
 * Lifecycle per leaf:
 *   1. pin(leaf, range, pageNumber, file)  — compute offsets from the live
 *      Range and subscribe to PDF.js `textlayerrendered` events.
 *   2. On each `textlayerrendered` event for the pinned page, walk the spans,
 *      find those that overlap [startOffset, endOffset), and add the CSS class
 *      `yolo-pdf-selection-persisted`.
 *   3. clear(leaf) / clearAll()  — remove the class and unsubscribe.
 *
 * Whole-span granularity is used for v1: a span that straddles the boundary is
 * highlighted in full rather than splitting it.  This is simpler and avoids
 * mutating the DOM more than necessary.
 */

import type { App, TFile, WorkspaceLeaf } from 'obsidian'

const HIGHLIGHT_CLASS = 'yolo-pdf-selection-persisted'

type PinnedHighlight = {
  pageNumber: number
  startOffset: number
  endOffset: number
  file: TFile
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PDF.js eventBus is untyped
  eventBus: any
  onTextLayerRendered: (evt: { pageNumber: number }) => void
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
 * Given the text nodes of the pinned page, add the highlight CSS class to the
 * parent leaf span of every text node whose character range overlaps
 * [startOffset, endOffset).
 *
 * We add the class to the immediate parent element (the leaf span) rather than
 * the text node itself because CSS background-color only applies to elements.
 * A Set deduplicates the case where a single span has multiple text nodes.
 */
function applyHighlightToTextNodes(
  textNodes: Text[],
  startOffset: number,
  endOffset: number,
): void {
  let cursor = 0
  const highlighted = new Set<Element>()
  for (const node of textNodes) {
    const nodeStart = cursor
    const nodeEnd = cursor + node.length

    if (nodeEnd > startOffset && nodeStart < endOffset) {
      const parent = node.parentElement
      if (parent && !highlighted.has(parent)) {
        parent.classList.add(HIGHLIGHT_CLASS)
        highlighted.add(parent)
      }
    }

    cursor = nodeEnd
    if (cursor >= endOffset) break
  }
}

/**
 * Remove the highlight CSS class from all spans in a page element.
 */
function removeHighlightFromPage(pageEl: Element): void {
  pageEl
    .querySelectorAll(`.${HIGHLIGHT_CLASS}`)
    .forEach((el) => el.classList.remove(HIGHLIGHT_CLASS))
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

    const pageEl = resolvePageEl(leaf, pageNumber)
    if (!pageEl) return

    const textNodes = getTextNodes(pageEl)
    const offsets = computeOffsets(textNodes, range)
    if (!offsets) return

    const eventBus = resolveEventBus(leaf)
    if (!eventBus) return

    const { startOffset, endOffset } = offsets

    // Apply immediately to the already-rendered page.
    applyHighlightToTextNodes(textNodes, startOffset, endOffset)

    const onTextLayerRendered = (evt: { pageNumber: number }): void => {
      if (evt.pageNumber !== pageNumber) return
      const el = resolvePageEl(leaf, pageNumber)
      if (!el) return
      applyHighlightToTextNodes(getTextNodes(el), startOffset, endOffset)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PDF.js eventBus is untyped
    ;(eventBus as any).on('textlayerrendered', onTextLayerRendered)

    this.pinned.set(leaf, {
      pageNumber,
      startOffset,
      endOffset,
      file,
      eventBus,
      onTextLayerRendered,
    })
  }

  /**
   * Remove the highlight and event listener for the given leaf.
   */
  clear(leaf: WorkspaceLeaf): void {
    const entry = this.pinned.get(leaf)
    if (!entry) return

    const { pageNumber, eventBus, onTextLayerRendered } = entry

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PDF.js eventBus is untyped
    ;(eventBus as any).off('textlayerrendered', onTextLayerRendered)

    const pageEl = resolvePageEl(leaf, pageNumber)
    if (pageEl) removeHighlightFromPage(pageEl)

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
