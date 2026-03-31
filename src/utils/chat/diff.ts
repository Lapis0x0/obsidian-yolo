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

export type MarkdownBlockType =
  | 'blank'
  | 'paragraph'
  | 'heading'
  | 'section'
  | 'thematicBreak'
  | 'table'
  | 'codeFence'
  | 'mathBlock'
  | 'blockquote'
  | 'list'

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
      presentation: 'inline' | 'block'
      blockType: MarkdownBlockType
    }

type MarkdownBlockUnit = {
  type: MarkdownBlockType
  text: string
  normalizedText: string
  presentation: 'inline' | 'block'
}

type SegmenterConstructor = new (
  locale?: string | string[],
  options?: { granularity?: 'grapheme' | 'word' | 'sentence' },
) => {
  segment(input: string): Iterable<{ segment: string }>
}

export function createDiffBlocks(
  currentMarkdown: string,
  incomingMarkdown: string,
): DiffBlock[] {
  const safeCurrentMarkdown = currentMarkdown ?? ''
  const safeIncomingMarkdown = incomingMarkdown ?? ''
  const currentBlocks = segmentMarkdownBlocks(safeCurrentMarkdown)
  const incomingBlocks = segmentMarkdownBlocks(safeIncomingMarkdown)
  const blocks: DiffBlock[] = []

  const advOptions: ILinesDiffComputerOptions = {
    ignoreTrimWhitespace: false,
    computeMoves: true,
    maxComputationTimeMs: 0,
  }
  const advDiffComputer = new AdvancedLinesDiffComputer()
  const advLineChanges = advDiffComputer.computeDiff(
    currentBlocks.map(createComparisonKey),
    incomingBlocks.map(createComparisonKey),
    advOptions,
  ).changes

  let lastOriginalEndLineNumberExclusive = 1
  advLineChanges.forEach((change: LineRangeMapping) => {
    const oStart = change.originalRange.startLineNumber
    const oEnd = change.originalRange.endLineNumberExclusive
    const mStart = change.modifiedRange.startLineNumber
    const mEnd = change.modifiedRange.endLineNumberExclusive

    if (oStart > lastOriginalEndLineNumberExclusive) {
      const unchangedBlocks = currentBlocks.slice(
        lastOriginalEndLineNumberExclusive - 1,
        oStart - 1,
      )
      pushUnchangedBlock(blocks, unchangedBlocks)
    }

    const originalChunk = currentBlocks.slice(oStart - 1, oEnd - 1)
    const modifiedChunk = incomingBlocks.slice(mStart - 1, mEnd - 1)
    blocks.push(...alignModifiedChunks(originalChunk, modifiedChunk))

    lastOriginalEndLineNumberExclusive = oEnd
  })

  if (currentBlocks.length > lastOriginalEndLineNumberExclusive - 1) {
    pushUnchangedBlock(
      blocks,
      currentBlocks.slice(lastOriginalEndLineNumberExclusive - 1),
    )
  }

  return mergeAdjacentUnchangedBlocks(blocks)
}

export function createLineDiffBlocks(
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

  let lastOriginalEndLineNumberExclusive = 1
  advLineChanges.forEach((change: LineRangeMapping) => {
    const oStart = change.originalRange.startLineNumber
    const oEnd = change.originalRange.endLineNumberExclusive
    const mStart = change.modifiedRange.startLineNumber
    const mEnd = change.modifiedRange.endLineNumberExclusive

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
        presentation: 'inline',
        blockType: 'paragraph',
      })
    }

    lastOriginalEndLineNumberExclusive = oEnd
  })

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

function pushUnchangedBlock(
  blocks: DiffBlock[],
  units: MarkdownBlockUnit[],
): void {
  if (units.length === 0) return
  blocks.push({
    type: 'unchanged',
    value: joinBlockTexts(units),
  })
}

function createModifiedDiffBlock(
  originalBlock?: MarkdownBlockUnit,
  modifiedBlock?: MarkdownBlockUnit,
): Extract<DiffBlock, { type: 'modified' }> | null {
  if (!originalBlock && !modifiedBlock) return null

  const blockType =
    modifiedBlock && shouldRenderAsBlock(modifiedBlock.type)
      ? modifiedBlock.type
      : (originalBlock?.type ?? modifiedBlock?.type ?? 'paragraph')
  const presentation =
    (originalBlock && shouldRenderAsBlock(originalBlock.type)) ||
    (modifiedBlock && shouldRenderAsBlock(modifiedBlock.type))
      ? 'block'
      : 'inline'
  const originalValue = originalBlock?.text
  const modifiedValue = modifiedBlock?.text

  return {
    type: 'modified',
    originalValue,
    modifiedValue,
    inlineLines:
      presentation === 'inline'
        ? createInlineDiffLines(
            originalValue?.split('\n') ?? [],
            modifiedValue?.split('\n') ?? [],
          )
        : [],
    presentation,
    blockType,
  }
}

