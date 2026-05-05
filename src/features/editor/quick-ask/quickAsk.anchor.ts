/**
 * quickAsk.anchor.ts
 *
 * Abstraction layer that decouples QuickAskOverlay from CodeMirror's EditorView.
 *
 * QuickAskAnchor encapsulates every DOM-level operation the overlay needs so
 * that the same overlay code can work both in a Markdown (CodeMirror) leaf and
 * in a PDF leaf without any nullable guard proliferation.
 */

import type { EditorView } from '@codemirror/view'

/**
 * Minimal rect shape used throughout the anchor API.
 * Using a structural type so both CM's Rect and DOMRect satisfy it.
 */
export type AnchorRect = {
  left: number
  right: number
  top: number
  bottom: number
}

export type QuickAskAnchor = {
  /** The element that becomes the overlay's positioned ancestor. */
  hostEl: HTMLElement
  /**
   * The element to attach scroll + ResizeObserver listeners to.
   * CM uses scrollDOM; PDF uses the .pdf-viewer-container.
   * May be null when there is no suitable scrollable container.
   */
  scrollEl: HTMLElement | null
  /** Bounding rect of the leaf panel — used for dock-to-top-right. */
  getDockReferenceRect: () => AnchorRect
  /**
   * Left edge and width of the readable content area.
   * CM uses .cm-sizer; PDF uses the .pdf-viewer-container content box.
   */
  getContentBounds: () => { left: number; width: number }
  /**
   * The primary anchor rect (viewport-relative) for initial overlay placement.
   * Returns null when the anchor position is unavailable.
   */
  getAnchorRect: () => AnchorRect | null
  /**
   * Start and end rects of a multi-character selection, used to decide
   * whether the overlay should appear above or below the selection.
   * Returns null when there is no selection anchor.
   */
  getSelectionRects: () => { startRect: AnchorRect; endRect: AnchorRect } | null
  /**
   * Whether the anchor is still valid.
   * For PDF: checks that the live Range still has client rects.
   * Always returns true for CM anchors.
   */
  isValid: () => boolean
}

// ─── CodeMirror factory ──────────────────────────────────────────────────────

export function createCmAnchor(
  view: EditorView,
  pos: number,
  selectionAnchor: { from: number; to: number } | null,
): QuickAskAnchor {
  const resolveHostEl = (): HTMLElement => {
    const viewDom = view.dom
    const workspaceRoot =
      viewDom.closest('.workspace') ?? viewDom.closest('.app-container')
    if (workspaceRoot instanceof HTMLElement) return workspaceRoot

    const leafContent = viewDom.closest('.workspace-leaf-content')
    if (leafContent instanceof HTMLElement) return leafContent

    const workspaceLeaf = viewDom.closest('.workspace-leaf')
    if (workspaceLeaf instanceof HTMLElement) return workspaceLeaf

    return viewDom
  }

  return {
    hostEl: resolveHostEl(),
    scrollEl: view.scrollDOM ?? null,

    getDockReferenceRect(): DOMRect {
      const leafContent = view.dom?.closest('.workspace-leaf-content')
      if (leafContent instanceof HTMLElement) {
        return leafContent.getBoundingClientRect()
      }
      const scrollRect = view.scrollDOM?.getBoundingClientRect()
      if (scrollRect) return scrollRect
      return (
        view.dom?.getBoundingClientRect() ??
        document.body.getBoundingClientRect()
      )
    },

    getContentBounds(): { left: number; width: number } {
      const scrollDom = view.scrollDOM
      const scrollRect = scrollDom?.getBoundingClientRect()
      const sizer = scrollDom?.querySelector('.cm-sizer')
      const sizerRect = sizer?.getBoundingClientRect()
      const fallbackWidth = parseInt(
        getComputedStyle(document.documentElement).getPropertyValue(
          '--file-line-width',
        ) || '720',
        10,
      )
      const width = sizerRect?.width ?? scrollRect?.width ?? fallbackWidth
      const left = sizerRect?.left ?? scrollRect?.left ?? 0
      return { left, width }
    },

    getAnchorRect(): AnchorRect | null {
      if (selectionAnchor) {
        return view.coordsAtPos(selectionAnchor.to) ?? null
      }
      return view.coordsAtPos(pos) ?? null
    },

    getSelectionRects(): { startRect: AnchorRect; endRect: AnchorRect } | null {
      if (!selectionAnchor) return null
      const { from, to } = selectionAnchor
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to)
        return null
      const startRect = view.coordsAtPos(from)
      const endRect = view.coordsAtPos(to)
      if (!startRect || !endRect) return null
      return { startRect, endRect }
    },

    isValid(): boolean {
      return true
    },
  }
}

