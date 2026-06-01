export type ReadAloudSourceKind = 'selection' | 'document'

export type ReadAloudTextSnapshot = {
  sourceKind: ReadAloudSourceKind
  text: string
  sourcePath: string
  sourceName: string
}

export const normalizeReadAloudSelectionText = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

export const buildReadableMarkdownText = (markdown: string): string => {
  let text = markdown.replace(/\r\n?/g, '\n')
  text = text.replace(/^---\n[\s\S]*?\n---\n?/, '')
  text = text.replace(/```[\s\S]*?```/g, '\n')
  text = text.replace(/~~~[\s\S]*?~~~/g, '\n')
  text = text.replace(/<!--[\s\S]*?-->/g, ' ')
  text = text.replace(/\^[A-Za-z0-9_-]+\b/g, '')
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, (_match, alt: string) =>
    alt.trim(),
  )
  text = text.replace(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g, (_match, file) =>
    stripWikiFileName(String(file)),
  )
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  text = text.replace(
    /\[\[([^\]|#]+)(?:[|#]([^\]]+))?\]\]/g,
    (_m, file, label) => String(label || stripWikiFileName(String(file))),
  )
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  text = text.replace(/^\s{0,3}>\s?/gm, '')
  text = text.replace(/^\s*[-*+]\s+/gm, '')
  text = text.replace(/^\s*\d+[.)]\s+/gm, '')
  text = text.replace(/\|/g, ' ')
  text = text.replace(/[ \t]{2,}/g, ' ')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

export const prepareReadAloudText = (
  markdown: string,
  mode: 'readable' | 'raw',
): string =>
  mode === 'raw'
    ? normalizeReadAloudSelectionText(markdown)
    : buildReadableMarkdownText(markdown)

export function splitReadAloudText(
  text: string,
  targetChars: number,
  maxInputChars?: number,
): string[] {
  const maxChars = Math.max(200, Math.min(targetChars, maxInputChars ?? 3000))
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
  const chunks: string[] = []
  let current = ''
  let currentParagraphIndex = -1

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const pieces =
      paragraph.length > maxChars
        ? splitByPreferredBoundaries(paragraph, maxChars)
        : [paragraph]
    pieces.forEach((piece) => {
      if (!current) {
        current = piece
        currentParagraphIndex = paragraphIndex
        return
      }
      const separator =
        currentParagraphIndex === paragraphIndex
          ? getInlineJoinSeparator(current, piece)
          : '\n\n'
      if (current.length + separator.length + piece.length <= maxChars) {
        current += `${separator}${piece}`
        currentParagraphIndex = paragraphIndex
        return
      }
      chunks.push(current)
      current = piece
      currentParagraphIndex = paragraphIndex
    })
  })
  if (current) chunks.push(current)
  return chunks
}

type SplitBoundary = {
  index: number
  priority: number
}

const SENTENCE_BOUNDARY_CHARS = new Set(['。', '！', '？', '.', '!', '?'])
const PHRASE_BOUNDARY_CHARS = new Set(['，', '、', '；', ';', '：', ':', ','])
const CLOSING_BOUNDARY_CHARS = new Set([
  '"',
  "'",
  ')',
  ']',
  '}',
  '）',
  '】',
  '》',
  '」',
  '』',
  '”',
  '’',
])
const ASCII_WORD_CHAR = /^[A-Za-z0-9]$/
const ASCII_TRAILING_NEEDS_SPACE = /^[A-Za-z0-9,.;:!?)]$/

const splitByPreferredBoundaries = (
  paragraph: string,
  maxChars: number,
): string[] => {
  const chunks: string[] = []
  let remaining = paragraph.trim()
  while (remaining.length > maxChars) {
    const splitIndex = findPreferredSplitIndex(remaining, maxChars)
    const chunk = remaining.slice(0, splitIndex).trim()
    if (chunk) chunks.push(chunk)
    remaining = remaining.slice(splitIndex).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

const findPreferredSplitIndex = (text: string, maxChars: number): number => {
  const limit = Math.min(text.length, maxChars)
  const boundaries = collectBoundaries(text, limit)
  const preferredMin = Math.min(
    Math.max(80, Math.floor(maxChars * 0.45)),
    limit - 1,
  )
  const fallbackMin = Math.min(
    Math.max(40, Math.floor(maxChars * 0.2)),
    limit - 1,
  )

  // Prefer natural speech pauses over a visually even but awkward hard cut.
  for (const minIndex of [preferredMin, fallbackMin]) {
    for (const priority of [3, 2, 1]) {
      const boundary = findLatestBoundary(boundaries, priority, minIndex)
      if (boundary) return boundary.index
    }
  }
  return limit
}

const collectBoundaries = (text: string, limit: number): SplitBoundary[] => {
  const boundaries: SplitBoundary[] = []
  for (let i = 1; i <= limit; i++) {
    const char = text[i - 1]
    if (/\s/.test(char)) {
      boundaries.push({ index: i, priority: 1 })
      continue
    }
    const trigger = getBoundaryTriggerChar(text, i - 1)
    if (SENTENCE_BOUNDARY_CHARS.has(trigger)) {
      boundaries.push({ index: i, priority: 3 })
      continue
    }
    if (PHRASE_BOUNDARY_CHARS.has(trigger)) {
      boundaries.push({ index: i, priority: 2 })
    }
  }
  return boundaries
}

const getBoundaryTriggerChar = (text: string, index: number): string => {
  let cursor = index
  while (cursor >= 0 && CLOSING_BOUNDARY_CHARS.has(text[cursor])) {
    cursor--
  }
  return text[cursor] ?? ''
}

const findLatestBoundary = (
  boundaries: SplitBoundary[],
  priority: number,
  minIndex: number,
): SplitBoundary | null => {
  for (let i = boundaries.length - 1; i >= 0; i--) {
    const boundary = boundaries[i]
    if (boundary.priority === priority && boundary.index >= minIndex) {
      return boundary
    }
  }
  return null
}

const getInlineJoinSeparator = (left: string, right: string): string => {
  const leftLast = left.trimEnd().slice(-1)
  const rightFirst = right.trimStart().slice(0, 1)
  if (!leftLast || !rightFirst) return ''
  if (!ASCII_WORD_CHAR.test(rightFirst)) return ''
  if (ASCII_TRAILING_NEEDS_SPACE.test(leftLast)) return ' '
  return CLOSING_BOUNDARY_CHARS.has(leftLast) ? ' ' : ''
}

const stripWikiFileName = (value: string): string => {
  const clean = value.split('/').pop() ?? value
  return clean.replace(/\.[A-Za-z0-9]+$/, '')
}