function alignModifiedChunks(
  originalChunk: MarkdownBlockUnit[],
  modifiedChunk: MarkdownBlockUnit[],
): DiffBlock[] {
  const originalLength = originalChunk.length
  const modifiedLength = modifiedChunk.length

  if (originalLength === 0 && modifiedLength === 0) {
    return []
  }

  const dp: number[][] = Array.from({ length: originalLength + 1 }, () =>
    new Array(modifiedLength + 1).fill(0),
  )

  for (let i = 1; i <= originalLength; i += 1) {
    dp[i][0] = i
  }

  for (let j = 1; j <= modifiedLength; j += 1) {
    dp[0][j] = j
  }

  for (let i = 1; i <= originalLength; i += 1) {
    for (let j = 1; j <= modifiedLength; j += 1) {
      const substitutionCost = getBlockSubstitutionCost(
        originalChunk[i - 1],
        modifiedChunk[j - 1],
      )
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + substitutionCost,
      )
    }
  }

  const alignedPairs: Array<
    [MarkdownBlockUnit | undefined, MarkdownBlockUnit | undefined]
  > = []
  let i = originalLength
  let j = modifiedLength

  while (i > 0 || j > 0) {
    if (
      i > 0 &&
      j > 0 &&
      almostEqual(
        dp[i][j],
        dp[i - 1][j - 1] +
          getBlockSubstitutionCost(originalChunk[i - 1], modifiedChunk[j - 1]),
      )
    ) {
      alignedPairs.push([originalChunk[i - 1], modifiedChunk[j - 1]])
      i -= 1
      j -= 1
      continue
    }

    if (i > 0 && almostEqual(dp[i][j], dp[i - 1][j] + 1)) {
      alignedPairs.push([originalChunk[i - 1], undefined])
      i -= 1
      continue
    }

    if (j > 0) {
      alignedPairs.push([undefined, modifiedChunk[j - 1]])
      j -= 1
    }
  }

  const result: DiffBlock[] = []
  for (let index = alignedPairs.length - 1; index >= 0; index -= 1) {
    const [originalBlock, modifiedBlock] = alignedPairs[index]
    if (
      originalBlock &&
      modifiedBlock &&
      createComparisonKey(originalBlock) === createComparisonKey(modifiedBlock)
    ) {
      result.push({
        type: 'unchanged',
        value: originalBlock.text,
      })
      continue
    }

    const diffBlock = createModifiedDiffBlock(originalBlock, modifiedBlock)
    if (diffBlock) {
      result.push(diffBlock)
    }
  }

  return result
}

function getBlockSubstitutionCost(
  originalBlock: MarkdownBlockUnit,
  modifiedBlock: MarkdownBlockUnit,
): number {
  if (
    createComparisonKey(originalBlock) === createComparisonKey(modifiedBlock)
  ) {
    return 0
  }

  const sameType = originalBlock.type === modifiedBlock.type
  const similarity = getBlockTextSimilarity(
    originalBlock.normalizedText,
    modifiedBlock.normalizedText,
  )

  if (sameType) {
    return Math.max(0.2, 0.9 - similarity * 0.75)
  }

  if (
    shouldRenderAsBlock(originalBlock.type) !==
    shouldRenderAsBlock(modifiedBlock.type)
  ) {
    return 1.6
  }

  return Math.max(1.05, 1.35 - similarity * 0.2)
}

function getBlockTextSimilarity(
  originalText: string,
  modifiedText: string,
): number {
  if (originalText === modifiedText) return 1
  if (originalText.length === 0 || modifiedText.length === 0) return 0

  const originalTokens = new Set(tokenizeNormalizedText(originalText))
  const modifiedTokens = new Set(tokenizeNormalizedText(modifiedText))
  if (originalTokens.size === 0 || modifiedTokens.size === 0) {
    return 0
  }

  let overlap = 0
  originalTokens.forEach((token) => {
    if (modifiedTokens.has(token)) {
      overlap += 1
    }
  })

  return (2 * overlap) / (originalTokens.size + modifiedTokens.size)
}

