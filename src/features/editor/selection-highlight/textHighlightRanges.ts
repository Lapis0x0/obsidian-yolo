/**
 * Shared anchor/paint primitives for highlights on rendered (non-CodeMirror)
 * DOM — the PDF text layer and Markdown reading view.
 *
 * Both surfaces re-render their DOM, so a live Range cannot be the persistent
 * anchor. Instead a highlight is stored as character offsets into the text
 * nodes under a stable root, and rebuilt into Ranges against whatever nodes
 * are mounted after a re-render.
 *
 * Painting uses the CSS Custom Highlight API. The registry is per-window:
 * a Range living in an Obsidian popout must be added to that popout's
 * `CSS.highlights`, never the main window's.
 */

/** All text nodes under `roots`, in DOM order across roots. */
export function collectTextNodes(roots: Iterable<Node>): Text[] {
  const nodes: Text[] = []
  for (const root of roots) {
    const doc = root.ownerDocument ?? (root as Document)
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      nodes.push(node as Text)
      node = walker.nextNode()
    }
  }
  return nodes
}

/**
 * Character offsets of `range` relative to the start of `root`'s text.
 *
 * Measured with a prefix Range rather than by matching boundary containers
 * against text nodes: a selection boundary can land on an element (e.g. just
 * past a trailing period), where the offset counts child nodes, not
 * characters. `Range.setEnd` accepts element boundaries natively.
 *
 * `range` may extend past `root` — only its start has to lie inside it. A
 * start before `root` counts as offset 0.
 */
export function computeTextOffsets(
  root: Node,
  range: Range,
): { startOffset: number; endOffset: number } | null {
  const doc = root.ownerDocument ?? (root as Document)
  let startOffset = 0
  if (root.contains(range.startContainer)) {
    const prefixRange = doc.createRange()
    prefixRange.selectNodeContents(root)
    try {
      prefixRange.setEnd(range.startContainer, range.startOffset)
    } catch {
      return null
    }
    startOffset = prefixRange.toString().length
  }
  const endOffset = startOffset + range.toString().length
  if (startOffset >= endOffset) return null
  return { startOffset, endOffset }
}

/** Per-text-node Ranges covering exactly [startOffset, endOffset). */
export function buildTextRanges(
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
      const r = node.ownerDocument.createRange()
      r.setStart(node, Math.max(0, startOffset - nodeStart))
      r.setEnd(node, Math.min(node.length, endOffset - nodeStart))
      ranges.push(r)
    }

    cursor = nodeEnd
    if (cursor >= endOffset) break
  }
  return ranges
}

// The project's `lib` predates the Map/Set-like members of `Highlight` and
// `HighlightRegistry`, so the used surface is typed here.
type RangeHighlight = {
  add: (range: Range) => void
  delete: (range: Range) => void
}

type HighlightWindow = {
  Highlight?: new () => RangeHighlight
  CSS?: {
    highlights?: {
      get: (name: string) => RangeHighlight | undefined
      set: (name: string, highlight: RangeHighlight) => void
    }
  }
}

function getHighlight(name: string, win: HighlightWindow) {
  const registry = win.CSS?.highlights
  if (typeof win.Highlight !== 'function' || !registry) {
    return null
  }
  let highlight = registry.get(name)
  if (!highlight) {
    highlight = new win.Highlight()
    registry.set(name, highlight)
  }
  return highlight
}

function forEachWindowHighlight(
  name: string,
  ranges: Range[],
  apply: (highlight: RangeHighlight, range: Range) => void,
): void {
  for (const range of ranges) {
    const win = range.startContainer.ownerDocument?.defaultView as
      | HighlightWindow
      | null
      | undefined
    if (!win) continue
    const highlight = getHighlight(name, win)
    if (highlight) apply(highlight, range)
  }
}

export function paintHighlightRanges(name: string, ranges: Range[]): void {
  forEachWindowHighlight(name, ranges, (highlight, range) =>
    highlight.add(range),
  )
}

export function unpaintHighlightRanges(name: string, ranges: Range[]): void {
  forEachWindowHighlight(name, ranges, (highlight, range) =>
    highlight.delete(range),
  )
}
