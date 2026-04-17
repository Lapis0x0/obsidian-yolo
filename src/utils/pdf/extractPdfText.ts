import type { App, TFile } from 'obsidian'

import { createYieldController } from '../common/yield-to-main'

/** Hard cap for vault PDF indexing (binary size). */
export const PDF_INDEX_MAX_BYTES = 50 * 1024 * 1024

/** Hard cap for vault PDF indexing (page count). */
export const PDF_INDEX_MAX_PAGES = 500

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

export type ExtractPdfTextOptions = {
  signal?: AbortSignal
  maxBinaryBytes?: number
  maxPages?: number
}

/**
 * Lazy-loads pdfjs-dist. Preloads the official worker entry so it registers
 * `globalThis.pdfjsWorker.WorkerMessageHandler`; PDF.js then uses the in-thread
 * fake worker and does not require `GlobalWorkerOptions.workerSrc` or a separate
 * `pdf.worker.mjs` on disk (fits single-file `main.js` releases).
 */
export async function extractPdfText(
  app: App,
  file: TFile,
  options: ExtractPdfTextOptions = {},
): Promise<{ pages: { page: number; text: string }[] }> {
  const maxBinaryBytes = options.maxBinaryBytes ?? PDF_INDEX_MAX_BYTES
  const maxPages = options.maxPages ?? PDF_INDEX_MAX_PAGES

  if (file.stat.size > maxBinaryBytes) {
    throw new Error(
      `PDF too large (${file.stat.size} bytes). Limit is ${maxBinaryBytes} bytes.`,
    )
  }

  const buf = await app.vault.readBinary(file)
  const maybeYield = createYieldController(1)

  await import('pdfjs-dist/build/pdf.worker.mjs')
  const pdfjs = await import('pdfjs-dist')

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buf),
    useWorkerFetch: false,
    isEvalSupported: false,
  })

  const pdf = await loadingTask.promise
  const numPages = Math.min(pdf.numPages, maxPages)
  const pages: { page: number; text: string }[] = []

  for (let i = 1; i <= numPages; i++) {
    if (options.signal?.aborted) {
      throw new DOMException('PDF extraction aborted', 'AbortError')
    }
    await maybeYield()
    const page = await pdf.getPage(i)
    const textContent = await page.getTextContent()
    const text = pageItemsToText(textContent.items as unknown[])
    pages.push({ page: i, text })
  }

  if (pdf.numPages > maxPages) {
    console.warn(
      `[YOLO] PDF ${file.path} has ${pdf.numPages} pages; only first ${maxPages} were extracted.`,
    )
  }

  return { pages }
}
