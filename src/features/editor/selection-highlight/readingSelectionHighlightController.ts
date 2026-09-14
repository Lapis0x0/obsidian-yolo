/**
 * Persists highlights over selected text in a Markdown view's reading mode,
 * painted with the CSS Custom Highlight API (`::highlight(yolo-reading-selection)`).
 *
 * Same registry contract as `pdfSelectionHighlightController` (opaque ids,
 * 'sync' / 'pinned' variants, owner-scoped reconcile), with a reading-view
 * anchor: the reading renderer virtualises sections and re-renders them when
 * the note changes, so a highlight is stored as
 *   source offset of the section the selection starts in
 *   + character offsets into the rendered text from that section on
 *   + the selected text itself.
 * Whenever the leaf's rendered DOM mutates, ranges are rebuilt against the
 * mounted nodes. If the anchor section is gone or its text no longer matches
 * (the note was edited), the highlight is simply not painted — there is no
 * fuzzy re-location.
 */

import type { App, TFile, WorkspaceLeaf } from 'obsidian'

import {
  type ReadingViewRenderer,
  getContentSections,
  getReadingViewRenderer,
} from '../selection-chat/readingViewSections'

import {
  type HighlightOwner,
  shouldCreateSelectionHighlight,
} from './selectionHighlightPolicy'
import {
  buildTextRanges,
  collectTextNodes,
  computeTextOffsets,
  paintHighlightRanges,
  unpaintHighlightRanges,
} from './textHighlightRanges'

const HIGHLIGHT_NAME = 'yolo-reading-selection'

type ReadingHighlightEntry = {
  leaf: WorkspaceLeaf
  file: TFile
  sectionOffset: number
  startOffset: number
  endOffset: number
  text: string
  variant: 'sync' | 'pinned'
  owner: HighlightOwner
  paint: boolean
  ranges: Range[]
}

type LeafObserver = {
  observer: MutationObserver
  frame: number | null
}

/**
 * Ranges for [startOffset, endOffset) counted from the start of the anchor
 * section, walking into following sections as needed — or none when the
 * mounted text no longer reads as the captured selection.
 */
function resolveRanges(
  renderer: ReadingViewRenderer,
  entry: ReadingHighlightEntry,
): Range[] {
  const sections = getContentSections(renderer)
  const anchorIndex = sections.findIndex(
    (section) => section.start.offset === entry.sectionOffset,
  )
  if (anchorIndex < 0) return []

  const textNodes: Text[] = []
  let length = 0
  for (const section of sections.slice(anchorIndex)) {
    for (const node of collectTextNodes([section.el])) {
      textNodes.push(node)
      length += node.length
    }
    if (length >= entry.endOffset) break
  }

  const ranges = buildTextRanges(textNodes, entry.startOffset, entry.endOffset)
  const text = ranges.map((range) => range.toString()).join('')
  return text === entry.text ? ranges : []
}

export class ReadingSelectionHighlightController {
  private entries = new Map<string, ReadingHighlightEntry>()
  private observers = new Map<WorkspaceLeaf, LeafObserver>()

  /**
   * Add (or replace) a highlight identified by `id`. A 'sync' entry replaces
   * any other 'sync' entry on the same leaf; 'pinned' entries accumulate.
   * `options.paint` mirrors the caller's `persistSelectionHighlight` intent
   * and is combined with the mobile policy.
   */
  addHighlight(
    leaf: WorkspaceLeaf,
    id: string,
    location: { range: Range; file: TFile },
    variant: 'sync' | 'pinned',
    owner: HighlightOwner,
    options?: { paint?: boolean },
  ): void {
    for (const [existingId, entry] of Array.from(this.entries)) {
      if (
        existingId === id ||
        (variant === 'sync' && entry.leaf === leaf && entry.variant === 'sync')
      ) {
        this.removeEntry(existingId, entry)
      }
    }

    const renderer = getReadingViewRenderer(leaf.view)
    if (!renderer) return
    const { range } = location
    const anchor = getContentSections(renderer).find((section) =>
      range.intersectsNode(section.el),
    )
    if (!anchor) return
    const offsets = computeTextOffsets(anchor.el, range)
    if (!offsets) return

    const entry: ReadingHighlightEntry = {
      leaf,
      file: location.file,
      sectionOffset: anchor.start.offset,
      startOffset: offsets.startOffset,
      endOffset: offsets.endOffset,
      text: range.toString(),
      variant,
      owner,
      paint: (options?.paint ?? true) && shouldCreateSelectionHighlight(owner),
      ranges: [],
    }
    this.entries.set(id, entry)
    this.rebuild(entry, renderer)
    this.observeLeaf(leaf, renderer)
  }

