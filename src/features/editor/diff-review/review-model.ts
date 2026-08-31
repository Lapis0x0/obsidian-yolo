import type { ChangeDesc } from '@codemirror/state'

import type { ApplyReviewEdit } from '../../../types/apply-view.types'
import { type DiffBlock, createLineDiffBlocks } from '../../../utils/chat/diff'

export type ReviewSide = 'original' | 'modified'

export type ReviewSuggestion = {
  id: number
  /** The live range in the editor's current (proposed) document. */
  from: number
  to: number
  startLine: number
  endLine: number
  /** The two independently editable drafts for this review item. */
  originalText: string
  modifiedText: string
  activeSide: ReviewSide
  /** Visible portions of drafts whose surrounding separators stay in the doc. */
  originalValue?: string
  modifiedValue?: string
}

export type SuggestionChange = {
  from: number
  to: number
  insert: string
}

export type ReviewPlan = {
  content: string
  changes: SuggestionChange[]
  suggestions: ReviewSuggestion[]
}

export type ReviewSuggestionUpdate = {
  suggestions: ReviewSuggestion[]
  removedIds: number[]
}

type ParagraphStructure = {
  leading: string
  paragraphs: Array<{ text: string; from: number; to: number }>
  separators: string[]
  trailing: string
}

type NormalizedReviewEdit = ApplyReviewEdit & {
  originalValue: string
  modifiedValue: string
}

type DocumentChange = {
  from: number
  to: number
}

/**
 * Builds a review plan whose suggestions point into the materialized proposed
 * document. The source text remains metadata used only for display and reject.
 */
export function buildReviewPlanFromEdits(
  originalContent: string,
  edits: ApplyReviewEdit[],
): ReviewPlan | null {
  const orderedEdits = [...edits].sort((left, right) => left.from - right.from)
  let previousEnd = 0

  for (const edit of orderedEdits) {
    if (
      !Number.isInteger(edit.from) ||
      !Number.isInteger(edit.to) ||
      edit.from < previousEnd ||
      edit.from < 0 ||
      edit.to < edit.from ||
      edit.to > originalContent.length
    ) {
      return null
    }
    previousEnd = edit.to
  }

  const normalizedEdits = orderedEdits
    .flatMap((edit) => splitEditByParagraphStructure(originalContent, edit))
    .filter(
      (edit) => originalContent.slice(edit.from, edit.to) !== edit.replacement,
    )

  return materializeReviewEdits(originalContent, normalizedEdits)
}

/**
 * 走 diff 切块的行数上限（单侧）。
 *
 * `createLineDiffBlocks` 的时间上限管不住行对齐：vscode-diff 只给「两侧合计
 * < 1700 行」的 dynamic-programming 路径传了 timeout，更大的输入走
 * `myersDiffingAlgorithm.compute(sequence1, sequence2)`，没有 timeout 参数
 * （同 `editSummary.ts` 的 `LINE_STATS_MAX_LINES`）。超限时退化成「整篇替换」
 * 的单个 edit：`splitEditByParagraphStructure` 仍会按段落拆分，只是拆分依据
 * 从 diff 块变成整篇的段落结构，段数对不上就退化成一个大评审项。
 *
 * 比行数统计宽松得多（那边是 2000），因为评审是用户主动触发的一次性计算，
 * 而且块的划分质量直接决定能不能逐段接受/拒绝。
 */
const REVIEW_DIFF_MAX_LINES = 5000

const countLines = (content: string): number => {
  let lines = 1
  for (let index = 0; index < content.length; index++) {
    if (content[index] === '\n') lines++
  }
  return lines
}

export function buildSnapshotReviewPlan(
  originalContent: string,
  incomingContent: string,
): ReviewPlan {
  const tooLargeToDiff =
    countLines(originalContent) > REVIEW_DIFF_MAX_LINES ||
    countLines(incomingContent) > REVIEW_DIFF_MAX_LINES
  const edits = tooLargeToDiff
    ? originalContent === incomingContent
      ? []
      : [
          {
            from: 0,
            to: originalContent.length,
            replacement: incomingContent,
          },
        ]
    : buildSnapshotReviewEdits(
        originalContent,
        createLineDiffBlocks(originalContent, incomingContent),
      )
  return (
    buildReviewPlanFromEdits(originalContent, edits) ?? {
      content: originalContent,
      changes: [],
      suggestions: [],
    }
  )
}

