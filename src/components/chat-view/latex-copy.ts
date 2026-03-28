import { htmlToMarkdown } from 'obsidian'

const LATEX_SOURCE_ATTR = 'data-smtcmp-latex-source'
const LATEX_SELECTED_CLASS = 'smtcmp-latex-selected'

type LatexSourceToken = {
  source: string
  display: boolean
}

const BLOCK_TAG_NAMES = new Set([
  'BLOCKQUOTE',
  'DD',
  'DIV',
  'DL',
  'DT',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HR',
  'LI',
  'OL',
  'P',
  'PRE',
  'TABLE',
  'TBODY',
  'TD',
  'TH',
  'THEAD',
  'TR',
  'UL',
])

function isEscaped(text: string, index: number): boolean {
  let backslashCount = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) {
    backslashCount += 1
  }

  return backslashCount % 2 === 1
}

function getLineStart(text: string, index: number): number {
  let lineStart = index
  while (lineStart > 0 && text[lineStart - 1] !== '\n') {
    lineStart -= 1
  }

  return lineStart
}

function getFenceMarkerStart(text: string, index: number): number | null {
  const lineStart = getLineStart(text, index)
  const prefix = text.slice(lineStart, index)

  return /^[ ]{0,3}$/.test(prefix) ? index : null
}

function getIndentedFenceMarkerStart(
  text: string,
  lineStart: number,
): number | null {
  let cursor = lineStart
  let spaceCount = 0

  while (cursor < text.length && text[cursor] === ' ' && spaceCount < 3) {
    cursor += 1
    spaceCount += 1
  }

  return cursor
}

function getBlockLatexStart(text: string, start: number): number {
  const lineStart = getLineStart(text, start)

  return /^[\t ]*$/.test(text.slice(lineStart, start)) ? lineStart : start
}

function preserveBlockLatexIndentation(
  text: string,
  start: number,
  end: number,
): string {
  return text.slice(getBlockLatexStart(text, start), end)
}

function skipFenceBlock(text: string, start: number): number {
  const marker = text.slice(start, start + 3)
  let cursor = text.indexOf('\n', start + 3)
  if (cursor === -1) {
    return text.length
  }

  cursor += 1
  while (cursor < text.length) {
    const fenceMarkerStart = getIndentedFenceMarkerStart(text, cursor)
    if (
      fenceMarkerStart !== null &&
      text.slice(fenceMarkerStart, fenceMarkerStart + 3) === marker
    ) {
      const lineEnd = text.indexOf('\n', fenceMarkerStart + 3)
      return lineEnd === -1 ? text.length : lineEnd + 1
    }

    const nextLineStart = text.indexOf('\n', cursor)
    if (nextLineStart === -1) {
      return text.length
    }
    cursor = nextLineStart + 1
  }

  return text.length
}

function skipInlineCode(text: string, start: number): number {
  let tickCount = 0
  while (text[start + tickCount] === '`') {
    tickCount += 1
  }

  const closingTicks = '`'.repeat(tickCount)
  const end = text.indexOf(closingTicks, start + tickCount)
  return end === -1 ? text.length : end + tickCount
}

function readDelimitedLatex(
  text: string,
  start: number,
  open: string,
  close: string,
  options?: {
    allowNewlines?: boolean
    allowWhitespaceAfterOpen?: boolean
    allowWhitespaceBeforeClose?: boolean
  },
): { source: string; end: number } | null {
  const allowNewlines = options?.allowNewlines ?? true
  const allowWhitespaceAfterOpen = options?.allowWhitespaceAfterOpen ?? true
  const allowWhitespaceBeforeClose = options?.allowWhitespaceBeforeClose ?? true
  const contentStart = start + open.length

  if (contentStart >= text.length) {
    return null
  }

  if (!allowWhitespaceAfterOpen && /\s/.test(text[contentStart] ?? '')) {
    return null
  }

  let cursor = contentStart
  while (cursor < text.length) {
    if (!allowNewlines && /\r|\n/.test(text[cursor])) {
      return null
    }

    if (text.startsWith(close, cursor) && !isEscaped(text, cursor)) {
      const contentEnd = cursor
      if (contentEnd <= contentStart) {
        return null
      }
      if (
        !allowWhitespaceBeforeClose &&
        /\s/.test(text[contentEnd - 1] ?? '')
      ) {
        return null
      }

      return {
        source: text.slice(start, cursor + close.length),
        end: cursor + close.length,
      }
    }

    cursor += 1
  }

  return null
}

function normalizeSerializedSelection(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n')
}

