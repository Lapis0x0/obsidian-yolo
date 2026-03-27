export type TextEditMatchMode =
  | 'exact'
  | 'lineEndingAndTrimLineEnd'
  | 'escapedControlRecovery'
  | 'escapedControlRecoveryLineEndingAndTrimLineEnd'
  | 'fuzzyUniqueParagraph'
  | 'lineRange'
  | 'append'

export type ReplaceTextOperation = {
  type: 'replace'
  oldText: string
  newText: string
  expectedOccurrences?: number
}

export type InsertAfterTextOperation = {
  type: 'insert_after'
  anchor: string
  content: string
  expectedOccurrences?: number
}

export type ReplaceLinesTextOperation = {
  type: 'replace_lines'
  startLine: number
  endLine: number
  newText: string
}

export type AppendTextOperation = {
  type: 'append'
  content: string
}

export type TextEditOperation =
  | ReplaceTextOperation
  | InsertAfterTextOperation
  | ReplaceLinesTextOperation
  | AppendTextOperation

export type TextEditPlan = {
  operations: TextEditOperation[]
}

export type AppliedTextEditOperation = {
  operation: TextEditOperation
  actualOccurrences: number
  expectedOccurrences: number | null
  matchMode: TextEditMatchMode
  changed: boolean
  matchedRange?: {
    start: number
    end: number
  }
  newRange?: {
    start: number
    end: number
  }
}

export type MaterializedTextEditPlan = {
  newContent: string
  appliedCount: number
  totalOperations: number
  errors: string[]
  operationResults: AppliedTextEditOperation[]
}

type ReplacementAttempt = {
  ok: true
  nextContent: string
  actualOccurrences: number
  expectedOccurrences: number
  matchMode: Exclude<TextEditMatchMode, 'append'>
  changed: boolean
  matchedRange: {
    start: number
    end: number
  }
  newRange: {
    start: number
    end: number
  }
}

type ReplacementFailure = {
  ok: false
  error: string
}

type ReplacementResult = ReplacementAttempt | ReplacementFailure

type LineRangeReplacementResult =
  | {
      ok: true
      nextContent: string
      matchMode: 'lineRange'
      changed: boolean
      matchedRange: {
        start: number
        end: number
      }
      newRange: {
        start: number
        end: number
      }
    }
  | {
      ok: false
      error: string
    }

const FUZZY_REPLACE_SIMILARITY_THRESHOLD = 0.95
const FUZZY_REPLACE_MIN_NORMALIZED_LENGTH = 30
const FUZZY_REPLACE_LENGTH_RATIO_MIN = 0.7
const FUZZY_REPLACE_LENGTH_RATIO_MAX = 1.4

const normalizeExpectedOccurrences = (value: number | undefined): number => {
  if (!value || !Number.isFinite(value)) {
    return 1
  }
  return Math.max(1, Math.floor(value))
}

const getLineStartOffsets = (content: string): number[] => {
  const offsets = [0]
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') {
      offsets.push(index + 1)
    }
  }
  return offsets
}