export function resolveSuggestionChange(
  currentContent: string,
  suggestion: ReviewSuggestion,
  side: ReviewSide = 'original',
): SuggestionChange {
  const from = Math.max(0, Math.min(suggestion.from, currentContent.length))
  const to = Math.max(from, Math.min(suggestion.to, currentContent.length))
  return {
    from,
    to,
    insert:
      side === suggestion.activeSide
        ? currentContent.slice(from, to)
        : getReviewDraft(suggestion, side),
  }
}

/**
 * Applies one ordinary editor transaction to pending review ranges.
 *
 * Boundary insertions are deliberately excluded from a range. A transaction
 * may retain a touched suggestion only when all of its changes are contained
 * by that one suggestion. Cross-boundary and multi-suggestion edits settle the
 * touched suggestions while preserving the user's document changes.
 */
export function updateReviewSuggestions(
  suggestions: ReviewSuggestion[],
  changes: ChangeDesc,
  currentContent?: string,
): ReviewSuggestionUpdate {
  const documentChanges = readDocumentChanges(changes)
  if (documentChanges.length === 0) {
    return { suggestions, removedIds: [] }
  }

  const touched = suggestions.filter((suggestion) =>
    documentChanges.some((change) =>
      changeTouchesSuggestion(change, suggestion),
    ),
  )
  const mayRetainTouched =
    touched.length === 1 &&
    documentChanges.every((change) =>
      changeIsInsideSuggestion(change, touched[0]),
    )
  const removedIds = mayRetainTouched
    ? []
    : touched.map((suggestion) => suggestion.id)
  const removedIdSet = new Set(removedIds)

  return {
    suggestions: suggestions
      .filter((suggestion) => !removedIdSet.has(suggestion.id))
      .map((suggestion) => {
        const mapped = mapSuggestion(
          suggestion,
          changes,
          mayRetainTouched && suggestion.id === touched[0]?.id,
        )
        if (
          currentContent === undefined ||
          !mayRetainTouched ||
          suggestion.id !== touched[0]?.id
        ) {
          return mapped
        }
        return setReviewDraft(
          mapped,
          mapped.activeSide,
          currentContent.slice(mapped.from, mapped.to),
        )
      }),
    removedIds,
  }
}

/** Map ranges for an overlay-owned transaction without resolving review items. */
export function mapReviewSuggestions(
  suggestions: ReviewSuggestion[],
  changes: ChangeDesc,
): ReviewSuggestion[] {
  return suggestions.map((suggestion) =>
    mapSuggestion(suggestion, changes, false),
  )
}

/** Map an overlay-owned replacement and make the replacement side editable. */
export function switchReviewSuggestionSide(
  suggestions: ReviewSuggestion[],
  suggestionId: number,
  side: ReviewSide,
  changes: ChangeDesc,
): ReviewSuggestion[] {
  let switchedRange: { from: number; to: number } | null = null
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const suggestion = suggestions.find((item) => item.id === suggestionId)
    if (suggestion && fromA === suggestion.from && toA === suggestion.to) {
      switchedRange = { from: fromB, to: toB }
    }
  })

  return suggestions.map((suggestion) => {
    if (suggestion.id !== suggestionId) {
      return mapSuggestion(suggestion, changes, false)
    }
    if (!switchedRange) return { ...suggestion, activeSide: side }
    return {
      ...suggestion,
      activeSide: side,
      from: switchedRange.from,
      to: switchedRange.to,
    }
  })
}

export function getReviewDraft(
  suggestion: ReviewSuggestion,
  side: ReviewSide,
): string {
  return side === 'original' ? suggestion.originalText : suggestion.modifiedText
}

export function getReviewDraftDisplay(
  suggestion: ReviewSuggestion,
  side: ReviewSide,
): { text: string; offset: number } {
  const draft = getReviewDraft(suggestion, side)
  const display =
    side === 'original' ? suggestion.originalValue : suggestion.modifiedValue
  if (display === undefined) return { text: '', offset: 0 }
  const offset = draft.indexOf(display)
  return offset < 0 ? { text: draft, offset: 0 } : { text: display, offset }
}

