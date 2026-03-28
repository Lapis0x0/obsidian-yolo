export type ParsedTagContent =
  | { type: 'string'; content: string }
  | {
      type: 'smtcmp_block'
      content: string
      language?: string
      filename?: string
      startLine?: number
      endLine?: number
    }
  | {
      type: 'think'
      content: string
    }

type TagMatch =
  | {
      type: 'smtcmp_block'
      start: number
      openEnd: number
      closeStart: number
      closeEnd: number
      attrs: Record<string, string>
    }
  | {
      type: 'think'
      start: number
      openEnd: number
      closeStart: number
      closeEnd: number
    }

const SMTCMP_OPEN_TAG_PATTERN = /<smtcmp_block\b[^>]*>/g
const THINK_OPEN_TAG_PATTERN = /<think>/g
const ATTRIBUTE_PATTERN = /([A-Za-z0-9_-]+)="([^"]*)"/g
const SMTCMP_CLOSE_TAG = '</smtcmp_block>'
const THINK_CLOSE_TAG = '</think>'

const isStandaloneSmtcmpOpenTag = ({
  input,
  start,
  end,
}: {
  input: string
  start: number
  end: number
}): boolean => {
  const lineStart = input.lastIndexOf('\n', start - 1) + 1
  const lineEndIndex = input.indexOf('\n', end)
  const lineEnd = lineEndIndex === -1 ? input.length : lineEndIndex
  const before = input.slice(lineStart, start)
  const after = input.slice(end, lineEnd)
  return (
    /^[ \t]*$/.test(before) && /^[ \t]*(?:<\/smtcmp_block>)?[ \t]*$/.test(after)
  )
}

const parseAttributes = (tagText: string): Record<string, string> => {
  const attrs: Record<string, string> = {}
  ATTRIBUTE_PATTERN.lastIndex = 0

  let match = ATTRIBUTE_PATTERN.exec(tagText)
  while (match) {
    attrs[match[1].toLowerCase()] = match[2]
    match = ATTRIBUTE_PATTERN.exec(tagText)
  }

  return attrs
}

const findNextStandaloneSmtcmpOpen = (
  input: string,
  fromIndex: number,
): {
  start: number
  openEnd: number
  attrs: Record<string, string>
} | null => {
  SMTCMP_OPEN_TAG_PATTERN.lastIndex = fromIndex

  let match = SMTCMP_OPEN_TAG_PATTERN.exec(input)
  while (match) {
    const start = match.index
    const openEnd = start + match[0].length
    if (!isStandaloneSmtcmpOpenTag({ input, start, end: openEnd })) {
      match = SMTCMP_OPEN_TAG_PATTERN.exec(input)
      continue
    }

    return {
      start,
      openEnd,
      attrs: parseAttributes(match[0]),
    }
  }

  return null
}

const findMatchingSmtcmpCloseTag = ({
  input,
  fromIndex,
}: {
  input: string
  fromIndex: number
}): { start: number; end: number } | null => {
  let depth = 1
  let searchIndex = fromIndex

  while (searchIndex < input.length) {
    const nextOpen = findNextStandaloneSmtcmpOpen(input, searchIndex)
    const nextCloseStart = input.indexOf(SMTCMP_CLOSE_TAG, searchIndex)

    if (nextCloseStart === -1) {
      return null
    }

    if (!nextOpen || nextCloseStart < nextOpen.start) {
      depth -= 1
      if (depth === 0) {
        return {
          start: nextCloseStart,
          end: nextCloseStart + SMTCMP_CLOSE_TAG.length,
        }
      }
      searchIndex = nextCloseStart + SMTCMP_CLOSE_TAG.length
      continue
    }

    depth += 1
    searchIndex = nextOpen.openEnd
  }

  return null
}