function nodeIntersectsRange(range: Range, node: Node): boolean {
  if (typeof range.intersectsNode === 'function') {
    return range.intersectsNode(node)
  }

  const selection = window.getSelection()
  if (selection && typeof selection.containsNode === 'function') {
    return selection.containsNode(node, true)
  }

  const nodeRange = document.createRange()
  nodeRange.selectNode(node)

  return !(
    range.compareBoundaryPoints(Range.END_TO_START, nodeRange) <= 0 ||
    range.compareBoundaryPoints(Range.START_TO_END, nodeRange) >= 0
  )
}

function sliceSelectedText(textNode: Text, range: Range): string {
  const textContent = textNode.textContent ?? ''
  if (!textContent || !nodeIntersectsRange(range, textNode)) {
    return ''
  }

  const startOffset = range.startContainer === textNode ? range.startOffset : 0
  const endOffset =
    range.endContainer === textNode ? range.endOffset : textContent.length

  return textContent.slice(startOffset, endOffset)
}

function serializeSelectedNode(node: Node, range: Range): string {
  if (!nodeIntersectsRange(range, node)) {
    return ''
  }

  if (node.nodeType === Node.TEXT_NODE) {
    return sliceSelectedText(node as Text, range)
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return ''
  }

  const element = node as HTMLElement
  const latexSource = element.getAttribute(LATEX_SOURCE_ATTR)
  if (latexSource) {
    return latexSource
  }

  if (element.tagName === 'BR') {
    return '\n'
  }

  const childText = Array.from(element.childNodes)
    .map((childNode) => serializeSelectedNode(childNode, range))
    .join('')

  if (!BLOCK_TAG_NAMES.has(element.tagName)) {
    return childText
  }

  if (!childText) {
    return ''
  }

  return `${childText}\n`
}

function serializeSelectionRange(
  containerEl: HTMLElement,
  range: Range,
): string {
  return Array.from(containerEl.childNodes)
    .map((node) => serializeSelectedNode(node, range))
    .join('')
}

function getLatexReplacementTargets(containerEl: ParentNode): HTMLElement[] {
  return Array.from(
    containerEl.querySelectorAll<HTMLElement>(`[${LATEX_SOURCE_ATTR}]`),
  ).filter(
    (element) => !element.parentElement?.closest(`[${LATEX_SOURCE_ATTR}]`),
  )
}

function replaceLatexSourcesForMarkdown(containerEl: HTMLElement): void {
  getLatexReplacementTargets(containerEl).forEach((element) => {
    const latexSource = element.getAttribute(LATEX_SOURCE_ATTR)
    if (!latexSource) {
      return
    }

    const replacementNode = element.classList.contains('math-block')
      ? document.createElement('p')
      : document.createElement('span')
    replacementNode.textContent = latexSource
    element.replaceWith(replacementNode)
  })
}

function serializeSelectionAsMarkdown(range: Range): string {
  const fragment = range.cloneContents()
  const container = document.createElement('div')
  container.append(fragment)

  replaceLatexSourcesForMarkdown(container)

  return normalizeSerializedSelection(htmlToMarkdown(container.innerHTML))
}

function getRenderedMathRoots(containerEl: HTMLElement): HTMLElement[] {
  return Array.from(containerEl.querySelectorAll<HTMLElement>('.math')).filter(
    (element) => !element.parentElement?.closest('.math'),
  )
}

function getRenderedLatexHighlightTargets(element: HTMLElement): HTMLElement[] {
  const mathNodes = Array.from(
    element.querySelectorAll<HTMLElement>('mjx-container > mjx-math'),
  )

  return mathNodes.length > 0 ? mathNodes : [element]
}

function clearRenderedLatexSelection(containerEl: HTMLElement): void {
  getRenderedMathRoots(containerEl).forEach((element) => {
    getRenderedLatexHighlightTargets(element).forEach((target) => {
      target.classList.remove(LATEX_SELECTED_CLASS)
    })
  })
}

function rangeIntersectsNode(range: Range, node: Node): boolean {
  return nodeIntersectsRange(range, node)
}

export function extractLatexSources(markdown: string): string[] {
  return extractLatexSourceTokens(markdown).map((token) => token.source)
}