const applyReplaceLinesOperation = ({
  content,
  startLine,
  endLine,
  newText,
}: ReplaceLinesTextOperation & { content: string }): LineRangeReplacementResult => {
  if (!Number.isInteger(startLine) || startLine < 1) {
    return {
      ok: false,
      error: 'startLine must be a positive integer.',
    }
  }
  if (!Number.isInteger(endLine) || endLine < 1) {
    return {
      ok: false,
      error: 'endLine must be a positive integer.',
    }
  }
  if (endLine < startLine) {
    return {
      ok: false,
      error: 'endLine must be greater than or equal to startLine.',
    }
  }

  const currentLines = content.split('\n')
  const totalLines = currentLines.length
  if (startLine > totalLines || endLine > totalLines) {
    return {
      ok: false,
      error: `line range ${startLine}-${endLine} is out of bounds for ${totalLines} line(s).`,
    }
  }

  const lineOffsets = getLineStartOffsets(content)
  const matchedRangeStart = lineOffsets[startLine - 1] ?? 0
  const matchedRangeEnd =
    endLine < totalLines ? (lineOffsets[endLine] ?? content.length) : content.length

  const replacementLines = newText.length === 0 ? [] : newText.split('\n')
  const nextLines = [...currentLines]
  nextLines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines)
  const nextContent = nextLines.join('\n')
  const nextLineOffsets = getLineStartOffsets(nextContent)
  const insertedEndLine = startLine + replacementLines.length - 1
  const newRangeStart =
    replacementLines.length === 0
      ? Math.min(matchedRangeStart, nextContent.length)
      : (nextLineOffsets[startLine - 1] ?? nextContent.length)
  const newRangeEnd =
    replacementLines.length === 0
      ? newRangeStart
      : insertedEndLine + 1 < nextLineOffsets.length
        ? (nextLineOffsets[insertedEndLine] ?? nextContent.length)
        : nextContent.length

  return {
    ok: true,
    nextContent,
    matchMode: 'lineRange',
    changed: nextContent !== content,
    matchedRange: {
      start: matchedRangeStart,
      end: matchedRangeEnd,
    },
    newRange: {
      start: newRangeStart,
      end: newRangeEnd,
    },
  }
}

const countOccurrences = (content: string, target: string): number => {
  if (!target) {
    return 0
  }
  let count = 0
  let cursor = 0
  while (cursor <= content.length) {
    const index = content.indexOf(target, cursor)
    if (index === -1) break
    count += 1
    cursor = index + target.length
  }
  return count
}

const normalizeLineEndings = (value: string): string => {
  return value.replace(/\r\n/g, '\n')
}

const normalizeLineEndingsAndTrimLineEnd = (value: string): string => {
  return normalizeLineEndings(value)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
}

const CONTROL_CHAR_TO_ESCAPE_SUFFIX: Record<string, string> = {
  '\b': 'b',
  '\t': 't',
  '\f': 'f',
}

export const recoverLikelyEscapedBackslashSequences = (
  value: string,
): string => {
  if (!/[\b\t\f]/.test(value)) {
    return value
  }

  let changed = false
  let result = ''

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    const escapeSuffix = CONTROL_CHAR_TO_ESCAPE_SUFFIX[char]
    const nextChar = value[i + 1]

    if (escapeSuffix && nextChar && /[A-Za-z]/.test(nextChar)) {
      result += `\\${escapeSuffix}`
      changed = true
      continue
    }

    result += char
  }

  return changed ? result : value
}

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const toLooseCharPattern = (char: string): string => {
  if (char === '"' || char === '\u201c' || char === '\u201d') {
    return '["\u201c\u201d]'
  }
  if (char === "'" || char === '\u2018' || char === '\u2019') {
    return "['\u2018\u2019]"
  }
  if (char === '-' || char === '\u2013' || char === '\u2014') {
    return '[-\u2013\u2014]'
  }
  return escapeRegExp(char)
}

const createLooseEditRegex = (oldText: string): RegExp => {
  const lines = oldText.split(/\r?\n/)
  const pattern = lines
    .map((line, index) => {
      const normalizedLine = line.replace(/[ \t]+$/g, '')
      const looseLinePattern = Array.from(normalizedLine)
        .map((char) => toLooseCharPattern(char))
        .join('')
      const endWhitespace = '[ \\t]*'
      if (index === lines.length - 1) {
        return `${looseLinePattern}${endWhitespace}`
      }
      return `${looseLinePattern}${endWhitespace}\\r?\\n`
    })
    .join('')
  return new RegExp(pattern, 'g')
}

const countRegexMatches = (content: string, regex: RegExp): number => {
  let count = 0
  let match = regex.exec(content)
  while (match !== null) {
    count += 1
    if (match[0].length === 0) {
      regex.lastIndex += 1
    }
    match = regex.exec(content)
  }
  return count
}

