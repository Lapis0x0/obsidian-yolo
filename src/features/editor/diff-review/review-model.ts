import type { ApplyReviewEdit } from '../../../types/apply-view.types'
import { type DiffBlock, createLineDiffBlocks } from '../../../utils/chat/diff'

export type ReviewSuggestion = {
  id: number
  from: number
  to: number
  displayFrom: number
  displayTo: number
  insert: string
  startLine: number
  endLine: number
  originalValue?: string
  modifiedValue?: string
}

export type SuggestionChange = {
  from: number
  to: number
  insert: string
}

type ParagraphStructure = {
  leading: string
  paragraphs: Array<{ text: string; from: number; to: number }>
  separators: string[]
  trailing: string
}

type NormalizedReviewEdit = ApplyReviewEdit & {
  displayFrom: number
  displayTo: number
  originalValue: string
  modifiedValue: string
}

export function buildSnapshotReviewSuggestions(
  currentContent: string,
  incomingContent: string,
): ReviewSuggestion[] {
  const edits = buildSnapshotReviewEdits(
    currentContent,
    createLineDiffBlocks(currentContent, incomingContent),
  )
  return buildReviewSuggestionsFromEdits(currentContent, edits) ?? []
}

export function buildReviewSuggestionsFromEdits(
  currentContent: string,
  edits: ApplyReviewEdit[],
): ReviewSuggestion[] | null {
  const orderedEdits = [...edits].sort((left, right) => left.from - right.from)
  let previousEnd = 0

  for (const edit of orderedEdits) {
    if (
      !Number.isInteger(edit.from) ||
      !Number.isInteger(edit.to) ||
      edit.from < previousEnd ||
      edit.from < 0 ||
      edit.to < edit.from ||
      edit.to > currentContent.length
    ) {
      return null
    }
    previousEnd = edit.to
  }

  const normalizedEdits = orderedEdits.flatMap((edit) =>
    splitEditByParagraphStructure(currentContent, edit),
  )

  return normalizedEdits.map((edit, index) => {
    const startLine = offsetToLine(currentContent, edit.displayFrom)
    const endLine = offsetToLine(
      currentContent,
      edit.displayTo > edit.displayFrom ? edit.displayTo - 1 : edit.displayFrom,
    )

    return {
      id: index,
      from: edit.from,
      to: edit.to,
      displayFrom: edit.displayFrom,
      displayTo: edit.displayTo,
      insert: edit.replacement,
      startLine,
      endLine,
      originalValue:
        edit.displayFrom === edit.displayTo ? undefined : edit.originalValue,
      modifiedValue:
        edit.modifiedValue.length > 0 ? edit.modifiedValue : undefined,
    }
  })
}

export function resolveSuggestionChange(
  currentContent: string,
  suggestion: ReviewSuggestion,
): SuggestionChange {
  const from = Math.max(0, Math.min(suggestion.from, currentContent.length))
  const to = Math.max(from, Math.min(suggestion.to, currentContent.length))
  return { from, to, insert: suggestion.insert }
}

function buildSnapshotReviewEdits(
  currentContent: string,
  blocks: DiffBlock[],
): ApplyReviewEdit[] {
  const edits: ApplyReviewEdit[] = []
  const lineStarts = getLineStarts(currentContent)
  let cursorLine = 0

  for (const block of blocks) {
    if (block.type === 'unchanged') {
      cursorLine += countOriginalLines(block)
      continue
    }

    const lineCount = countOriginalLines(block)
    const from = getLineStartOffset(
      lineStarts,
      currentContent.length,
      cursorLine,
    )
    const contentEnd =
      lineCount > 0
        ? getLineEndOffset(
            lineStarts,
            currentContent.length,
            cursorLine + lineCount - 1,
          )
        : from
    edits.push(
      resolveSnapshotBlockEdit(currentContent, {
        from,
        to: contentEnd,
        originalValue: block.originalValue,
        modifiedValue: block.modifiedValue,
      }),
    )
    cursorLine += lineCount
  }

  return edits
}