function tokenizeNormalizedText(text: string): string[] {
  return text.split(/\s+/).filter((token) => token.length > 0)
}

function almostEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.0001
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

function createComparisonKey(block: MarkdownBlockUnit): string {
  return `${block.type}\u0000${block.normalizedText}`
}

function joinBlockTexts(blocks: MarkdownBlockUnit[]): string {
  return blocks.map((block) => block.text).join('\n')
}

function shouldRenderAsBlock(blockType: MarkdownBlockType): boolean {
  return (
    blockType === 'section' ||
    blockType === 'table' ||
    blockType === 'codeFence' ||
    blockType === 'mathBlock' ||
    blockType === 'blockquote' ||
    blockType === 'list'
  )
}

function segmentMarkdownBlocks(markdown: string): MarkdownBlockUnit[] {
  const lines = markdown.split('\n')
  const blocks: MarkdownBlockUnit[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (line === undefined) break

    if (line.trim().length === 0) {
      blocks.push(createBlockUnit('blank', line))
      index += 1
      continue
    }

    const fencedCode = readFencedCodeBlock(lines, index)
    if (fencedCode) {
      blocks.push(createBlockUnit('codeFence', fencedCode.lines.join('\n')))
      index = fencedCode.nextIndex
      continue
    }

    const mathBlock = readMathBlock(lines, index)
    if (mathBlock) {
      blocks.push(createBlockUnit('mathBlock', mathBlock.lines.join('\n')))
      index = mathBlock.nextIndex
      continue
    }

    const table = readTable(lines, index)
    if (table) {
      blocks.push(createBlockUnit('table', table.lines.join('\n')))
      index = table.nextIndex
      continue
    }

    if (isHeadingLine(line)) {
      blocks.push(createBlockUnit('heading', line))
      index += 1
      continue
    }

    if (isThematicBreakLine(line)) {
      blocks.push(createBlockUnit('thematicBreak', line))
      index += 1
      continue
    }

    const blockquote = readBlockquote(lines, index)
    if (blockquote) {
      blocks.push(createBlockUnit('blockquote', blockquote.lines.join('\n')))
      index = blockquote.nextIndex
      continue
    }

    const list = readList(lines, index)
    if (list) {
      splitListItems(list.lines).forEach((itemLines) => {
        blocks.push(createBlockUnit('list', itemLines.join('\n')))
      })
      index = list.nextIndex
      continue
    }

    const paragraph = readParagraph(lines, index)
    paragraph.lines.forEach((paragraphLine) => {
      blocks.push(createBlockUnit('paragraph', paragraphLine))
    })
    index = paragraph.nextIndex
  }

  return blocks
}

function createBlockUnit(
  type: MarkdownBlockType,
  text: string,
): MarkdownBlockUnit {
  return {
    type,
    text,
    normalizedText: normalizeBlockText(type, text),
    presentation: shouldRenderAsBlock(type) ? 'block' : 'inline',
  }
}

function normalizeBlockText(type: MarkdownBlockType, text: string): string {
  if (type === 'blank') {
    return text
  }

  if (type === 'paragraph' || type === 'heading' || type === 'section') {
    return text.replace(/\s+/g, ' ').trim()
  }

  return text.trim()
}

