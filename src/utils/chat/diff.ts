import {
  AdvancedLinesDiffComputer,
  ILinesDiffComputerOptions,
  LineRangeMapping,
} from 'vscode-diff'

export type InlineDiffToken = {
  type: 'same' | 'add' | 'del'
  text: string
}

export type InlineDiffLine = {
  type: 'unchanged' | 'modified' | 'added' | 'removed'
  tokens: InlineDiffToken[]
}

export type DiffBlock =
  | {
      type: 'unchanged'
      value: string
    }
  | {
      type: 'modified'
      originalValue?: string
      modifiedValue?: string
      inlineLines: InlineDiffLine[]
    }

export function createDiffBlocks(
  currentMarkdown: string,
  incomingMarkdown: string,
): DiffBlock[] {
  const blocks: DiffBlock[] = []
  const safeCurrentMarkdown = currentMarkdown ?? ''
  const safeIncomingMarkdown = incomingMarkdown ?? ''

  const advOptions: ILinesDiffComputerOptions = {
    ignoreTrimWhitespace: false,
    computeMoves: true,
    maxComputationTimeMs: 0,
  }
  const advDiffComputer = new AdvancedLinesDiffComputer()

  const currentLines = safeCurrentMarkdown.split('\n')
  const incomingLines = safeIncomingMarkdown.split('\n')
  const advLineChanges = advDiffComputer.computeDiff(
    currentLines,
    incomingLines,
    advOptions,
  ).changes

  let lastOriginalEndLineNumberExclusive = 1 // 1-indexed
  advLineChanges.forEach((change: LineRangeMapping) => {
    const oStart = change.originalRange.startLineNumber
    const oEnd = change.originalRange.endLineNumberExclusive
    const mStart = change.modifiedRange.startLineNumber
    const mEnd = change.modifiedRange.endLineNumberExclusive

    // Emit unchanged blocks
    if (oStart > lastOriginalEndLineNumberExclusive) {
      const unchangedLines = currentLines.slice(
        lastOriginalEndLineNumberExclusive - 1,
        oStart - 1,
      )
      if (unchangedLines.length > 0) {
        blocks.push({
          type: 'unchanged',
          value: unchangedLines.join('\n'),
        })
      }
    }

    // Emit modified blocks
    const originalLines = currentLines.slice(oStart - 1, oEnd - 1)
    const modifiedLines = incomingLines.slice(mStart - 1, mEnd - 1)
    const originalValue = originalLines.join('\n')
    const modifiedValue = modifiedLines.join('\n')
    if (originalLines.length > 0 || modifiedLines.length > 0) {
      blocks.push({
        type: 'modified',
        originalValue: originalLines.length > 0 ? originalValue : undefined,
        modifiedValue: modifiedLines.length > 0 ? modifiedValue : undefined,
        inlineLines: createInlineDiffLines(originalLines, modifiedLines),
      })
    }

    lastOriginalEndLineNumberExclusive = oEnd
  })

  // Emit final unchanged blocks (if any)
  if (currentLines.length > lastOriginalEndLineNumberExclusive - 1) {
    const unchangedLines = currentLines.slice(
      lastOriginalEndLineNumberExclusive - 1,
    )
    if (unchangedLines.length > 0) {
      blocks.push({
        type: 'unchanged',
        value: unchangedLines.join('\n'),
      })
    }
  }

  return blocks
}

