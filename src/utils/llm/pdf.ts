import { MentionablePDF } from '../../types/mentionable'
import { createYieldController } from '../common/yield-to-main'

/** Hard cap for uploaded PDF size at the chat input. */
export const PDF_UPLOAD_MAX_BYTES = 50 * 1024 * 1024

/** Hard cap for uploaded PDF page count. */
export const PDF_UPLOAD_MAX_PAGES = 500

type PdfTextItem = {
  str: string
  transform: number[]
  hasEOL?: boolean
}

function pageItemsToText(items: unknown[]): string {
  const textItems = items.filter(
    (item): item is PdfTextItem =>
      typeof item === 'object' &&
      item !== null &&
      'str' in item &&
      typeof (item as PdfTextItem).str === 'string' &&
      'transform' in item &&
      Array.isArray((item as PdfTextItem).transform) &&
      (item as PdfTextItem).transform.length >= 6,
  )

  if (textItems.length === 0) {
    return ''
  }

  const positioned = textItems.map((item) => ({
    str: item.str,
    x: item.transform[4] ?? 0,
    y: item.transform[5] ?? 0,
    hasEOL: item.hasEOL === true,
  }))

  positioned.sort((a, b) => {
    if (b.y !== a.y) {
      return b.y - a.y
    }
    return a.x - b.x
  })

  const yThreshold = 4
  const lines: string[][] = []
  let currentLine: typeof positioned = []
  let lastY: number | null = null

  const flushLine = () => {
    if (currentLine.length === 0) {
      return
    }
    currentLine.sort((a, b) => a.x - b.x)
    lines.push(currentLine.map((p) => p.str))
    currentLine = []
  }

  for (const item of positioned) {
    if (item.hasEOL) {
      currentLine.push(item)
      flushLine()
      lastY = null
      continue
    }
    if (lastY !== null && Math.abs(item.y - lastY) > yThreshold) {
      flushLine()
    }
    currentLine.push(item)
    lastY = item.y
  }
  flushLine()

  return lines.map((parts) => parts.join(' ').trim()).join('\n')
}

export async function fileToMentionablePDF(
  file: File,
  options: { maxBinaryBytes?: number; maxPages?: number } = {},
): Promise<MentionablePDF> {
  const maxBinaryBytes = options.maxBinaryBytes ?? PDF_UPLOAD_MAX_BYTES
  const maxPages = options.maxPages ?? PDF_UPLOAD_MAX_PAGES

  if (file.size > maxBinaryBytes) {
    throw new Error(
      `PDF too large (${file.size} bytes). Limit is ${maxBinaryBytes} bytes.`,
    )
  }

  const buf = await file.arrayBuffer()
  const maybeYield = createYieldController(1)

  await import('pdfjs-dist/build/pdf.worker.mjs')
  const pdfjs = await import('pdfjs-dist')

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buf),
    useWorkerFetch: false,
    isEvalSupported: false,
  })

  const pdf = await loadingTask.promise
  const totalPages = pdf.numPages
  const numPages = Math.min(totalPages, maxPages)
  const pageTexts: string[] = []

  for (let i = 1; i <= numPages; i++) {
    await maybeYield()
    const page = await pdf.getPage(i)
    const textContent = await page.getTextContent()
    pageTexts.push(pageItemsToText(textContent.items as unknown[]))
  }

  const truncated = totalPages > maxPages
  const data = pageTexts
    .map((text, idx) => `--- Page ${idx + 1} ---\n${text}`)
    .join('\n\n')

  return {
    type: 'pdf',
    name: file.name,
    data,
    pageCount: totalPages,
    truncated,
  }
}