function readFencedCodeBlock(
  lines: string[],
  startIndex: number,
): { lines: string[]; nextIndex: number } | null {
  const firstLine = lines[startIndex]
  if (!firstLine) return null
  const match = firstLine.match(/^\s{0,3}(`{3,}|~{3,})/)
  if (!match) return null

  const fence = match[1]
  const fenceChar = fence[0]
  const result = [firstLine]
  let index = startIndex + 1

  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined) break
    result.push(line)
    if (
      new RegExp(
        `^\\s{0,3}${escapeRegExp(fenceChar)}{${fence.length},}\\s*$`,
      ).test(line)
    ) {
      return {
        lines: result,
        nextIndex: index + 1,
      }
    }
    index += 1
  }

  return {
    lines: result,
    nextIndex: lines.length,
  }
}

function readMathBlock(
  lines: string[],
  startIndex: number,
): { lines: string[]; nextIndex: number } | null {
  const firstLine = lines[startIndex]
  if (!firstLine || !/^\s*\$\$\s*$/.test(firstLine)) return null

  const result = [firstLine]
  let index = startIndex + 1
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined) break
    result.push(line)
    if (/^\s*\$\$\s*$/.test(line)) {
      return {
        lines: result,
        nextIndex: index + 1,
      }
    }
    index += 1
  }

  return {
    lines: result,
    nextIndex: lines.length,
  }
}

function readTable(
  lines: string[],
  startIndex: number,
): { lines: string[]; nextIndex: number } | null {
  const header = lines[startIndex]
  const separator = lines[startIndex + 1]
  if (!header || !separator) return null
  if (!looksLikeTableRow(header) || !looksLikeTableSeparator(separator)) {
    return null
  }

  const result = [header, separator]
  let index = startIndex + 2
  while (index < lines.length) {
    const line = lines[index]
    if (!line || line.trim().length === 0 || !looksLikeTableRow(line)) {
      break
    }
    result.push(line)
    index += 1
  }

  return {
    lines: result,
    nextIndex: index,
  }
}

function readBlockquote(
  lines: string[],
  startIndex: number,
): { lines: string[]; nextIndex: number } | null {
  if (!isBlockquoteLine(lines[startIndex])) return null

  const result: string[] = []
  let index = startIndex
  while (index < lines.length) {
    const line = lines[index]
    if (!line || line.trim().length === 0 || !isBlockquoteLine(line)) {
      break
    }
    result.push(line)
    index += 1
  }

  return {
    lines: result,
    nextIndex: index,
  }
}

function readList(
  lines: string[],
  startIndex: number,
): { lines: string[]; nextIndex: number } | null {
  if (!isListItemLine(lines[startIndex])) return null

  const result: string[] = []
  let index = startIndex
  while (index < lines.length) {
    const line = lines[index]
    if (!line || line.trim().length === 0) {
      break
    }
    if (
      result.length > 0 &&
      !isListItemLine(line) &&
      !isIndentedContinuationLine(line)
    ) {
      break
    }
    result.push(line)
    index += 1
  }

  return {
    lines: result,
    nextIndex: index,
  }
}

function splitListItems(lines: string[]): string[][] {
  if (lines.length === 0) {
    return []
  }

  const items: string[][] = []
  let currentItem: string[] = []
  let rootIndent: number | null = null

  const pushCurrentItem = () => {
    if (currentItem.length === 0) return
    items.push(currentItem)
    currentItem = []
  }

  lines.forEach((line) => {
    const indent = getLineIndent(line)
    if (isListItemLine(line)) {
      if (rootIndent === null) {
        rootIndent = indent
      }

      if (indent <= rootIndent && currentItem.length > 0) {
        pushCurrentItem()
      }
    }

    currentItem.push(line)
  })

  pushCurrentItem()

  return items
}

function readParagraph(
  lines: string[],
  startIndex: number,
): { lines: string[]; nextIndex: number } {
  const result: string[] = []
  let index = startIndex
  while (index < lines.length) {
    const line = lines[index]
    if (
      !line ||
      line.trim().length === 0 ||
      isStandaloneBlockStart(lines, index)
    ) {
      break
    }
    result.push(line)
    index += 1
  }

  return {
    lines: result,
    nextIndex: index,
  }
}

function isStandaloneBlockStart(lines: string[], index: number): boolean {
  const line = lines[index]
  if (!line) return false

  return (
    !!readFencedCodeBlock(lines, index) ||
    !!readMathBlock(lines, index) ||
    !!readTable(lines, index) ||
    isHeadingLine(line) ||
    isThematicBreakLine(line) ||
    isBlockquoteLine(line) ||
    isListItemLine(line)
  )
}

function isHeadingLine(line?: string): boolean {
  if (!line) return false
  return /^\s{0,3}#{1,6}\s+/.test(line)
}

function isThematicBreakLine(line?: string): boolean {
  if (!line) return false
  return /^\s{0,3}(?:\*\s*){3,}$|^\s{0,3}(?:-\s*){3,}$|^\s{0,3}(?:_\s*){3,}$/.test(
    line,
  )
}

function isBlockquoteLine(line?: string): boolean {
  if (!line) return false
  return /^\s{0,3}>/.test(line)
}

function isListItemLine(line?: string): boolean {
  if (!line) return false
  return /^\s{0,3}(?:[-+*]|\d+[.)])\s+/.test(line)
}

function isIndentedContinuationLine(line?: string): boolean {
  if (!line) return false
  return /^\s{2,}\S/.test(line)
}

function getLineIndent(line: string): number {
  const match = line.match(/^\s*/)
  return match?.[0].length ?? 0
}

function looksLikeTableRow(line?: string): boolean {
  if (!line) return false
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return false
  return trimmed.split('|').length >= 3
}

function looksLikeTableSeparator(line?: string): boolean {
  if (!line) return false
  const normalized = line.trim()
  if (!normalized.includes('-')) return false
  const cells = normalized.replace(/^\|/, '').replace(/\|$/, '').split('|')
  if (cells.length < 2) return false
  return cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function createInlineDiffLines(
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

  const hasCjkContent = hasMeaningfulCjkContent(
    `${originalLine}${modifiedLine}`,
  )
  const sentencePriorityTokens = createSentencePriorityDiffTokens(
    originalLine,
    modifiedLine,
  )
  if (sentencePriorityTokens && !hasCjkContent) {
    return sentencePriorityTokens
  }

  return createEditorPreferredInlineDiffTokens(originalLine, modifiedLine)
}

function createEditorPreferredInlineDiffTokens(
  originalLine: string,
  modifiedLine: string,
): InlineDiffToken[] {
  const hasCjkContent = hasMeaningfulCjkContent(
    `${originalLine}${modifiedLine}`,
  )

  if (hasCjkContent && !isCrossScriptRewrite(originalLine, modifiedLine)) {
    const originalSegmenterTokens = splitLineWithIntlSegmenter(originalLine)
    const modifiedSegmenterTokens = splitLineWithIntlSegmenter(modifiedLine)
    const hasUsableSegmenterTokens =
      originalSegmenterTokens.length > 1 && modifiedSegmenterTokens.length > 1

    if (hasUsableSegmenterTokens) {
      const segmenterTokens = createInlineDiffTokensFromUnits(
        originalSegmenterTokens,
        modifiedSegmenterTokens,
      )

      if (
        !shouldPreferWholeLineReplacement(
          originalLine,
          modifiedLine,
          segmenterTokens,
        )
      ) {
        return postProcessInlineDiffTokens(segmenterTokens, hasCjkContent)
      }
    }

    const characterLevelTokens = createCharacterLevelInlineDiffTokens(
      originalLine,
      modifiedLine,
    )

    if (
      !shouldPreferWholeLineReplacement(
        originalLine,
        modifiedLine,
        characterLevelTokens,
      )
    ) {
      return postProcessInlineDiffTokens(characterLevelTokens, hasCjkContent)
    }
  }

  const wordLevelTokens = createWordLevelInlineDiffTokens(
    originalLine,
    modifiedLine,
  )

  if (
    shouldPreferWholeLineReplacement(
      originalLine,
      modifiedLine,
      wordLevelTokens,
    )
  ) {
    return buildWholeLineReplacementTokens(originalLine, modifiedLine)
  }

  if (
    !hasCjkContent &&
    shouldPreferCharacterLevelInlineDiff(originalLine, modifiedLine)
  ) {
    const characterLevelTokens = createCharacterLevelInlineDiffTokens(
      originalLine,
      modifiedLine,
    )

    if (
      !shouldPreferWholeLineReplacement(
        originalLine,
        modifiedLine,
        characterLevelTokens,
      )
    ) {
      return postProcessInlineDiffTokens(characterLevelTokens, hasCjkContent)
    }
  }

  return postProcessInlineDiffTokens(wordLevelTokens, hasCjkContent)
}

function createSentencePriorityDiffTokens(
  originalLine: string,
  modifiedLine: string,
): InlineDiffToken[] | null {
  const originalSegments = splitLineIntoSentenceSegments(originalLine)
  const modifiedSegments = splitLineIntoSentenceSegments(modifiedLine)

  if (originalSegments.length <= 1 && modifiedSegments.length <= 1) {
    return null
  }

  const operations = diffSequence(
    originalSegments,
    modifiedSegments,
    (left, right) => left === right,
  )
  const tokens: InlineDiffToken[] = []
  let originalBuffer: string[] = []
  let modifiedBuffer: string[] = []

  const flushChangedBuffer = () => {
    if (originalBuffer.length === 0 && modifiedBuffer.length === 0) {
      return
    }

    if (originalBuffer.length === 1 && modifiedBuffer.length === 1) {
      tokens.push(
        ...createWordLevelInlineDiffTokens(
          originalBuffer[0],
          modifiedBuffer[0],
        ),
      )
    } else {
      const originalText = originalBuffer.join('')
      const modifiedText = modifiedBuffer.join('')

      if (originalText.length > 0) {
        tokens.push({ type: 'del', text: originalText })
      }

      if (modifiedText.length > 0) {
        tokens.push({ type: 'add', text: modifiedText })
      }
    }

    originalBuffer = []
    modifiedBuffer = []
  }

  operations.forEach((operation) => {
    if (operation.type === 'same') {
      flushChangedBuffer()
      tokens.push({ type: 'same', text: operation.value })
      return
    }

    if (operation.type === 'del') {
      originalBuffer.push(operation.value)
      return
    }

    modifiedBuffer.push(operation.value)
  })

  flushChangedBuffer()

  return mergeAdjacentInlineTokens(tokens)
}

function createWordLevelInlineDiffTokens(
  originalLine: string,
  modifiedLine: string,
): InlineDiffToken[] {
  if (originalLine === modifiedLine) {
    return [{ type: 'same', text: originalLine }]
  }

  return createInlineDiffTokensFromUnits(
    splitLineTokens(originalLine),
    splitLineTokens(modifiedLine),
  )
}

function splitLineTokens(line: string): string[] {
  if (hasMeaningfulCjkContent(line)) {
    const segmenterTokens = splitLineWithIntlSegmenter(line)
    if (segmenterTokens.length > 1) {
      return segmenterTokens
    }
  }

  return line.split(/(\s+)/).filter((token) => token.length > 0)
}

function splitLineWithIntlSegmenter(line: string): string[] {
  const segmenterApi = Intl as typeof Intl & {
    Segmenter?: SegmenterConstructor
  }
  const Segmenter = segmenterApi.Segmenter
  if (!Segmenter) {
    return []
  }

  try {
    const segmenter = new Segmenter('zh-CN', { granularity: 'word' })
    return Array.from(
      segmenter.segment(line),
      (segment) => segment.segment,
    ).filter((token) => token.length > 0)
  } catch {
    return []
  }
}

function createCharacterLevelInlineDiffTokens(
  originalLine: string,
  modifiedLine: string,
): InlineDiffToken[] {
  return createInlineDiffTokensFromUnits(
    Array.from(originalLine),
    Array.from(modifiedLine),
  )
}

function createInlineDiffTokensFromUnits(
  originalUnits: string[],
  modifiedUnits: string[],
): InlineDiffToken[] {
  const operations = diffSequence(
    originalUnits,
    modifiedUnits,
    (left, right) => left === right,
  )

  return mergeAdjacentInlineTokens(
    operations.map((operation) => {
      if (operation.type === 'same') {
        return { type: 'same', text: operation.value }
      }
      if (operation.type === 'del') {
        return { type: 'del', text: operation.value }
      }
      return { type: 'add', text: operation.value }
    }),
  )
}

function diffSequence<T>(
  originalItems: T[],
  modifiedItems: T[],
  isEqual: (left: T, right: T) => boolean,
): Array<{ type: 'same' | 'add' | 'del'; value: T }> {
  const dp: number[][] = Array.from({ length: originalItems.length + 1 }, () =>
    new Array(modifiedItems.length + 1).fill(0),
  )

  for (let i = 1; i <= originalItems.length; i += 1) {
    for (let j = 1; j <= modifiedItems.length; j += 1) {
      if (isEqual(originalItems[i - 1], modifiedItems[j - 1])) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  const reversed: Array<{ type: 'same' | 'add' | 'del'; value: T }> = []
  let i = originalItems.length
  let j = modifiedItems.length

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && isEqual(originalItems[i - 1], modifiedItems[j - 1])) {
      reversed.push({ type: 'same', value: originalItems[i - 1] })
      i -= 1
      j -= 1
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      reversed.push({ type: 'add', value: modifiedItems[j - 1] })
      j -= 1
    } else if (i > 0) {
      reversed.push({ type: 'del', value: originalItems[i - 1] })
      i -= 1
    }
  }

  return reversed.reverse()
}

function splitLineIntoSentenceSegments(line: string): string[] {
  if (line.length === 0) {
    return []
  }

  const segments: string[] = []
  let current = ''

  const pushCurrent = () => {
    if (current.length === 0) return
    segments.push(current)
    current = ''
  }

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    current += char

    if (!isSentenceBoundaryChar(char)) {
      continue
    }

    let cursor = index + 1
    while (cursor < line.length && /\s/u.test(line[cursor])) {
      current += line[cursor]
      cursor += 1
    }

    pushCurrent()
    index = cursor - 1
  }

  pushCurrent()

  return segments.filter((segment) => segment.length > 0)
}

function isSentenceBoundaryChar(char: string): boolean {
  return /[.!?;:。！？；：]/u.test(char)
}

function mergeAdjacentInlineTokens(
  tokens: InlineDiffToken[],
): InlineDiffToken[] {
  const merged: InlineDiffToken[] = []

  tokens.forEach((token) => {
    if (token.text.length === 0) {
      return
    }

    const last = merged[merged.length - 1]
    if (last && last.type === token.type) {
      last.text += token.text
      return
    }

    merged.push({ ...token })
  })

  return merged
}

function postProcessInlineDiffTokens(
  tokens: InlineDiffToken[],
  hasCjkContent: boolean,
): InlineDiffToken[] {
  const mergedTokens = mergeAdjacentInlineTokens(tokens)

  if (!hasCjkContent) {
    return mergedTokens
  }

  return normalizeStandalonePunctuationTokens(
    mergedTokens.flatMap((token) =>
      splitLongChangedTokenByCjkPunctuation(token),
    ),
  )
}

function splitLongChangedTokenByCjkPunctuation(
  token: InlineDiffToken,
): InlineDiffToken[] {
  if (token.type === 'same') {
    return [token]
  }

  const compactLength = token.text.replace(/\s+/g, '').length
  if (compactLength < 18 || !hasMeaningfulCjkContent(token.text)) {
    return [token]
  }

  const segments = splitCjkChangeSegments(token.text)
  if (segments.length <= 1) {
    return [token]
  }

  return segments.map((segment) => ({
    type: token.type,
    text: segment,
  }))
}

function splitCjkChangeSegments(text: string): string[] {
  const rawParts = text.split(/([，、；：。！？])/u)
  const segments: string[] = []

  for (let index = 0; index < rawParts.length; index += 1) {
    const part = rawParts[index]
    if (!part) continue

    if (/^[，、；：。！？]$/u.test(part)) {
      if (segments.length > 0) {
        segments[segments.length - 1] += part
      } else {
        segments.push(part)
      }
      continue
    }

    const nextPart = rawParts[index + 1]
    if (nextPart && /^[，、；：。！？]$/u.test(nextPart)) {
      segments.push(`${part}${nextPart}`)
      index += 1
      continue
    }

    segments.push(part)
  }

  return segments.filter((segment) => segment.length > 0)
}

function normalizeStandalonePunctuationTokens(
  tokens: InlineDiffToken[],
): InlineDiffToken[] {
  const normalized: InlineDiffToken[] = []

  tokens.forEach((token) => {
    if (!isStandaloneCjkPunctuationToken(token.text)) {
      normalized.push({ ...token })
      return
    }

    const last = normalized[normalized.length - 1]
    if (last && last.type === token.type) {
      last.text += token.text
      return
    }

    normalized.push({ ...token })
  })

  for (let index = 0; index < normalized.length - 1; index += 1) {
    const current = normalized[index]
    const next = normalized[index + 1]
    if (
      current &&
      next &&
      isStandaloneCjkPunctuationToken(current.text) &&
      current.type === next.type
    ) {
      next.text = `${current.text}${next.text}`
      normalized.splice(index, 1)
      index -= 1
    }
  }

  return normalized
}

function isStandaloneCjkPunctuationToken(text: string): boolean {
  return /^[，、；：。！？]+$/u.test(text)
}

function shouldPreferCharacterLevelInlineDiff(
  originalLine: string,
  modifiedLine: string,
): boolean {
  if (isCrossScriptRewrite(originalLine, modifiedLine)) {
    return false
  }

  const combined = `${originalLine}${modifiedLine}`
  if (!hasMeaningfulCjkContent(combined)) {
    return false
  }

  const segmenterTokens = splitLineWithIntlSegmenter(originalLine)
  const segmenterTokensModified = splitLineWithIntlSegmenter(modifiedLine)
  const hasUsefulSegmentation =
    segmenterTokens.length >= 3 && segmenterTokensModified.length >= 3

  if (!hasUsefulSegmentation) {
    return true
  }

  const compactOriginalLength = originalLine.replace(/\s+/g, '').length
  const compactModifiedLength = modifiedLine.replace(/\s+/g, '').length
  const maxCompactLength = Math.max(
    compactOriginalLength,
    compactModifiedLength,
  )

  return maxCompactLength <= 120
}

function shouldPreferWholeLineReplacement(
  originalLine: string,
  modifiedLine: string,
  tokens: InlineDiffToken[],
): boolean {
  const normalizedOriginal = normalizeInlineComparisonText(originalLine)
  const normalizedModified = normalizeInlineComparisonText(modifiedLine)

  if (normalizedOriginal.length === 0 || normalizedModified.length === 0) {
    return false
  }

  const changedSegments = tokens.filter(
    (token) => token.type !== 'same' && token.text.trim().length > 0,
  )
  if (changedSegments.length === 0) {
    return false
  }

  const similarity = getInlineTokenSimilarity(originalLine, modifiedLine)
  if (similarity < 0.34) {
    return true
  }

  const changedChars = changedSegments.reduce(
    (total, token) => total + token.text.replace(/\s+/g, '').length,
    0,
  )
  const totalChars = Math.max(
    normalizedOriginal.replace(/\s+/g, '').length,
    normalizedModified.replace(/\s+/g, '').length,
  )
  const changeRatio = totalChars === 0 ? 0 : changedChars / totalChars
  const tinySameSegments = tokens.filter(
    (token) => token.type === 'same' && token.text.trim().length > 0,
  )
  const hasTinyAnchors = tinySameSegments.some(
    (token) => token.text.replace(/\s+/g, '').length <= 3,
  )

  if (isCrossScriptRewrite(originalLine, modifiedLine)) {
    const strongSameAnchors = tinySameSegments.filter((token) =>
      isStrongInlineAnchor(token.text),
    )
    const sameContentLength = tinySameSegments.reduce(
      (total, token) => total + token.text.replace(/\s+/g, '').length,
      0,
    )

    if (strongSameAnchors.length <= 1 && sameContentLength <= 12) {
      return true
    }
  }

  return changedSegments.length >= 4 && changeRatio > 0.45 && hasTinyAnchors
}

function buildWholeLineReplacementTokens(
  originalLine: string,
  modifiedLine: string,
): InlineDiffToken[] {
  const tokens: InlineDiffToken[] = []

  if (originalLine.length > 0) {
    tokens.push({ type: 'del', text: originalLine })
  }

  if (modifiedLine.length > 0) {
    tokens.push({ type: 'add', text: modifiedLine })
  }

  return tokens
}

function getInlineTokenSimilarity(
  originalLine: string,
  modifiedLine: string,
): number {
  const originalTokens = new Set(tokenizeInlineComparableText(originalLine))
  const modifiedTokens = new Set(tokenizeInlineComparableText(modifiedLine))

  if (originalTokens.size === 0 || modifiedTokens.size === 0) {
    return 0
  }

  let overlap = 0
  originalTokens.forEach((token) => {
    if (modifiedTokens.has(token)) {
      overlap += 1
    }
  })

  return (2 * overlap) / (originalTokens.size + modifiedTokens.size)
}

function tokenizeInlineComparableText(text: string): string[] {
  return (
    normalizeInlineComparisonText(text).match(
      /\p{L}[\p{L}\p{N}_-]*|\p{N}+|[^\p{L}\p{N}\s]/gu,
    ) ?? []
  )
}

function normalizeInlineComparisonText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function hasMeaningfulCjkContent(text: string): boolean {
  return countMatches(text, /\p{Script=Han}/gu) >= 2
}

function isCrossScriptRewrite(
  originalLine: string,
  modifiedLine: string,
): boolean {
  const originalLatinCount = countMatches(originalLine, /\p{Script=Latin}/gu)
  const modifiedLatinCount = countMatches(modifiedLine, /\p{Script=Latin}/gu)
  const originalCjkCount = countMatches(originalLine, /\p{Script=Han}/gu)
  const modifiedCjkCount = countMatches(modifiedLine, /\p{Script=Han}/gu)

  return (
    (originalLatinCount >= 6 && modifiedCjkCount >= 2) ||
    (modifiedLatinCount >= 6 && originalCjkCount >= 2)
  )
}

function isStrongInlineAnchor(text: string): boolean {
  const compact = text.replace(/\s+/g, '')
  const latinCount = countMatches(compact, /\p{Script=Latin}/gu)
  const cjkCount = countMatches(compact, /\p{Script=Han}/gu)

  if (cjkCount >= 2) {
    return true
  }

  return latinCount >= 6
}

function countMatches(text: string, pattern: RegExp): number {
  return Array.from(text.matchAll(pattern)).length
}