function resolveSnapshotBlockEdit(
  currentContent: string,
  block: {
    from: number
    to: number
    originalValue?: string
    modifiedValue?: string
  },
): ApplyReviewEdit {
  let { from, to } = block
  const replacement = block.modifiedValue ?? ''

  if (block.originalValue === undefined) {
    if (currentContent.length === 0) return { from, to, replacement }
    if (from === currentContent.length) {
      const prefix = currentContent.endsWith('\n') ? '' : '\n'
      return { from, to, replacement: `${prefix}${replacement}` }
    }
    const suffix = replacement.endsWith('\n') ? '' : '\n'
    return { from, to, replacement: `${replacement}${suffix}` }
  }

  if (block.modifiedValue === undefined && from < to) {
    if (currentContent[to] === '\n') {
      to += 1
    } else if (from > 0 && currentContent[from - 1] === '\n') {
      from -= 1
    }
  }

  return { from, to, replacement }
}

function splitEditByParagraphStructure(
  currentContent: string,
  edit: ApplyReviewEdit,
): NormalizedReviewEdit[] {
  const originalText = currentContent.slice(edit.from, edit.to)
  const originalStructure = parseParagraphStructure(originalText)
  const modifiedStructure = parseParagraphStructure(edit.replacement)

  if (
    originalStructure.paragraphs.length <= 1 ||
    originalStructure.paragraphs.length !== modifiedStructure.paragraphs.length
  ) {
    return [
      {
        ...edit,
        displayFrom: edit.from,
        displayTo: edit.to,
        originalValue: originalText,
        modifiedValue: edit.replacement,
      },
    ]
  }

  return originalStructure.paragraphs.flatMap((originalParagraph, index) => {
    const modifiedParagraph = modifiedStructure.paragraphs[index]
    if (!modifiedParagraph) return []

    const isFirst = index === 0
    const isLast = index === originalStructure.paragraphs.length - 1
    const originalFrom = isFirst ? 0 : originalParagraph.from
    const originalTo = isLast
      ? originalText.length
      : originalStructure.paragraphs[index + 1].from
    const replacement = `${isFirst ? modifiedStructure.leading : ''}${modifiedParagraph.text}${
      isLast
        ? modifiedStructure.trailing
        : (modifiedStructure.separators[index] ?? '')
    }`

    if (originalText.slice(originalFrom, originalTo) === replacement) {
      return []
    }

    return [
      {
        from: edit.from + originalFrom,
        to: edit.from + originalTo,
        replacement,
        displayFrom: edit.from + originalParagraph.from,
        displayTo: edit.from + originalParagraph.to,
        originalValue: originalParagraph.text,
        modifiedValue: modifiedParagraph.text,
      },
    ]
  })
}

function parseParagraphStructure(text: string): ParagraphStructure {
  const leading = text.match(/^(?:[\t ]*\n)+/)?.[0] ?? ''
  const afterLeading = text.slice(leading.length)
  const trailing = afterLeading.match(/(?:\n[\t ]*)+$/)?.[0] ?? ''
  const body = text.slice(leading.length, text.length - trailing.length)
  const paragraphs: ParagraphStructure['paragraphs'] = []
  const separators: string[] = []
  const separatorPattern = /\n(?:[\t ]*\n)+/g
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = separatorPattern.exec(body)) !== null) {
    paragraphs.push({
      text: body.slice(cursor, match.index),
      from: leading.length + cursor,
      to: leading.length + match.index,
    })
    separators.push(match[0])
    cursor = match.index + match[0].length
  }

  paragraphs.push({
    text: body.slice(cursor),
    from: leading.length + cursor,
    to: leading.length + body.length,
  })

  return { leading, paragraphs, separators, trailing }
}

function countOriginalLines(block: DiffBlock): number {
  if (block.type === 'unchanged') return block.value.split('\n').length
  if (block.originalValue === undefined) return 0
  return block.originalValue.split('\n').length
}

function offsetToLine(content: string, offset: number): number {
  let line = 0
  const clampedOffset = Math.max(0, Math.min(offset, content.length))
  for (let index = 0; index < clampedOffset; index += 1) {
    if (content[index] === '\n') line += 1
  }
  return line
}

function getLineStarts(content: string): number[] {
  const starts = [0]
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') starts.push(index + 1)
  }
  return starts
}

function getLineStartOffset(
  lineStarts: number[],
  contentLength: number,
  line: number,
): number {
  return lineStarts[line] ?? contentLength
}

function getLineEndOffset(
  lineStarts: number[],
  contentLength: number,
  line: number,
): number {
  const nextLineStart = lineStarts[line + 1]
  return nextLineStart === undefined ? contentLength : nextLineStart - 1
}
