/**
 * getPdfSelectionData.ts
 *
 * Extract selection data (text + file + pageNumber) from an Obsidian PDF view.
 *
 * PDF.js renders text into a `.textLayer` made of real DOM `<span>` elements,
 * so `window.getSelection()` can capture them directly.  Each page's textLayer
 * is wrapped in a `.page[data-page-number="N"]` element, which lets us recover
 * the anchor page number.
 *
 * The function takes `app: App` and performs DOM → leaf reverse-lookup so that
 * it always attributes the selection to the leaf that actually owns the DOM
 * node, regardless of which leaf is currently "active".
 */

import type { App, TFile, WorkspaceLeaf } from 'obsidian'

export type PdfSelectionResult =
  | null // selection is not inside any PDF view — caller should not act
  | { kind: 'empty' } // selection is inside a PDF view but collapsed / empty
  | { kind: 'data'; content: string; file: TFile; pageNumber: number }

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

function isElement(node: Node | null): node is Element {
  // nodeType 1 === ELEMENT_NODE; works in both browser and test environments
  return node !== null && node.nodeType === 1
}

/**
 * Walk up the DOM from `node` to find the nearest `.page[data-page-number]`
 * ancestor and return the parsed page number, or null if not found.
 */
function getPageNumberFromNode(node: Node | null): number | null {
  let current: Node | null = node
  while (current) {
    if (isElement(current)) {
      if (current.classList.contains('page')) {
        const raw = current.getAttribute('data-page-number')
        if (raw) {
          const n = parseInt(raw, 10)
          if (Number.isFinite(n) && n >= 1) {
            return n
          }
        }
      }
    }
    current = current.parentNode
  }
  return null
}

/**
 * Walk up the DOM from `node` to find the nearest
 * `.workspace-leaf-content[data-type="pdf"]` ancestor element.
 * Returns that element or null if the selection is not inside a PDF leaf.
 */
function findOwningPdfLeafContent(node: Node | null): Element | null {
  let current: Node | null = node
  while (current) {
    if (isElement(current)) {
      if (
        current.matches(
          '.workspace-leaf-content[data-type="pdf"], .pdf-viewer-container, .pdf-embed',
        )
      ) {
        // Normalise: return the .workspace-leaf-content ancestor
        if (current.matches('.workspace-leaf-content[data-type="pdf"]')) {
          return current
        }
        const leafContent = current.closest(
          '.workspace-leaf-content[data-type="pdf"]',
        )
        if (leafContent) {
          return leafContent
        }
        // For .pdf-embed there may be no workspace-leaf-content ancestor;
        // signal "inside PDF" but we cannot map to a leaf.
        return current
      }
    }
    current = current.parentNode
  }
  return null
}

/**
 * Given a `.workspace-leaf-content` element, find the WorkspaceLeaf whose
 * `contentEl` (or `containerEl`) matches it.  Uses
 * `app.workspace.getLeavesOfType('pdf')` which is the public API.
 */
function findLeafByContentEl(
  app: App,
  leafContentEl: Element,
): WorkspaceLeaf | null {
  const pdfLeaves = app.workspace.getLeavesOfType('pdf')
  for (const leaf of pdfLeaves) {
    // Obsidian WorkspaceLeaf exposes `.view.containerEl` (the full leaf DOM)
    // and the inner `.view.contentEl`.  The `.workspace-leaf-content` element
    // is the `contentEl` of the leaf's view.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Obsidian private API
    const view = (leaf as any).view
    if (!view) continue
    if (view.containerEl && view.containerEl.contains(leafContentEl)) {
      return leaf
    }
  }
  return null
}

/**
 * Given the PDF leaf, return the TFile it currently displays.
 */
function getFileFromPdfLeaf(leaf: WorkspaceLeaf): TFile | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Obsidian private API
    const file = (leaf.view as any)?.file
    if (file && typeof file === 'object' && 'path' in file) {
      return file as TFile
    }
    return null
  } catch {
    return null
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Attempt to extract PDF selection data from the current browser selection.
 *
 * Returns a three-state discriminated union:
 *   - `null`               – selection is not inside any PDF view (caller must NOT clear badges)
 *   - `{ kind: 'empty' }` – selection is inside a PDF view but is collapsed/empty
 *   - `{ kind: 'data', content, file, pageNumber }` – valid PDF selection
 *
 * The owning leaf is resolved by walking the DOM upward from the selection's
 * anchor node, then matching against `app.workspace.getLeavesOfType('pdf')`.
 * This means the result is always attributed to the correct leaf even when
 * multiple PDF tabs are open.
 */
export function getPdfSelectionData(app: App): PdfSelectionResult {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) {
    return null
  }

  // Check whether the selection lives inside a PDF leaf at all.
  // We use the commonAncestorContainer as the walk starting point.
  let rangeContainer: Node | null = null
  try {
    rangeContainer = selection.getRangeAt(0).commonAncestorContainer
  } catch {
    return null
  }

  const owningLeafContent = findOwningPdfLeafContent(rangeContainer)
  if (!owningLeafContent) {
    // Selection is not in any PDF view — do nothing.
    return null
  }

  // Selection is inside a PDF view; check whether it has content.
  const text = selection.toString()
  if (!text || text.trim().length === 0) {
    return { kind: 'empty' }
  }

  // Resolve the WorkspaceLeaf that owns this DOM subtree.
  const leaf = findLeafByContentEl(app, owningLeafContent)
  if (!leaf) {
    // Inside a PDF container (maybe an embed) but cannot map to a leaf.
    return { kind: 'empty' }
  }

  const file = getFileFromPdfLeaf(leaf)
  if (!file) {
    return { kind: 'empty' }
  }

  // Page number from anchor node.
  const pageNumber = getPageNumberFromNode(selection.anchorNode)
  if (pageNumber === null) {
    return { kind: 'empty' }
  }

  return {
    kind: 'data',
    content: text,
    file,
    pageNumber,
  }
}
