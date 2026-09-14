/**
 * The one place that reads Obsidian's reading-view renderer internals.
 *
 * `MarkdownView.previewMode.renderer` is undocumented. It splits the note into
 * sections (roughly one per Markdown block), each holding its rendered element
 * and its source position. Sections are virtualised: off-screen elements are
 * detached from the document and re-attached on scroll.
 */

import type { View } from 'obsidian'

type SourcePosition = { line: number; col: number; offset: number }

export type ReadingViewSection = {
  el: HTMLElement
  /** 0-based source positions; `offset` counts from the start of the file. */
  start: SourcePosition
  end: SourcePosition
}

export type ReadingViewRenderer = {
  /** The scrolling `.markdown-preview-view` element. */
  previewEl: HTMLElement
  /** The element whose children are the section elements. */
  sizerEl: HTMLElement
  sections: ReadingViewSection[]
  /** The source text the sections were parsed from. */
  text: string
}

type ReadingModeView = View & {
  getMode?: () => string
  previewMode?: { renderer?: Partial<ReadingViewRenderer> }
}

/** The renderer of a Markdown view currently in reading mode, else null. */
export function getReadingViewRenderer(
  view: View | null | undefined,
): ReadingViewRenderer | null {
  const readingView = view as ReadingModeView | null | undefined
  if (readingView?.getMode?.() !== 'preview') return null
  const renderer = readingView.previewMode?.renderer
  if (
    !renderer?.previewEl ||
    !renderer.sizerEl ||
    !Array.isArray(renderer.sections) ||
    typeof renderer.text !== 'string'
  ) {
    return null
  }
  return renderer as ReadingViewRenderer
}

/**
 * Sections that render note content. The renderer also keeps UI pseudo-sections
 * (inline title and properties header, hidden frontmatter, backlinks footer)
 * marked `mod-ui`, whose source positions do not describe what they show.
 */
export function getContentSections(
  renderer: ReadingViewRenderer,
): ReadingViewSection[] {
  return renderer.sections.filter(
    (section) => !section.el.classList.contains('mod-ui'),
  )
}

/** Markdown blocks the source line of a boundary can be resolved within. */
function resolveLineInSection(
  renderer: ReadingViewRenderer,
  section: ReadingViewSection,
  node: Node,
  offset: number,
): number | null {
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement
  if (!el || !section.el.contains(el)) return null

  // Code block: rendered lines map 1:1 to source lines after the opening fence.
  const code = el.closest('pre > code')
  if (code && section.el.contains(code)) {
    const fenced = /^\s*(```|~~~)/.test(
      renderer.text.slice(section.start.offset),
    )
    const prefix = node.ownerDocument?.createRange()
    if (!prefix) return null
    prefix.selectNodeContents(code)
    prefix.setEnd(node, offset)
    const newlines = prefix.toString().split('\n').length - 1
    return section.start.line + (fenced ? 1 : 0) + newlines
  }

  // Table: header row, then the delimiter row, then one source line per row.
  const row = el.closest('tr')
  const table = row?.closest('table')
  if (
    row &&
    table &&
    section.el.contains(table) &&
    !table.parentElement?.closest('li, blockquote, .callout')
  ) {
    const rowIndex = Array.prototype.indexOf.call(table.rows, row) as number
    if (rowIndex >= 0) {
      return section.start.line + (rowIndex === 0 ? 0 : rowIndex + 1)
    }
  }

  // List item: Obsidian stamps each item with its line relative to the section.
  const item = el.closest('li[data-line]')
  if (item && section.el.contains(item)) {
    const relative = Number(item.getAttribute('data-line'))
    if (Number.isInteger(relative)) return section.start.line + relative
  }

  return null
}

/**
 * 1-based source line span of `range`. Paragraphs, list items, table rows and
 * code lines resolve to their own line; other multi-line blocks (quotes,
 * callouts) resolve to the whole block.
 */
export function resolveReadingSelectionLines(
  renderer: ReadingViewRenderer,
  range: Range,
): { startLine: number; endLine: number } | null {
  const sections = getContentSections(renderer).filter((section) =>
    range.intersectsNode(section.el),
  )
  const first = sections[0]
  const last = sections.at(-1)
  if (!first || !last) return null

  const startLine =
    resolveLineInSection(
      renderer,
      first,
      range.startContainer,
      range.startOffset,
    ) ?? first.start.line
  const endLine =
    resolveLineInSection(renderer, last, range.endContainer, range.endOffset) ??
    last.end.line

  return {
    startLine: startLine + 1,
    endLine: Math.max(startLine, endLine) + 1,
  }
}