export function setReviewDraft(
  suggestion: ReviewSuggestion,
  side: ReviewSide,
  text: string,
): ReviewSuggestion {
  const previousDraft = getReviewDraft(suggestion, side)
  const previousDisplay =
    side === 'original' ? suggestion.originalValue : suggestion.modifiedValue
  const display = updateReviewDraftDisplay(previousDraft, previousDisplay, text)
  return side === 'original'
    ? { ...suggestion, originalText: text, originalValue: display }
    : { ...suggestion, modifiedText: text, modifiedValue: display }
}

function updateReviewDraftDisplay(
  previousDraft: string,
  previousDisplay: string | undefined,
  nextDraft: string,
): string | undefined {
  if (previousDisplay === undefined) return nextDraft || undefined
  const displayFrom = previousDraft.indexOf(previousDisplay)
  if (displayFrom < 0) return nextDraft || undefined
  const prefix = previousDraft.slice(0, displayFrom)
  const suffix = previousDraft.slice(displayFrom + previousDisplay.length)
  if (
    nextDraft.startsWith(prefix) &&
    nextDraft.endsWith(suffix) &&
    nextDraft.length >= prefix.length + suffix.length
  ) {
    const displayTo = nextDraft.length - suffix.length
    return nextDraft.slice(prefix.length, displayTo) || undefined
  }
  return nextDraft || undefined
}

function materializeReviewEdits(
  originalContent: string,
  edits: NormalizedReviewEdit[],
): ReviewPlan {
  const suggestions: ReviewSuggestion[] = []
  const changes: SuggestionChange[] = []
  let sourceCursor = 0
  let content = ''

  edits.forEach((edit, id) => {
    content += originalContent.slice(sourceCursor, edit.from)
    const from = content.length
    content += edit.replacement
    const to = content.length
    const startLine = offsetToLine(originalContent, edit.from)
    const endLine = offsetToLine(
      originalContent,
      edit.to > edit.from ? edit.to - 1 : edit.from,
    )

    suggestions.push({
      id,
      from,
      to,
      startLine,
      endLine,
      originalText: originalContent.slice(edit.from, edit.to),
      modifiedText: edit.replacement,
      activeSide: 'modified',
      originalValue: edit.originalValue || undefined,
      modifiedValue: edit.modifiedValue || undefined,
    })
    changes.push({ from: edit.from, to: edit.to, insert: edit.replacement })
    sourceCursor = edit.to
  })

  content += originalContent.slice(sourceCursor)
  return { content, changes, suggestions }
}

function readDocumentChanges(changes: ChangeDesc): DocumentChange[] {
  const result: DocumentChange[] = []
  changes.iterChangedRanges((fromA, toA) => {
    result.push({ from: fromA, to: toA })
  })
  return result
}

function changeTouchesSuggestion(
  change: DocumentChange,
  suggestion: ReviewSuggestion,
): boolean {
  if (change.from === change.to) {
    return change.from > suggestion.from && change.from < suggestion.to
  }
  if (suggestion.from === suggestion.to) {
    return change.from < suggestion.from && change.to > suggestion.to
  }
  return change.from < suggestion.to && change.to > suggestion.from
}

function changeIsInsideSuggestion(
  change: DocumentChange,
  suggestion: ReviewSuggestion,
): boolean {
  if (change.from === change.to) {
    return change.from > suggestion.from && change.from < suggestion.to
  }
  return change.from >= suggestion.from && change.to <= suggestion.to
}

function mapSuggestion(
  suggestion: ReviewSuggestion,
  changes: ChangeDesc,
  includeChangedBoundaries: boolean,
): ReviewSuggestion {
  if (suggestion.from === suggestion.to) {
    // A source-only (deleted) suggestion is rendered before the caret at its
    // anchor. Keep boundary input after that virtual source text so rejecting
    // restores the source before, rather than after, what the user typed.
    const anchor = changes.mapPos(suggestion.from, -1)
    return { ...suggestion, from: anchor, to: anchor }
  }

  return {
    ...suggestion,
    from: changes.mapPos(suggestion.from, includeChangedBoundaries ? -1 : 1),
    to: changes.mapPos(suggestion.to, includeChangedBoundaries ? 1 : -1),
  }
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