  clearById(id: string): void {
    const entry = this.entries.get(id)
    if (entry) this.removeEntry(id, entry)
  }

  /** Remove 'chat'-owned highlights whose id is not in `ids`. */
  reconcileActiveIds(ids: Set<string>): void {
    for (const [id, entry] of Array.from(this.entries)) {
      if (entry.owner === 'chat' && !ids.has(id)) {
        this.removeEntry(id, entry)
      }
    }
  }

  clearAll(): void {
    for (const [id, entry] of Array.from(this.entries)) {
      this.removeEntry(id, entry)
    }
  }

  /**
   * Drop highlights whose leaf was closed or now shows another file. Call on
   * every `layout-change`.
   */
  pruneDetachedLeaves(app: App): void {
    const openLeaves = app.workspace.getLeavesOfType('markdown')
    for (const [id, entry] of Array.from(this.entries)) {
      const file = (entry.leaf.view as { file?: TFile | null }).file
      if (!openLeaves.includes(entry.leaf) || file !== entry.file) {
        this.removeEntry(id, entry)
      }
    }
  }

  private rebuild(
    entry: ReadingHighlightEntry,
    renderer: ReadingViewRenderer,
  ): void {
    if (entry.paint) unpaintHighlightRanges(HIGHLIGHT_NAME, entry.ranges)
    entry.ranges = resolveRanges(renderer, entry)
    if (entry.paint) paintHighlightRanges(HIGHLIGHT_NAME, entry.ranges)
  }

  private observeLeaf(leaf: WorkspaceLeaf, renderer: ReadingViewRenderer) {
    if (this.observers.has(leaf)) return
    const win = renderer.sizerEl.ownerDocument.defaultView ?? window
    const state: LeafObserver = {
      frame: null,
      observer: new win.MutationObserver(() => {
        if (state.frame !== null) return
        state.frame = win.requestAnimationFrame(() => {
          state.frame = null
          this.rebuildLeaf(leaf)
        })
      }),
    }
    // Observe the scroller rather than the sizer: a full re-render may swap
    // the sizer's children wholesale, and the observer must survive that.
    state.observer.observe(renderer.previewEl, {
      childList: true,
      subtree: true,
    })
    this.observers.set(leaf, state)
  }

  private rebuildLeaf(leaf: WorkspaceLeaf): void {
    const renderer = getReadingViewRenderer(leaf.view)
    if (!renderer) return
    for (const entry of this.entries.values()) {
      if (entry.leaf === leaf) this.rebuild(entry, renderer)
    }
  }

  private removeEntry(id: string, entry: ReadingHighlightEntry): void {
    unpaintHighlightRanges(HIGHLIGHT_NAME, entry.ranges)
    this.entries.delete(id)

    const leafInUse = Array.from(this.entries.values()).some(
      (other) => other.leaf === entry.leaf,
    )
    const state = this.observers.get(entry.leaf)
    if (!leafInUse && state) {
      state.observer.disconnect()
      if (state.frame !== null) {
        const win =
          (entry.leaf.view?.containerEl.ownerDocument.defaultView as
            | Window
            | null
            | undefined) ?? window
        win.cancelAnimationFrame(state.frame)
      }
      this.observers.delete(entry.leaf)
    }
  }
}

export const readingSelectionHighlightController =
  new ReadingSelectionHighlightController()
