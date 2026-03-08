export type TextEditMatchMode =
  | 'exact'
  | 'lineEndingAndTrimLineEnd'
  | 'escapedControlRecovery'
  | 'escapedControlRecoveryLineEndingAndTrimLineEnd'
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

export type AppendTextOperation = {
  type: 'append'
  content: string
}

export type TextEditOperation =
  | ReplaceTextOperation
  | InsertAfterTextOperation
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

const normalizeExpectedOccurrences = (value: number | undefined): number => {
  if (!value || !Number.isFinite(value)) {
    return 1
  }
  return Math.max(1, Math.floor(value))
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
            newText: `${operation.anchor}\n\n${operation.content}`,
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
