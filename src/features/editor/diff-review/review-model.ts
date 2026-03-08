import type { ApplyViewState } from '../../../types/apply-view.types'
import {
  createDiffBlocks,
  createLineDiffBlocks,
  type DiffBlock,
  type InlineDiffLine,
  type InlineDiffToken,
} from '../../../utils/chat/diff'

export type ReviewDecision = 'pending' | 'incoming' | 'current'

export type ApplyParagraph = {
  lines: InlineDiffLine[]
  hasChanges: boolean
  isEmpty: boolean
}

export function buildInlineReviewBlocks(
  currentMarkdown: string,
  incomingMarkdown: string,
): DiffBlock[] {
  return createDiffBlocks(currentMarkdown, incomingMarkdown)
}

export function buildFullReviewBlocks(
  currentMarkdown: string,
  incomingMarkdown: string,
): DiffBlock[] {
  return splitDiffBlocksByParagraph(
    createLineDiffBlocks(currentMarkdown, incomingMarkdown),
  )
}

export function countModifiedBlocks(blocks: DiffBlock[]): number {
  return blocks.reduce(
    (count, block) => (block.type === 'modified' ? count + 1 : count),
    0,
  )
}

export function generateReviewContent(
  blocks: DiffBlock[],
  decisions: ReadonlyMap<number, ReviewDecision>,
  defaultDecision: 'incoming' | 'current' = 'current',
): string {
  return blocks
    .map((block, index) => {
      if (block.type === 'unchanged') return block.value

      const original = block.originalValue
      const incoming = block.modifiedValue
      const decision = decisions.get(index) ?? defaultDecision
      const resolvedIncoming =
        incoming !== undefined ? incoming : (original ?? '')
      const resolvedCurrent = original ?? ''

      if (decision === 'incoming') return resolvedIncoming
      if (decision === 'pending' && defaultDecision === 'incoming') {
        return resolvedIncoming
      }
      return resolvedCurrent
    })
    .join('\n')
}

export function splitInlineLinesIntoParagraphs(
  lines: InlineDiffLine[],
): ApplyParagraph[] {
  if (lines.length === 0) return []

  const paragraphs: ApplyParagraph[] = []
  let currentLines: InlineDiffLine[] = []
  let currentHasChanges = false

  const pushCurrentParagraph = () => {
    if (currentLines.length === 0) return
    paragraphs.push({
      lines: currentLines,
      hasChanges: currentHasChanges,
      isEmpty: false,
    })
    currentLines = []
    currentHasChanges = false
  }

  lines.forEach((line) => {
    if (isInlineLineEmpty(line)) {
      pushCurrentParagraph()
      paragraphs.push({
        lines: [],
        hasChanges: false,
        isEmpty: true,
      })
      return
    }

    currentLines.push(line)
    currentHasChanges = currentHasChanges || lineHasChanges(line)
  })

  pushCurrentParagraph()

  const hasAnyChanges = paragraphs.some(
    (paragraph) => !paragraph.isEmpty && paragraph.hasChanges,
  )
  if (!hasAnyChanges) {
    const firstContentParagraph = paragraphs.find(
      (paragraph) => !paragraph.isEmpty,
    )
    if (firstContentParagraph) {
      firstContentParagraph.hasChanges = true
    }
  }

  return paragraphs
}

export function countOriginalLines(block: DiffBlock): number {
  if (block.type === 'unchanged') {
    return block.value.split('\n').length
  }
  if (block.originalValue === undefined) return 0
  return block.originalValue.split('\n').length
}

export function findSelectionTargetBlockIndex(
  blocks: DiffBlock[],
  selectionRange: ApplyViewState['selectionRange'],
): number | null {
  if (!selectionRange) return null

  const selectionStartLine = Math.min(
    selectionRange.from.line,
    selectionRange.to.line,
  )
  const selectionEndLine = Math.max(
    selectionRange.from.line,
    selectionRange.to.line,
  )

  let cursorLine = 0
  let fallbackModifiedIndex: number | null = null

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block.type !== 'modified') {
      cursorLine += countOriginalLines(block)
      continue
    }

    if (fallbackModifiedIndex === null) {
      fallbackModifiedIndex = index
    }

    const lineCount = countOriginalLines(block)
    const blockStart = cursorLine
    const blockEnd = lineCount > 0 ? cursorLine + lineCount - 1 : cursorLine
    const intersects =
      blockStart <= selectionEndLine && blockEnd >= selectionStartLine

    if (intersects) {
      return index
    }

    cursorLine += lineCount
  }

  return fallbackModifiedIndex
}

function splitDiffBlocksByParagraph(blocks: DiffBlock[]): DiffBlock[] {
  const paragraphBlocks: DiffBlock[] = []

  blocks.forEach((block) => {
    if (block.type === 'unchanged') {
      paragraphBlocks.push(block)
      return
    }

    const paragraphs = splitInlineLinesIntoParagraphs(block.inlineLines)
    if (paragraphs.length === 0) {
      paragraphBlocks.push(block)
      return
    }

    paragraphs.forEach((paragraph) => {
      if (paragraph.isEmpty) {
        paragraphBlocks.push({
          type: 'unchanged',
          value: '',
        })
        return
      }

      if (!paragraph.hasChanges) {
        paragraphBlocks.push({
          type: 'unchanged',
          value: inlineLinesToText(paragraph.lines, 'original'),
        })
        return
      }

      const hasOriginalLines = paragraph.lines.some(
        (line) => line.type !== 'added',
      )
      const hasModifiedLines = paragraph.lines.some(
        (line) => line.type !== 'removed',
      )
      const originalValue = hasOriginalLines
        ? inlineLinesToText(paragraph.lines, 'original')
        : undefined
      const modifiedValue = hasModifiedLines
        ? inlineLinesToText(paragraph.lines, 'modified')
        : undefined

      paragraphBlocks.push({
        type: 'modified',
        originalValue,
        modifiedValue,
        inlineLines: paragraph.lines,
        presentation: 'inline',
        blockType: 'paragraph',
      })
    })
  })

  return mergeAdjacentUnchangedBlocks(paragraphBlocks)
}

function isInlineLineEmpty(line: InlineDiffLine): boolean {
  const content = line.tokens.map((token) => token.text).join('')
  return content.trim().length === 0
}

function lineHasChanges(line: InlineDiffLine): boolean {
  if (line.type === 'added' || line.type === 'removed') return true
  return line.tokens.some(
    (token) => token.type === 'add' || token.type === 'del',
  )
}

function inlineLinesToText(
  lines: InlineDiffLine[],
  variant: 'original' | 'modified',
): string {
  return lines
    .map((line) => inlineTokensToText(line.tokens, variant))
    .join('\n')
}

function inlineTokensToText(
  tokens: InlineDiffToken[],
  variant: 'original' | 'modified',
): string {
  return tokens
    .filter((token) =>
      variant === 'original' ? token.type !== 'add' : token.type !== 'del',
    )
    .map((token) => token.text)
    .join('')
}

function mergeAdjacentUnchangedBlocks(blocks: DiffBlock[]): DiffBlock[] {
  const merged: DiffBlock[] = []
  blocks.forEach((block) => {
    const last = merged[merged.length - 1]
    if (block.type === 'unchanged' && last?.type === 'unchanged') {
      last.value = `${last.value}\n${block.value}`
      return
    }
    merged.push(block)
  })
  return merged
}