const findNextSmtcmpBlock = (
  input: string,
  fromIndex: number,
): Extract<TagMatch, { type: 'smtcmp_block' }> | null => {
  const nextOpen = findNextStandaloneSmtcmpOpen(input, fromIndex)
  if (!nextOpen) {
    return null
  }

  const close = findMatchingSmtcmpCloseTag({
    input,
    fromIndex: nextOpen.openEnd,
  })

  return {
    type: 'smtcmp_block',
    start: nextOpen.start,
    openEnd: nextOpen.openEnd,
    closeStart: close?.start ?? input.length,
    closeEnd: close?.end ?? input.length,
    attrs: nextOpen.attrs,
  }
}

const findNextThinkBlock = (
  input: string,
  fromIndex: number,
): Extract<TagMatch, { type: 'think' }> | null => {
  THINK_OPEN_TAG_PATTERN.lastIndex = fromIndex
  const match = THINK_OPEN_TAG_PATTERN.exec(input)
  if (!match) {
    return null
  }

  const start = match.index
  const openEnd = start + match[0].length
  const closeStart = input.indexOf(THINK_CLOSE_TAG, openEnd)
  const closeEnd =
    closeStart === -1 ? input.length : closeStart + THINK_CLOSE_TAG.length

  return {
    type: 'think',
    start,
    openEnd,
    closeStart: closeStart === -1 ? input.length : closeStart,
    closeEnd,
  }
}

const findNextTag = (input: string, fromIndex: number): TagMatch | null => {
  const nextSmtcmp = findNextSmtcmpBlock(input, fromIndex)
  const nextThink = findNextThinkBlock(input, fromIndex)

  if (!nextSmtcmp) {
    return nextThink
  }
  if (!nextThink) {
    return nextSmtcmp
  }

  return nextSmtcmp.start < nextThink.start ? nextSmtcmp : nextThink
}

/**
 * Parses text containing <smtcmp_block> and <think> tags into structured content
 */
export function parseTagContents(input: string): ParsedTagContent[] {
  const parsedResult: ParsedTagContent[] = []
  let cursor = 0

  while (cursor < input.length) {
    const nextTag = findNextTag(input, cursor)
    if (!nextTag) {
      parsedResult.push({
        type: 'string',
        content: input.slice(cursor),
      })
      break
    }

    if (nextTag.start > cursor) {
      parsedResult.push({
        type: 'string',
        content: input.slice(cursor, nextTag.start),
      })
    }

    if (nextTag.type === 'smtcmp_block') {
      parsedResult.push({
        type: 'smtcmp_block',
        content: input.slice(nextTag.openEnd, nextTag.closeStart),
        language: nextTag.attrs.language,
        filename: nextTag.attrs.filename,
        startLine: nextTag.attrs.startline
          ? parseInt(nextTag.attrs.startline, 10)
          : undefined,
        endLine: nextTag.attrs.endline
          ? parseInt(nextTag.attrs.endline, 10)
          : undefined,
      })
    } else {
      parsedResult.push({
        type: 'think',
        content: input.slice(nextTag.openEnd, nextTag.closeStart),
      })
    }

    cursor = nextTag.closeEnd
  }

  const normalizedBlocks: ParsedTagContent[] = []
  parsedResult.forEach((block) => {
    if (block.type !== 'smtcmp_block') {
      normalizedBlocks.push(block)
      return
    }

    const nestedBlocks = parseTagContents(block.content)
    const hasNonWhitespaceText = nestedBlocks.some((nestedBlock) => {
      return (
        nestedBlock.type === 'string' && nestedBlock.content.trim().length > 0
      )
    })
    const hasThinkBlock = nestedBlocks.some(
      (nestedBlock) => nestedBlock.type === 'think',
    )
    const nestedSmtcmpBlocks = nestedBlocks.filter(
      (
        nestedBlock,
      ): nestedBlock is Extract<ParsedTagContent, { type: 'smtcmp_block' }> =>
        nestedBlock.type === 'smtcmp_block',
    )

    if (
      hasNonWhitespaceText ||
      hasThinkBlock ||
      nestedSmtcmpBlocks.length === 0
    ) {
      normalizedBlocks.push(block)
      return
    }

    normalizedBlocks.push(...nestedSmtcmpBlocks)
  })

  normalizedBlocks.forEach((block) => {
    block.content = block.content.replace(/^\n|\n$/g, '')
  })

  return normalizedBlocks
}