function extractLatexSourceTokens(markdown: string): LatexSourceToken[] {
  const tokens: LatexSourceToken[] = []
  let cursor = 0

  while (cursor < markdown.length) {
    if (
      (markdown.startsWith('```', cursor) ||
        markdown.startsWith('~~~', cursor)) &&
      getFenceMarkerStart(markdown, cursor) !== null
    ) {
      cursor = skipFenceBlock(markdown, cursor)
      continue
    }

    if (markdown[cursor] === '`') {
      cursor = skipInlineCode(markdown, cursor)
      continue
    }

    if (markdown.startsWith('$$', cursor)) {
      const blockLatex = readDelimitedLatex(markdown, cursor, '$$', '$$')
      if (blockLatex) {
        tokens.push({
          source: preserveBlockLatexIndentation(
            markdown,
            cursor,
            blockLatex.end,
          ),
          display: true,
        })
        cursor = blockLatex.end
        continue
      }
    }

    if (markdown.startsWith('\\[', cursor) && !isEscaped(markdown, cursor)) {
      const bracketLatex = readDelimitedLatex(markdown, cursor, '\\[', '\\]')
      if (bracketLatex) {
        tokens.push({
          source: preserveBlockLatexIndentation(
            markdown,
            cursor,
            bracketLatex.end,
          ),
          display: true,
        })
        cursor = bracketLatex.end
        continue
      }
    }

    if (markdown.startsWith('\\(', cursor) && !isEscaped(markdown, cursor)) {
      const parenLatex = readDelimitedLatex(markdown, cursor, '\\(', '\\)', {
        allowNewlines: false,
      })
      if (parenLatex) {
        tokens.push({ source: parenLatex.source, display: false })
        cursor = parenLatex.end
        continue
      }
    }

    if (markdown[cursor] === '$' && !isEscaped(markdown, cursor)) {
      const inlineLatex = readDelimitedLatex(markdown, cursor, '$', '$', {
        allowNewlines: false,
        allowWhitespaceAfterOpen: false,
        allowWhitespaceBeforeClose: false,
      })
      if (inlineLatex) {
        tokens.push({ source: inlineLatex.source, display: false })
        cursor = inlineLatex.end
        continue
      }
    }

    cursor += 1
  }

  return tokens
}

export function annotateRenderedLatex(
  containerEl: HTMLElement,
  markdown: string,
): void {
  const mathElements = getRenderedMathRoots(containerEl)
  const latexTokens = extractLatexSourceTokens(markdown)
  const inlineSources = latexTokens
    .filter((token) => !token.display)
    .map((token) => token.source)
  const blockSources = latexTokens
    .filter((token) => token.display)
    .map((token) => token.source)
  let inlineIndex = 0
  let blockIndex = 0

  mathElements.forEach((element) => {
    element.removeAttribute(LATEX_SOURCE_ATTR)
    element
      .querySelectorAll<HTMLElement>('mjx-container')
      .forEach((mathContainer) => {
        mathContainer.removeAttribute(LATEX_SOURCE_ATTR)
      })
  })

  mathElements.forEach((element) => {
    const isBlockMath = element.classList.contains('math-block')
    const latexSource = isBlockMath
      ? blockSources[blockIndex++]
      : inlineSources[inlineIndex++]
    if (!latexSource) {
      return
    }

    element.setAttribute(LATEX_SOURCE_ATTR, latexSource)
    element
      .querySelectorAll<HTMLElement>('mjx-container')
      .forEach((mathContainer) => {
        mathContainer.setAttribute(LATEX_SOURCE_ATTR, latexSource)
      })
  })

  syncRenderedLatexSelection(containerEl)
}

export function syncRenderedLatexSelection(containerEl: HTMLElement): void {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    clearRenderedLatexSelection(containerEl)
    return
  }

  const range = selection.getRangeAt(0)
  const commonAncestor = range.commonAncestorContainer
  if (!containerEl.contains(commonAncestor)) {
    clearRenderedLatexSelection(containerEl)
    return
  }

  getRenderedMathRoots(containerEl).forEach((element) => {
    if (!element.hasAttribute(LATEX_SOURCE_ATTR)) {
      getRenderedLatexHighlightTargets(element).forEach((target) => {
        target.classList.remove(LATEX_SELECTED_CLASS)
      })
      return
    }

    const isSelected = rangeIntersectsNode(range, element)
    getRenderedLatexHighlightTargets(element).forEach((target) => {
      target.classList.toggle(LATEX_SELECTED_CLASS, isSelected)
    })
  })
}

export function copySelectedLatex(
  event: ClipboardEvent,
  containerEl: HTMLElement,
): boolean {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false
  }

  const range = selection.getRangeAt(0)
  if (!containerEl.contains(range.commonAncestorContainer)) {
    return false
  }

  const hasLatexSelection = getRenderedMathRoots(containerEl).some(
    (element) =>
      element.hasAttribute(LATEX_SOURCE_ATTR) &&
      rangeIntersectsNode(range, element),
  )
  if (!hasLatexSelection) {
    return false
  }

  const serializedSelection =
    serializeSelectionAsMarkdown(range) ||
    normalizeSerializedSelection(serializeSelectionRange(containerEl, range))

  if (!serializedSelection || !event.clipboardData) {
    return false
  }

  event.preventDefault()
  event.clipboardData.setData('text/plain', serializedSelection)
  return true
}