function createInlineDiffLines(
  originalLines: string[],
  modifiedLines: string[],
): InlineDiffLine[] {
  if (originalLines.length === 0 && modifiedLines.length === 0) {
    return []
  }

  if (originalLines.length === 0) {
    return modifiedLines.map((line) => ({
      type: 'added',
      tokens: [{ type: 'add', text: line }],
    }))
  }

  if (modifiedLines.length === 0) {
    return originalLines.map((line) => ({
      type: 'removed',
      tokens: [{ type: 'del', text: line }],
    }))
  }

  const advOptions: ILinesDiffComputerOptions = {
    ignoreTrimWhitespace: false,
    computeMoves: false,
    maxComputationTimeMs: 0,
  }
  const advDiffComputer = new AdvancedLinesDiffComputer()
  const advLineChanges = advDiffComputer.computeDiff(
    originalLines,
    modifiedLines,
    advOptions,
  ).changes

  const inlineLines: InlineDiffLine[] = []
  let lastOriginalEndLineNumberExclusive = 1
  let lastModifiedEndLineNumberExclusive = 1

  advLineChanges.forEach((change: LineRangeMapping) => {
    const oStart = change.originalRange.startLineNumber
    const oEnd = change.originalRange.endLineNumberExclusive
    const mStart = change.modifiedRange.startLineNumber
    const mEnd = change.modifiedRange.endLineNumberExclusive

    if (oStart > lastOriginalEndLineNumberExclusive) {
      const unchanged = originalLines.slice(
        lastOriginalEndLineNumberExclusive - 1,
        oStart - 1,
      )
      unchanged.forEach((line) => {
        inlineLines.push({
          type: 'unchanged',
          tokens: [{ type: 'same', text: line }],
        })
      })
    }

    const originalChunk = originalLines.slice(oStart - 1, oEnd - 1)
    const modifiedChunk = modifiedLines.slice(mStart - 1, mEnd - 1)
    const chunkLength = Math.max(originalChunk.length, modifiedChunk.length)

    for (let i = 0; i < chunkLength; i += 1) {
      const originalLine = originalChunk[i]
      const modifiedLine = modifiedChunk[i]

      if (originalLine !== undefined && modifiedLine !== undefined) {
        inlineLines.push({
          type: 'modified',
          tokens: createInlineDiffTokens(originalLine, modifiedLine),
        })
      } else if (originalLine !== undefined) {
        inlineLines.push({
          type: 'removed',
          tokens: [{ type: 'del', text: originalLine }],
        })
      } else if (modifiedLine !== undefined) {
        inlineLines.push({
          type: 'added',
          tokens: [{ type: 'add', text: modifiedLine }],
        })
      }
    }

    lastOriginalEndLineNumberExclusive = oEnd
    lastModifiedEndLineNumberExclusive = mEnd
  })

  if (originalLines.length > lastOriginalEndLineNumberExclusive - 1) {
    const unchanged = originalLines.slice(
      lastOriginalEndLineNumberExclusive - 1,
    )
    unchanged.forEach((line) => {
      inlineLines.push({
        type: 'unchanged',
        tokens: [{ type: 'same', text: line }],
      })
    })
  }

  if (modifiedLines.length > lastModifiedEndLineNumberExclusive - 1) {
    const added = modifiedLines.slice(lastModifiedEndLineNumberExclusive - 1)
    added.forEach((line) => {
      inlineLines.push({
        type: 'added',
        tokens: [{ type: 'add', text: line }],
      })
    })
  }

  return inlineLines
}

function createInlineDiffTokens(
  originalLine: string,
  modifiedLine: string,
): InlineDiffToken[] {
  if (originalLine === modifiedLine) {
    return [{ type: 'same', text: originalLine }]
  }

  const originalTokens = splitLineTokens(originalLine)
  const modifiedTokens = splitLineTokens(modifiedLine)

  const dp: number[][] = Array.from({ length: originalTokens.length + 1 }, () =>
    new Array(modifiedTokens.length + 1).fill(0),
  )

  for (let i = 1; i <= originalTokens.length; i += 1) {
    for (let j = 1; j <= modifiedTokens.length; j += 1) {
      if (originalTokens[i - 1] === modifiedTokens[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  const reversed: InlineDiffToken[] = []
  let i = originalTokens.length
  let j = modifiedTokens.length

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && originalTokens[i - 1] === modifiedTokens[j - 1]) {
      reversed.push({ type: 'same', text: originalTokens[i - 1] })
      i -= 1
      j -= 1
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      reversed.push({ type: 'add', text: modifiedTokens[j - 1] })
      j -= 1
    } else if (i > 0) {
      reversed.push({ type: 'del', text: originalTokens[i - 1] })
      i -= 1
    }
  }

  const merged: InlineDiffToken[] = []
  for (let k = reversed.length - 1; k >= 0; k -= 1) {
    const token = reversed[k]
    const last = merged[merged.length - 1]
    if (last && last.type === token.type) {
      last.text += token.text
    } else {
      merged.push({ ...token })
    }
  }

  return merged
}

function splitLineTokens(line: string): string[] {
  return line.split(/(\s+)/).filter((token) => token.length > 0)
}
