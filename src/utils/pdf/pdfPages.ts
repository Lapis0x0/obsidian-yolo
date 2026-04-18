type PdfTextItem = {
  str: string
  transform: number[]
  hasEOL?: boolean
}

export function pageItemsToText(items: unknown[]): string {
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

export type LoadPdfPagesOptions = {
  maxPages: number
  maybeYield?: () => Promise<void>
  signal?: AbortSignal
}

export type LoadedPdfPages = {
  totalPages: number
  pages: { page: number; text: string }[]
}

/**
 * Lazy-loads pdfjs-dist and extracts plain text page-by-page. Preloads the
 * official worker entry so PDF.js uses its in-thread fake worker (no separate
 * `pdf.worker.mjs` on disk required for single-file `main.js` releases).
 */
export async function loadPdfPages(
  data: Uint8Array,
  options: LoadPdfPagesOptions,
): Promise<LoadedPdfPages> {
  const { maxPages, maybeYield, signal } = options

  await import('pdfjs-dist/build/pdf.worker.mjs')
  const pdfjs = await import('pdfjs-dist')

  const loadingTask = pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
  })

  const pdf = await loadingTask.promise
  const totalPages = pdf.numPages
  const limit = Math.min(totalPages, maxPages)
  const pages: { page: number; text: string }[] = []

  for (let i = 1; i <= limit; i++) {
    if (signal?.aborted) {
      throw new DOMException('PDF extraction aborted', 'AbortError')
    }
    if (maybeYield) {
      await maybeYield()
    }
    const page = await pdf.getPage(i)
    const textContent = await page.getTextContent()
    pages.push({
      page: i,
      text: pageItemsToText(textContent.items as unknown[]),
    })
  }

  return { totalPages, pages }
}
