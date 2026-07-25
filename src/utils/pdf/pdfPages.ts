import { acquireRuntimeComponent } from '../../core/runtime-components/runtimeComponentAccess'

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
 * Lazy-loads pdfjs-dist (with its worker configured as a Blob URL — see
 * pdfjsLoader for why we route through it) and extracts plain text
 * page-by-page.
 */
export async function loadPdfPages(
  data: Uint8Array,
  options: LoadPdfPagesOptions,
): Promise<LoadedPdfPages> {
  const { maxPages, maybeYield, signal } = options
  if (signal?.aborted) {
    throw new DOMException('PDF extraction aborted', 'AbortError')
  }
  await maybeYield?.()
  const lease = await acquireRuntimeComponent('pdf-engine')
  try {
    return await lease.api.extractPages(data, { maxPages, signal })
  } finally {
    lease.release()
  }
}

/**
 * Lightweight metadata-only probe — opens the document just long enough to read
 * `numPages`, skipping the per-page text extraction. Used at upload time when
 * we want page-count metadata without paying the full extraction cost.
 */
export async function getPdfPageCount(
  data: Uint8Array,
  options: { maybeYield?: () => Promise<void>; signal?: AbortSignal } = {},
): Promise<number> {
  const { maybeYield, signal } = options

  if (signal?.aborted) {
    throw new DOMException('PDF probe aborted', 'AbortError')
  }
  if (maybeYield) {
    await maybeYield()
  }

  const lease = await acquireRuntimeComponent('pdf-engine')
  try {
    return await lease.api.getPageCount(data, signal)
  } finally {
    lease.release()
  }
}
