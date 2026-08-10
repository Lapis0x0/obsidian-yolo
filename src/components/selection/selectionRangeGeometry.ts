export function trimRangeEndWhitespace(range: Range): Range {
  const trimmed = range.cloneRange()
  const root = range.commonAncestorContainer
  const textNodes: Text[] = []
  if (root.nodeType === 3) {
    textNodes.push(root as Text)
  } else {
    const ownerDocument = range.startContainer.ownerDocument ?? document
    const walker = ownerDocument.createTreeWalker(
      root,
      ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4,
    )
    let current = walker.nextNode()
    while (current) {
      textNodes.push(current as Text)
      current = walker.nextNode()
    }
  }

  let lastTextNode: Text | null = null
  let lastTextOffset = 0
  for (const node of textNodes) {
    if (!range.intersectsNode(node)) continue
    const start = node === range.startContainer ? range.startOffset : 0
    const end = node === range.endContainer ? range.endOffset : node.length
    for (let index = end - 1; index >= start; index -= 1) {
      if (/\S/u.test(node.data[index] ?? '')) {
        lastTextNode = node
        lastTextOffset = index + 1
        break
      }
    }
  }
  if (lastTextNode) trimmed.setEnd(lastTextNode, lastTextOffset)
  return trimmed
}

export function getSelectionVisualLineRects(range: Range): DOMRect[] {
  const rects = Array.from(range.getClientRects())
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .sort((left, right) => left.top - right.top || left.left - right.left)
  const lines: DOMRect[] = []
  for (const rect of rects) {
    const previous = lines.at(-1)
    if (
      previous &&
      Math.abs(previous.top - rect.top) < 1 &&
      Math.abs(previous.bottom - rect.bottom) < 1
    ) {
      lines[lines.length - 1] = DOMRect.fromRect({
        x: Math.min(previous.left, rect.left),
        y: Math.min(previous.top, rect.top),
        width:
          Math.max(previous.right, rect.right) -
          Math.min(previous.left, rect.left),
        height:
          Math.max(previous.bottom, rect.bottom) -
          Math.min(previous.top, rect.top),
      })
      continue
    }
    lines.push(rect)
  }
  return lines
}
