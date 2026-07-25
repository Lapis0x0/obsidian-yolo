import type { App, TFile } from 'obsidian'

import { acquireRuntimeComponent } from '../../core/runtime-components/runtimeComponentAccess'
import {
  batchLookupImageCache,
  batchWriteImageCache,
  buildPdfPageImageCacheKey,
} from '../../database/json/chat/imageCacheStore'
import type { YoloSettingsLike } from '../../database/json/chat/imageCacheStore'

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
  const buf = await app.vault.readBinary(file)
  const bytes = new Uint8Array(buf)
  const lease = await acquireRuntimeComponent('pdf-engine')
  try {
    const totalPages = await lease.api.getPageCount(bytes)

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

    const missedPages = missedIndices.map((index) => pages[index])
    const ranges: Array<{ startPage: number; endPage: number }> = []
    for (const page of missedPages) {
      const previous = ranges[ranges.length - 1]
      if (previous && page === previous.endPage + 1) {
        previous.endPage = page
      } else {
        ranges.push({ startPage: page, endPage: page })
      }
    }
    for (const range of ranges) {
      const result = await lease.api.renderPages(bytes, {
        startPage: range.startPage,
        endPage: range.endPage,
      })
      for (const rendered of result.rendered) {
        freshDataUrls.set(rendered.page, rendered.dataUrl)
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
    lease.release()
  }
}
