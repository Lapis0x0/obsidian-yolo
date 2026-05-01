import type { App, TFile } from 'obsidian'

import {
  batchLookupImageCache,
  batchWriteImageCache,
  buildPdfPageImageCacheKey,
} from '../../database/json/chat/imageCacheStore'
import type { YoloSettingsLike } from '../../database/json/chat/imageCacheStore'

/** Fixed render scale (2× = ~144 dpi at 72 dpi baseline). */
const RENDER_SCALE = 2

export type RenderedPdfPage = {
  page: number
  dataUrl: string
}

export type RenderPdfPagesResult = {
  totalPages: number
  rendered: RenderedPdfPage[]
}

/**
 * Renders a page range of a PDF file to PNG images using the bundled
 * pdfjs-dist (lazy-loaded for mobile compatibility, identical pattern to
 * loadPdfPages in pdfPages.ts).
 *
 * Page numbers are 1-based. `endPage` defaults to the last page of the PDF
 * when omitted (full-document mode). The resolved range is clamped to
 * [1, totalPages].
 *
 * Caching: each rendered page is keyed by `pdf:<path>:<mtime>:<size>:p<N>`
 * via the global image cache store. Cache hits skip the render step.
 *
 * Throws on any failure — callers must NOT fall back to text mode.
 */
export async function renderPdfPagesToImages(
  app: App,
  file: TFile,
  startPage: number,
  endPage: number | undefined,
  settings?: YoloSettingsLike | null,
): Promise<RenderPdfPagesResult> {
  // Lazy-load pdfjs-dist (same pattern as loadPdfPages).
  await import('pdfjs-dist/build/pdf.worker.mjs')
  const pdfjs = await import('pdfjs-dist')

  const buf = await app.vault.readBinary(file)
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buf),
    useWorkerFetch: false,
    isEvalSupported: false,
  })
  const pdf = await loadingTask.promise
  try {
    const totalPages = pdf.numPages

    const resolvedStart = Math.max(1, startPage)
    const resolvedEnd = Math.min(totalPages, endPage ?? totalPages)

    if (resolvedEnd < resolvedStart) {
      return { totalPages, rendered: [] }
    }

    const pages: number[] = []
    for (let p = resolvedStart; p <= resolvedEnd; p++) {
      pages.push(p)
    }

    const cacheKeys = pages.map((page) =>
      buildPdfPageImageCacheKey(
        file.path,
        file.stat.mtime,
        file.stat.size,
        page,
      ),
    )

    const cacheHits = await batchLookupImageCache(app, cacheKeys, settings)

    const missedIndices = pages
      .map((_, i) => i)
      .filter((i) => !cacheHits.has(cacheKeys[i]))

    const freshDataUrls = new Map<number, string>()

    for (const i of missedIndices) {
      const pageNum = pages[i]
      const pdfPage = await pdf.getPage(pageNum)
      try {
        const viewport = pdfPage.getViewport({ scale: RENDER_SCALE })

        const canvas = document.createElement('canvas')
        try {
          canvas.width = viewport.width
          canvas.height = viewport.height

          const ctx = canvas.getContext('2d')
          if (!ctx) {
            throw new Error(
              `[YOLO] Failed to get 2D canvas context for PDF page ${pageNum}.`,
            )
          }

          await pdfPage.render({ canvasContext: ctx, viewport }).promise
          freshDataUrls.set(pageNum, canvas.toDataURL('image/png'))
        } finally {
          // Free the GPU/RAM-backed canvas buffer immediately. Without this
          // a tight render loop on a multi-page PDF can hold tens of MB of
          // pixel data alive until GC kicks in.
          canvas.width = 0
          canvas.height = 0
        }
      } finally {
        pdfPage.cleanup()
      }
    }

    if (missedIndices.length > 0) {
      const newEntries = missedIndices.map((i) => ({
        hash: cacheKeys[i],
        dataUrl: freshDataUrls.get(pages[i]) ?? '',
        sourcePath: file.path,
      }))
      await batchWriteImageCache(app, newEntries, settings)
    }

    const rendered: RenderedPdfPage[] = pages.map((page, i) => {
      const key = cacheKeys[i]
      const dataUrl = cacheHits.get(key) ?? freshDataUrls.get(page) ?? ''
      return { page, dataUrl }
    })

    return { totalPages, rendered }
  } finally {
    await pdf.destroy()
  }
}