const normalizeFuzzyComparisonText = (value: string): string => {
  return value
    .normalize('NFKC')
    .replace(/\r\n/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const buildCharacterBigramHistogram = (value: string): Map<string, number> => {
  const normalized = value.replace(/\s+/g, '')
  const histogram = new Map<string, number>()

  if (normalized.length === 0) {
    return histogram
  }

  if (normalized.length === 1) {
    histogram.set(normalized, 1)
    return histogram
  }

  for (let index = 0; index < normalized.length - 1; index += 1) {
    const gram = normalized.slice(index, index + 2)
    histogram.set(gram, (histogram.get(gram) ?? 0) + 1)
  }

  return histogram
}

const getBigramDiceSimilarity = (left: string, right: string): number => {
  if (left === right) {
    return 1
  }
  if (left.length === 0 || right.length === 0) {
    return 0
  }

  const leftHistogram = buildCharacterBigramHistogram(left)
  const rightHistogram = buildCharacterBigramHistogram(right)

  if (leftHistogram.size === 0 || rightHistogram.size === 0) {
    return 0
  }

  let overlap = 0
  let leftTotal = 0
  let rightTotal = 0

  leftHistogram.forEach((count, gram) => {
    leftTotal += count
    overlap += Math.min(count, rightHistogram.get(gram) ?? 0)
  })
  rightHistogram.forEach((count) => {
    rightTotal += count
  })

  if (leftTotal === 0 || rightTotal === 0) {
    return 0
  }

  return (2 * overlap) / (leftTotal + rightTotal)
}

type ParagraphSegment = {
  start: number
  end: number
}

const collectParagraphSegments = (content: string): ParagraphSegment[] => {
  const segments: ParagraphSegment[] = []
  let cursor = 0

  while (cursor < content.length) {
    let segmentStart = cursor
    while (
      segmentStart < content.length &&
      /[\r\n]/.test(content[segmentStart])
    ) {
      segmentStart += 1
    }

    if (segmentStart >= content.length) {
      break
    }

    let separatorStart = segmentStart
    while (separatorStart < content.length) {
      const separatorLength = content.startsWith('\r\n\r\n', separatorStart)
        ? 4
        : content.startsWith('\n\n', separatorStart)
          ? 2
          : content.startsWith('\r\r', separatorStart)
            ? 2
            : 0
      if (separatorLength > 0) {
        break
      }
      separatorStart += 1
    }

    segments.push({
      start: segmentStart,
      end: separatorStart,
    })

    cursor = separatorStart
    while (cursor < content.length && /[\r\n]/.test(content[cursor])) {
      cursor += 1
    }
  }

  return segments
}

type FuzzyCandidate = {
  start: number
  end: number
  similarity: number
}

const findFuzzyUniqueParagraphMatch = ({
  content,
  oldText,
}: {
  content: string
  oldText: string
}): {
  candidate: FuzzyCandidate
  secondBestSimilarity: number
  aboveThresholdCount: number
} | null => {
  const normalizedOldText = normalizeFuzzyComparisonText(oldText)
  if (normalizedOldText.length < FUZZY_REPLACE_MIN_NORMALIZED_LENGTH) {
    return null
  }

  const oldParagraphCount = Math.max(
    1,
    oldText.split(/\r?\n\s*\r?\n/).filter((part) => part.trim().length > 0)
      .length,
  )
  const segments = collectParagraphSegments(content)
  if (segments.length === 0) {
    return null
  }

  const minWindowSize = Math.max(1, oldParagraphCount - 1)
  const maxWindowSize = Math.min(segments.length, oldParagraphCount + 1)
  const visited = new Set<string>()
  const candidates: FuzzyCandidate[] = []

  for (
    let windowSize = minWindowSize;
    windowSize <= maxWindowSize;
    windowSize += 1
  ) {
    for (
      let startIndex = 0;
      startIndex <= segments.length - windowSize;
      startIndex += 1
    ) {
      const endIndex = startIndex + windowSize - 1
      const start = segments[startIndex]?.start
      const end = segments[endIndex]?.end
      if (start === undefined || end === undefined || end <= start) {
        continue
      }

      const key = `${start}:${end}`
      if (visited.has(key)) {
        continue
      }
      visited.add(key)

      const candidateText = content.slice(start, end)
      const normalizedCandidateText =
        normalizeFuzzyComparisonText(candidateText)
      if (normalizedCandidateText.length === 0) {
        continue
      }

      const lengthRatio =
        normalizedCandidateText.length / normalizedOldText.length
      if (
        !Number.isFinite(lengthRatio) ||
        lengthRatio < FUZZY_REPLACE_LENGTH_RATIO_MIN ||
        lengthRatio > FUZZY_REPLACE_LENGTH_RATIO_MAX
      ) {
        continue
      }

      const similarity = getBigramDiceSimilarity(
        normalizedOldText,
        normalizedCandidateText,
      )
      candidates.push({ start, end, similarity })
    }
  }

  if (candidates.length === 0) {
    return null
  }

  const sorted = candidates.sort((left, right) => {
    if (right.similarity !== left.similarity) {
      return right.similarity - left.similarity
    }
    return left.start - right.start
  })

  const best = sorted[0]
  if (!best || best.similarity < FUZZY_REPLACE_SIMILARITY_THRESHOLD) {
    return null
  }

  const aboveThreshold = sorted.filter(
    (item) => item.similarity >= FUZZY_REPLACE_SIMILARITY_THRESHOLD,
  )
  if (aboveThreshold.length !== 1) {
    return {
      candidate: best,
      secondBestSimilarity: sorted[1]?.similarity ?? 0,
      aboveThresholdCount: aboveThreshold.length,
    }
  }

  return {
    candidate: best,
    secondBestSimilarity: sorted[1]?.similarity ?? 0,
    aboveThresholdCount: aboveThreshold.length,
  }
}

const getFirstRegexMatchRange = (
  content: string,
  regex: RegExp,
): { start: number; end: number } | null => {
  regex.lastIndex = 0
  const match = regex.exec(content)
  if (!match || match.index < 0) {
    return null
  }
  return {
    start: match.index,
    end: match.index + match[0].length,
  }
}

const applyReplaceLikeOperation = ({
  content,
  oldText,
  newText,
  expectedOccurrences,
}: {
  content: string
  oldText: string
  newText: string
  expectedOccurrences?: number
}): ReplacementResult => {
  const normalizedExpected = normalizeExpectedOccurrences(expectedOccurrences)
  if (oldText.length === 0) {
    return {
      ok: false,
      error: 'oldText must not be empty.',
    }
  }

  const exactOccurrences = countOccurrences(content, oldText)
  const lineEndingOccurrences = countOccurrences(
    normalizeLineEndings(content),
    normalizeLineEndings(oldText),
  )
  const trimLineEndOccurrences = countOccurrences(
    normalizeLineEndingsAndTrimLineEnd(content),
    normalizeLineEndingsAndTrimLineEnd(oldText),
  )

  if (exactOccurrences === normalizedExpected) {
    const firstIndex = content.indexOf(oldText)
    const nextContent = content.split(oldText).join(newText)
    return {
      ok: true,
      nextContent,
      actualOccurrences: exactOccurrences,
      expectedOccurrences: normalizedExpected,
      matchMode: 'exact',
      changed: nextContent !== content,
      matchedRange: {
        start: firstIndex,
        end: firstIndex + oldText.length,
      },
      newRange: {
        start: firstIndex,
        end: firstIndex + newText.length,
      },
    }
  }

  const looseRegex = createLooseEditRegex(oldText)
  const looseOccurrences = countRegexMatches(content, looseRegex)
  if (looseOccurrences === normalizedExpected) {
    const matchedRange = getFirstRegexMatchRange(
      content,
      createLooseEditRegex(oldText),
    )
    if (!matchedRange) {
      return {
        ok: false,
        error: 'matched range could not be resolved.',
      }
    }
    const nextContent = content.replace(createLooseEditRegex(oldText), () => {
      return newText
    })
    return {
      ok: true,
      nextContent,
      actualOccurrences: looseOccurrences,
      expectedOccurrences: normalizedExpected,
      matchMode: 'lineEndingAndTrimLineEnd',
      changed: nextContent !== content,
      matchedRange,
      newRange: {
        start: matchedRange.start,
        end: matchedRange.start + newText.length,
      },
    }
  }

  const recoveredOldText = recoverLikelyEscapedBackslashSequences(oldText)
  const recoveredNewText = recoverLikelyEscapedBackslashSequences(newText)
  const hasRecoveredInputs =
    recoveredOldText !== oldText || recoveredNewText !== newText

  if (hasRecoveredInputs) {
    const recoveredExactOccurrences = countOccurrences(
      content,
      recoveredOldText,
    )
    if (recoveredExactOccurrences === normalizedExpected) {
      const firstIndex = content.indexOf(recoveredOldText)
      const nextContent = content.split(recoveredOldText).join(recoveredNewText)
      return {
        ok: true,
        nextContent,
        actualOccurrences: recoveredExactOccurrences,
        expectedOccurrences: normalizedExpected,
        matchMode: 'escapedControlRecovery',
        changed: nextContent !== content,
        matchedRange: {
          start: firstIndex,
          end: firstIndex + recoveredOldText.length,
        },
        newRange: {
          start: firstIndex,
          end: firstIndex + recoveredNewText.length,
        },
      }
    }

    const recoveredLooseRegex = createLooseEditRegex(recoveredOldText)
    const recoveredLooseOccurrences = countRegexMatches(
      content,
      recoveredLooseRegex,
    )
    if (recoveredLooseOccurrences === normalizedExpected) {
      const matchedRange = getFirstRegexMatchRange(content, recoveredLooseRegex)
      if (!matchedRange) {
        return {
          ok: false,
          error: 'matched range could not be resolved after escape recovery.',
        }
      }
      const nextContent = content.replace(recoveredLooseRegex, () => {
        return recoveredNewText
      })
      return {
        ok: true,
        nextContent,
        actualOccurrences: recoveredLooseOccurrences,
        expectedOccurrences: normalizedExpected,
        matchMode: 'escapedControlRecoveryLineEndingAndTrimLineEnd',
        changed: nextContent !== content,
        matchedRange,
        newRange: {
          start: matchedRange.start,
          end: matchedRange.start + recoveredNewText.length,
        },
      }
    }

    return {
      ok: false,
      error:
        `expectedOccurrences mismatch: expected ${normalizedExpected}, found ${exactOccurrences}. ` +
        `hints: lineEndingNormalized=${lineEndingOccurrences}, ` +
        `trimLineEndNormalized=${trimLineEndOccurrences}, ` +
        `recoveredExact=${recoveredExactOccurrences}, ` +
        `recoveredLineEndingAndTrimLineEnd=${recoveredLooseOccurrences}`,
    }
  }

  if (normalizedExpected === 1) {
    const fuzzyMatch = findFuzzyUniqueParagraphMatch({ content, oldText })
    if (fuzzyMatch && fuzzyMatch.aboveThresholdCount === 1) {
      const { candidate } = fuzzyMatch
      const nextContent =
        content.slice(0, candidate.start) +
        newText +
        content.slice(candidate.end)
      return {
        ok: true,
        nextContent,
        actualOccurrences: 1,
        expectedOccurrences: normalizedExpected,
        matchMode: 'fuzzyUniqueParagraph',
        changed: nextContent !== content,
        matchedRange: {
          start: candidate.start,
          end: candidate.end,
        },
        newRange: {
          start: candidate.start,
          end: candidate.start + newText.length,
        },
      }
    }

    if (fuzzyMatch && fuzzyMatch.aboveThresholdCount > 1) {
      return {
        ok: false,
        error:
          `expectedOccurrences mismatch: expected ${normalizedExpected}, found ${exactOccurrences}. ` +
          `hints: lineEndingNormalized=${lineEndingOccurrences}, ` +
          `trimLineEndNormalized=${trimLineEndOccurrences}, ` +
          `fuzzyThreshold=${FUZZY_REPLACE_SIMILARITY_THRESHOLD.toFixed(2)}, ` +
          `fuzzyTopScore=${fuzzyMatch.candidate.similarity.toFixed(3)}, ` +
          `fuzzySecondScore=${fuzzyMatch.secondBestSimilarity.toFixed(3)}, ` +
          `fuzzyCandidatesAboveThreshold=${fuzzyMatch.aboveThresholdCount}`,
      }
    }
  }

  return {
    ok: false,
    error:
      `expectedOccurrences mismatch: expected ${normalizedExpected}, found ${exactOccurrences}. ` +
      `hints: lineEndingNormalized=${lineEndingOccurrences}, ` +
      `trimLineEndNormalized=${trimLineEndOccurrences}`,
  }
}

export const materializeTextEditPlan = ({
  content,
  plan,
}: {
  content: string
  plan: TextEditPlan
}): MaterializedTextEditPlan => {
  let nextContent = content
  const errors: string[] = []
  let appliedCount = 0
  const operationResults: AppliedTextEditOperation[] = []

  for (let index = 0; index < plan.operations.length; index += 1) {
    const operation = plan.operations[index]

    if (operation.type === 'replace_lines') {
      const result = applyReplaceLinesOperation({
        content: nextContent,
        startLine: operation.startLine,
        endLine: operation.endLine,
        newText: operation.newText,
        type: 'replace_lines',
      })

      if (!result.ok) {
        errors.push(`Operation ${index + 1}: ${result.error}`)
        continue
      }

      nextContent = result.nextContent
      appliedCount += result.changed ? 1 : 0
      operationResults.push({
        operation,
        actualOccurrences: 1,
        expectedOccurrences: null,
        matchMode: result.matchMode,
        changed: result.changed,
        matchedRange: result.matchedRange,
        newRange: result.newRange,
      })
      continue
    }

    if (operation.type === 'append') {
      const appendContent = operation.content
      if (appendContent.length === 0) {
        operationResults.push({
          operation,
          actualOccurrences: 1,
          expectedOccurrences: null,
          matchMode: 'append',
          changed: false,
          matchedRange: undefined,
          newRange: undefined,
        })
        continue
      }
      const separator =
        nextContent.length === 0
          ? ''
          : nextContent.endsWith('\n')
            ? '\n'
            : '\n\n'
      nextContent = `${nextContent}${separator}${appendContent}`
      appliedCount += 1
      operationResults.push({
        operation,
        actualOccurrences: 1,
        expectedOccurrences: null,
        matchMode: 'append',
        changed: true,
        matchedRange: undefined,
        newRange: {
          start: nextContent.length - appendContent.length,
          end: nextContent.length,
        },
      })
      continue
    }

    const replaceOperation: ReplaceTextOperation =
      operation.type === 'insert_after'
        ? {
            type: 'replace',
            oldText: operation.anchor,
            newText: `${operation.anchor}\n${operation.content}`,
            expectedOccurrences: operation.expectedOccurrences,
          }
        : operation

    const result = applyReplaceLikeOperation({
      content: nextContent,
      oldText: replaceOperation.oldText,
      newText: replaceOperation.newText,
      expectedOccurrences: replaceOperation.expectedOccurrences,
    })

    if (!result.ok) {
      errors.push(`Operation ${index + 1}: ${result.error}`)
      continue
    }

    nextContent = result.nextContent
    appliedCount += result.changed ? 1 : 0
    operationResults.push({
      operation,
      actualOccurrences: result.actualOccurrences,
      expectedOccurrences: result.expectedOccurrences,
      matchMode: result.matchMode,
      changed: result.changed,
      matchedRange: result.matchedRange,
      newRange:
        operation.type === 'insert_after'
          ? {
              start: result.newRange.end - operation.content.length,
              end: result.newRange.end,
            }
          : result.newRange,
    })
  }

  return {
    newContent: nextContent,
    appliedCount,
    totalOperations: plan.operations.length,
    errors,
    operationResults,
  }
}