// ─── PDF factory ─────────────────────────────────────────────────────────────

export function createPdfAnchor(
  range: Range,
  leafContentEl: HTMLElement,
): QuickAskAnchor {
  const workspaceEl = leafContentEl.closest('.workspace')
  const appContainerEl = leafContentEl.closest('.app-container')
  const hostEl: HTMLElement =
    workspaceEl instanceof HTMLElement
      ? workspaceEl
      : appContainerEl instanceof HTMLElement
        ? appContainerEl
        : leafContentEl

  const scrollCandidate = leafContentEl.querySelector('.pdf-viewer-container')
  const scrollEl: HTMLElement =
    scrollCandidate instanceof HTMLElement ? scrollCandidate : leafContentEl

  return {
    hostEl,
    scrollEl,

    getDockReferenceRect(): DOMRect {
      return leafContentEl.getBoundingClientRect()
    },

    getContentBounds(): { left: number; width: number } {
      // The "content column" must equal where text actually starts on the
      // page, not the .page rect (which includes wide page margins) and not
      // .pdf-viewer-container (which includes the thumbnail sidebar). We
      // derive it from the selection's own glyph rects: the leftmost glyph
      // is the column-left, mirroring how cm-sizer behaves for Markdown.
      const startNode = range.startContainer
      const startEl =
        startNode.nodeType === 1
          ? (startNode as Element)
          : startNode.parentElement
      const pageEl = startEl?.closest('.page')

      const allRects = Array.from(range.getClientRects())
      const glyphRects = allRects.filter(
        (r) => r.width > 0 && r.height > 0 && r.height < 60,
      )

      if (glyphRects.length > 0 && pageEl instanceof HTMLElement) {
        const pageRect = pageEl.getBoundingClientRect()
        let minLeft = glyphRects[0].left
        for (let i = 1; i < glyphRects.length; i += 1) {
          if (glyphRects[i].left < minLeft) minLeft = glyphRects[i].left
        }
        const width = Math.max(120, pageRect.right - minLeft)
        return { left: minLeft, width }
      }

      if (pageEl instanceof HTMLElement) {
        const rect = pageEl.getBoundingClientRect()
        if (rect.width > 0) {
          return { left: rect.left, width: rect.width }
        }
      }

      const containerEl =
        leafContentEl.querySelector('.pdf-viewer-container') ?? leafContentEl
      const rect = containerEl.getBoundingClientRect()
      return { left: rect.left, width: rect.width }
    },

    getAnchorRect(): DOMRect | null {
      const rects = range.getClientRects()
      if (!rects.length) return null
      // Use the last client rect as the anchor (end of selection)
      return rects[rects.length - 1] ?? null
    },

    getSelectionRects(): { startRect: DOMRect; endRect: DOMRect } | null {
      const rects = range.getClientRects()
      if (!rects.length) return null
      const firstRect = rects[0]
      const lastRect = rects[rects.length - 1]
      if (!firstRect || !lastRect) return null
      return { startRect: firstRect, endRect: lastRect }
    },

    isValid(): boolean {
      return range.getClientRects().length > 0
    },
  }
}
