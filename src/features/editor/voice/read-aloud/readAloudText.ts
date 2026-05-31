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

  for (const paragraph of paragraphs) {
    const pieces =
      paragraph.length > maxChars
        ? splitLongParagraph(paragraph, maxChars)
        : [paragraph]
    for (const piece of pieces) {
      if (!current) {
        current = piece
        continue
      }
      if (current.length + piece.length + 2 <= maxChars) {
        current += `\n\n${piece}`
        continue
      }
      chunks.push(current)
      current = piece
    }
  }
  if (current) chunks.push(current)
  return chunks
}

const splitLongParagraph = (paragraph: string, maxChars: number): string[] => {
  const sentences = splitSentences(paragraph)
  if (sentences.length <= 1) {
    return splitByFixedWindow(paragraph, maxChars)
  }
  const chunks: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (!current) {
      current = sentence
      continue
    }
    if (current.length + sentence.length + 1 <= maxChars) {
      current += ` ${sentence}`
      continue
    }
    chunks.push(current)
    current = sentence
  }
  if (current) chunks.push(current)
  return chunks.flatMap((chunk) =>
    chunk.length > maxChars ? splitByFixedWindow(chunk, maxChars) : [chunk],
  )
}

const splitSentences = (paragraph: string): string[] =>
  paragraph
    .match(/[^。！？.!?]+[。！？.!?]*\s*/g)
    ?.map((part) => part.trim())
    .filter(Boolean) ?? []

const splitByFixedWindow = (text: string, maxChars: number): string[] => {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += maxChars) {
    chunks.push(text.slice(i, i + maxChars).trim())
  }
  return chunks.filter(Boolean)
}

const stripWikiFileName = (value: string): string => {
  const clean = value.split('/').pop() ?? value
  return clean.replace(/\.[A-Za-z0-9]+$/, '')
}
