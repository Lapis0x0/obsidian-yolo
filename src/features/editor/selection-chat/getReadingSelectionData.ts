/**
 * Extract selection data from a Markdown view in reading mode.
 *
 * Same three-state contract as `getPdfSelectionData`: `null` means the
 * selection is not in any reading view (the caller must not act), `empty`
 * means it is in one but there is nothing to act on.
 */

import type { App, MarkdownView, TFile, WorkspaceLeaf } from 'obsidian'

import {
  type ReadingViewRenderer,
  getReadingViewRenderer,
  resolveReadingSelectionLines,
} from './readingViewSections'

export type ReadingSelectionData = {
  kind: 'data'
  leaf: WorkspaceLeaf
  view: MarkdownView
  renderer: ReadingViewRenderer
  file: TFile
  /** Rendered text the user selected. */
  content: string
  /** 1-based, inclusive. */
  startLine: number
  endLine: number
  /** Live browser Range at capture time. */
  range: Range
}

export type ReadingSelectionResult =
  | null
  | { kind: 'empty'; leaf: WorkspaceLeaf }
  | ReadingSelectionData

/** Transcluded notes belong to another file than the view's source lines. */
const EMBED_SELECTOR = '.internal-embed'

function touchesEmbed(range: Range, root: HTMLElement): boolean {
  for (const node of [range.startContainer, range.endContainer]) {
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement
    if (el?.closest(EMBED_SELECTOR)) return true
  }
  return Array.from(root.querySelectorAll(EMBED_SELECTOR)).some(
    (embed) => embed.textContent?.trim() && range.intersectsNode(embed),
  )
}

export function getReadingSelectionData(
  app: App,
  selection: Selection | null,
): ReadingSelectionResult {
  if (!selection || selection.rangeCount === 0) return null
  // The selection's own Range follows later selection changes; keep a
  // snapshot so actions and highlights act on what was selected here.
  const range = selection.getRangeAt(0).cloneRange()

  let owner: { leaf: WorkspaceLeaf; renderer: ReadingViewRenderer } | null =
    null
  for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    const renderer = getReadingViewRenderer(leaf.view)
    if (renderer?.previewEl.contains(range.commonAncestorContainer)) {
      owner = { leaf, renderer }
      break
    }
  }
  if (!owner) return null

  const { leaf, renderer } = owner
  const view = leaf.view as MarkdownView
  const content = selection.toString().trim()
  if (!content || !view.file) return { kind: 'empty', leaf }
  if (touchesEmbed(range, renderer.sizerEl)) return { kind: 'empty', leaf }

  const lines = resolveReadingSelectionLines(renderer, range)
  if (!lines) return { kind: 'empty', leaf }

  return {
    kind: 'data',
    leaf,
    view,
    renderer,
    file: view.file,
    content,
    startLine: lines.startLine,
    endLine: lines.endLine,
    range,
  }
}
