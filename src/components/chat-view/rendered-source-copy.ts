// 渲染内容的源码还原复制。
//
// 公式（MathJax）和 mermaid 图渲染之后，页面上已经没有它们的 Markdown 源码，
// 浏览器默认复制只能拿到渲染结果里的零散文字。这里把每个渲染元素按出现顺序
// 对应回 Markdown 里的源码并标在元素上；选区碰到这类元素时，整段选区转成
// Markdown，这些元素换回原始源码。

import { htmlToMarkdown } from 'obsidian'

import { MERMAID_VIEWER_CLASS } from './MermaidViewer'

const SOURCE_ATTR = 'data-yolo-markdown-source'
const LATEX_SELECTED_CLASS = 'yolo-latex-selected'

type SourceTokenKind = 'inline-math' | 'block-math' | 'mermaid'

type SourceToken = {
  source: string
  kind: SourceTokenKind
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

  const ownerDoc = node.ownerDocument ?? document
  const selection = (ownerDoc.defaultView ?? window).getSelection()
  if (selection && typeof selection.containsNode === 'function') {
    return selection.containsNode(node, true)
  }

  const nodeRange = ownerDoc.createRange()
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
  const source = element.getAttribute(SOURCE_ATTR)
  if (source) {
    return isBlockSourceElement(element) ? `${source}\n` : source
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

function getSourceReplacementTargets(containerEl: ParentNode): HTMLElement[] {
  return Array.from(
    containerEl.querySelectorAll<HTMLElement>(`[${SOURCE_ATTR}]`),
  ).filter((element) => !element.parentElement?.closest(`[${SOURCE_ATTR}]`))
}

// Inline math sits inside a line of text; everything else (block math, a
// mermaid diagram) is a block of its own.
function isBlockSourceElement(element: HTMLElement): boolean {
  return !(
    element.classList.contains('math') &&
    !element.classList.contains('math-block')
  )
}

function sourcePlaceholder(index: number): string {
  // Letters and digits only, so htmlToMarkdown has nothing to escape in it.
  return `YOLOSOURCEPLACEHOLDER${index}END`
}

/**
 * Swap each source-annotated element for a placeholder and return the sources
 * in placeholder order. The sources are put back only after htmlToMarkdown,
 * which would otherwise escape their backslashes, backticks and `$`.
 */
function replaceSourcesWithPlaceholders(containerEl: HTMLElement): string[] {
  const sources: string[] = []
  getSourceReplacementTargets(containerEl).forEach((element) => {
    const source = element.getAttribute(SOURCE_ATTR)
    if (!source) {
      return
    }

    const ownerDocument = element.ownerDocument
    const replacementNode = isBlockSourceElement(element)
      ? ownerDocument.createElement('p')
      : ownerDocument.createElement('span')
    replacementNode.textContent = sourcePlaceholder(sources.length)
    sources.push(source)
    element.replaceWith(replacementNode)
  })
  return sources
}

function serializeSelectionAsMarkdown(range: Range): string {
  const fragment = range.cloneContents()
  const container = document.createElement('div')
  container.append(fragment)

  const sources = replaceSourcesWithPlaceholders(container)
  const markdown = sources.reduce(
    // A replacer function, not a string: `$$` in LaTeX is a replacement pattern.
    (text, source, index) =>
      text.replace(sourcePlaceholder(index), () => source),
    htmlToMarkdown(container.innerHTML),
  )

  return normalizeSerializedSelection(markdown)
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
  return extractSourceTokens(markdown)
    .filter((token) => token.kind !== 'mermaid')
    .map((token) => token.source)
}

export function extractMermaidSources(markdown: string): string[] {
  return extractSourceTokens(markdown)
    .filter((token) => token.kind === 'mermaid')
    .map((token) => token.source)
}

function isMermaidFence(text: string, markerStart: number): boolean {
  const lineEnd = text.indexOf('\n', markerStart)
  const info = text.slice(markerStart + 3, lineEnd === -1 ? undefined : lineEnd)
  return info.trim().split(/\s+/)[0] === 'mermaid'
}

function extractSourceTokens(markdown: string): SourceToken[] {
  const tokens: SourceToken[] = []
  let cursor = 0

  while (cursor < markdown.length) {
    if (
      (markdown.startsWith('```', cursor) ||
        markdown.startsWith('~~~', cursor)) &&
      getFenceMarkerStart(markdown, cursor) !== null
    ) {
      const fenceEnd = skipFenceBlock(markdown, cursor)
      if (isMermaidFence(markdown, cursor)) {
        tokens.push({
          source: markdown
            .slice(getLineStart(markdown, cursor), fenceEnd)
            .replace(/\n$/, ''),
          kind: 'mermaid',
        })
      }
      cursor = fenceEnd
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
          kind: 'block-math',
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
          kind: 'block-math',
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
        tokens.push({ source: parenLatex.source, kind: 'inline-math' })
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
        tokens.push({ source: inlineLatex.source, kind: 'inline-math' })
        cursor = inlineLatex.end
        continue
      }
    }

    cursor += 1
  }

  return tokens
}

function sourcesOfKind(tokens: SourceToken[], kind: SourceTokenKind) {
  return tokens.filter((token) => token.kind === kind).map((t) => t.source)
}

function annotateRenderedLatex(
  containerEl: HTMLElement,
  tokens: SourceToken[],
): void {
  const mathElements = getRenderedMathRoots(containerEl)
  const inlineSources = sourcesOfKind(tokens, 'inline-math')
  const blockSources = sourcesOfKind(tokens, 'block-math')
  let inlineIndex = 0
  let blockIndex = 0

  mathElements.forEach((element) => {
    element.removeAttribute(SOURCE_ATTR)
    element
      .querySelectorAll<HTMLElement>('mjx-container')
      .forEach((mathContainer) => {
        mathContainer.removeAttribute(SOURCE_ATTR)
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

    element.setAttribute(SOURCE_ATTR, latexSource)
    element
      .querySelectorAll<HTMLElement>('mjx-container')
      .forEach((mathContainer) => {
        mathContainer.setAttribute(SOURCE_ATTR, latexSource)
      })
  })
}

// The diagram block as it ends up on the page: the viewer wrapper once
// MermaidViewer has decorated it, so its open button goes along with it.
function getRenderedMermaidRoots(containerEl: HTMLElement): HTMLElement[] {
  return Array.from(containerEl.querySelectorAll<HTMLElement>('.mermaid'))
    .filter((element) => !element.parentElement?.closest('.mermaid'))
    .map(
      (element) =>
        element.closest<HTMLElement>(`.${MERMAID_VIEWER_CLASS}`) ?? element,
    )
}

function annotateRenderedMermaid(
  containerEl: HTMLElement,
  tokens: SourceToken[],
): void {
  containerEl
    .querySelectorAll<HTMLElement>(`.mermaid, .${MERMAID_VIEWER_CLASS}`)
    .forEach((element) => element.removeAttribute(SOURCE_ATTR))

  const roots = getRenderedMermaidRoots(containerEl)
  const sources = sourcesOfKind(tokens, 'mermaid')
  // Diagrams are matched to fences by position; if the counts disagree the
  // match is not trustworthy, and a plain copy beats a wrong diagram.
  if (roots.length !== sources.length) {
    return
  }
  roots.forEach((element, index) => {
    element.setAttribute(SOURCE_ATTR, sources[index])
  })
}

/**
 * Mark each rendered formula and mermaid diagram with its Markdown source.
 * Safe to run again: earlier marks are cleared first.
 */
export function annotateRenderedSources(
  containerEl: HTMLElement,
  markdown: string,
): void {
  const tokens = extractSourceTokens(markdown)
  annotateRenderedLatex(containerEl, tokens)
  annotateRenderedMermaid(containerEl, tokens)
  syncRenderedLatexSelection(containerEl)
}

export function syncRenderedLatexSelection(containerEl: HTMLElement): void {
  const selection = (
    containerEl.ownerDocument.defaultView ?? window
  ).getSelection()
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
    if (!element.hasAttribute(SOURCE_ATTR)) {
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

/**
 * Copy a selection that touches a rendered formula or diagram as Markdown,
 * with those elements restored to their source. `markdown` is the source the
 * container was rendered from; marks are refreshed from it here because
 * mermaid finishes rendering (and gets wrapped) after the render pass that
 * marked the formulas.
 */
export function copySelectedRenderedSource(
  event: ClipboardEvent,
  containerEl: HTMLElement,
  markdown: string,
): boolean {
  const selection = (
    containerEl.ownerDocument.defaultView ?? window
  ).getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false
  }

  const range = selection.getRangeAt(0)
  if (!containerEl.contains(range.commonAncestorContainer)) {
    return false
  }

  annotateRenderedSources(containerEl, markdown)
  const touchesRenderedSource = getSourceReplacementTargets(containerEl).some(
    (element) => rangeIntersectsNode(range, element),
  )
  if (!touchesRenderedSource) {
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
