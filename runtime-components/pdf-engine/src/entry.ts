import { PDFDocument } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import binaryData from 'virtual:pdfjs-binary-data'
import workerSource from 'virtual:pdfjs-worker-script'

import type {
  PdfAnnotationInput,
  PdfEngineDocument,
} from '../../../src/core/runtime-components/contracts'

import { addAnnotationsToPdf } from './annotations'
import { RENDER_DOCUMENT, createPdfDocument } from './document'

type PdfTextItem = {
  str: string
  transform: number[]
  hasEOL?: boolean
}

type PdfSliceErrorKind =
  | 'invalid-range'
  | 'load-failed'
  | 'too-many-pages'
  | 'too-large'

class ComponentPdfSliceError extends Error {
  constructor(
    readonly kind: PdfSliceErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'PdfSliceError'
  }
}

const MAX_SLICE_PAGES = 100
const MAX_SLICE_BYTES = 24 * 1024 * 1024
const RENDER_SCALE = 2

function pageItemsToText(items: unknown[]): string {
  const positioned = items
    .filter(
      (item): item is PdfTextItem =>
        typeof item === 'object' &&
        item !== null &&
        'str' in item &&
        typeof (item as PdfTextItem).str === 'string' &&
        'transform' in item &&
        Array.isArray((item as PdfTextItem).transform) &&
        (item as PdfTextItem).transform.length >= 6,
    )
    .map((item) => ({
      str: item.str,
      x: item.transform[4] ?? 0,
      y: item.transform[5] ?? 0,
      hasEOL: item.hasEOL === true,
    }))
    .sort((left, right) => right.y - left.y || left.x - right.x)

  const lines: string[][] = []
  let currentLine: typeof positioned = []
  let lastY: number | null = null
  const flush = (): void => {
    if (currentLine.length === 0) return
    currentLine.sort((left, right) => left.x - right.x)
    lines.push(currentLine.map(({ str }) => str))
    currentLine = []
  }
  for (const item of positioned) {
    if (item.hasEOL) {
      currentLine.push(item)
      flush()
      lastY = null
      continue
    }
    if (lastY !== null && Math.abs(item.y - lastY) > 4) flush()
    currentLine.push(item)
    lastY = item.y
  }
  flush()
  return lines.map((parts) => parts.join(' ').trim()).join('\n')
}

/**
 * pdf.js loads standard font programs and the JBIG2/OpenJPEG wasm decoders
 * on demand. We never let it fetch them from a URL: the component has to work
 * offline and self-contained, so the files are inlined at build time
 * (`virtual:pdfjs-binary-data`) and handed over through this factory, which
 * pdf.js consults on the main thread whenever `useWorkerFetch` is false.
 */
class InlineBinaryDataFactory {
  async fetch({
    kind,
    filename,
  }: {
    kind: string
    filename: string
  }): Promise<Uint8Array> {
    const encoded = binaryData[kind]?.[filename]
    if (encoded === undefined) {
      throw new Error(`PDF engine has no bundled ${kind} file "${filename}"`)
    }
    return decodeBase64(encoded)
  }
}

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function openDocument(bytes: Uint8Array) {
  return pdfjs.getDocument({
    data: bytes.slice(),
    // Said explicitly because drawing depends on it: fonts are registered
    // here, and pages are drawn on canvases of this document.
    ownerDocument: RENDER_DOCUMENT,
    useWorkerFetch: false,
    BinaryDataFactory: InlineBinaryDataFactory,
  })
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('PDF operation aborted', 'AbortError')
  }
}

globalThis.__yolo_register_runtime_component__({
  id: 'pdf-engine',
  create() {
    const workerUrl = URL.createObjectURL(
      new Blob([workerSource], { type: 'text/javascript' }),
    )
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
    let disposed = false
    const assertActive = (): void => {
      if (disposed) throw new Error('PDF engine is disposed')
    }
    const openDocuments = new Set<PdfEngineDocument>()

    return Object.freeze({
      async openDocument(bytes: Uint8Array) {
        assertActive()
        const opened = await createPdfDocument(openDocument(bytes))
        const tracked: PdfEngineDocument = Object.freeze({
          ...opened,
          destroy: () => {
            openDocuments.delete(tracked)
            return opened.destroy()
          },
        })
        openDocuments.add(tracked)
        if (disposed) {
          await tracked.destroy()
          throw new Error('PDF engine is disposed')
        }
        return tracked
      },

      async addAnnotations(
        bytes: Uint8Array,
        annotations: readonly PdfAnnotationInput[],
      ) {
        assertActive()
        return addAnnotationsToPdf(bytes, annotations)
      },

      async extractPages(
        bytes: Uint8Array,
        options: { maxPages: number; signal?: AbortSignal },
      ) {
        assertActive()
        abortIfNeeded(options.signal)
        const task = openDocument(bytes)
        const document = await task.promise
        try {
          const pages: { page: number; text: string }[] = []
          const limit = Math.min(document.numPages, options.maxPages)
          for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
            abortIfNeeded(options.signal)
            const page = await document.getPage(pageNumber)
            try {
              const text = await page.getTextContent()
              pages.push({
                page: pageNumber,
                text: pageItemsToText(text.items as unknown[]),
              })
            } finally {
              page.cleanup()
            }
          }
          return { totalPages: document.numPages, pages }
        } finally {
          await task.destroy()
        }
      },

      async getPageCount(bytes: Uint8Array, signal?: AbortSignal) {
        assertActive()
        abortIfNeeded(signal)
        const task = openDocument(bytes)
        const document = await task.promise
        try {
          return document.numPages
        } finally {
          await task.destroy()
        }
      },

      async extractPageText(
        bytes: Uint8Array,
        pageNumber: number,
        signal?: AbortSignal,
      ) {
        assertActive()
        abortIfNeeded(signal)
        const task = openDocument(bytes)
        const document = await task.promise
        try {
          if (pageNumber < 1 || pageNumber > document.numPages) {
            throw new RangeError(
              `PDF page ${pageNumber} is outside 1-${document.numPages}`,
            )
          }
          const page = await document.getPage(pageNumber)
          try {
            const text = await page.getTextContent()
            return pageItemsToText(text.items as unknown[])
          } finally {
            page.cleanup()
          }
        } finally {
          await task.destroy()
        }
      },

      async renderPages(
        bytes: Uint8Array,
        range: { startPage: number; endPage?: number },
        signal?: AbortSignal,
      ) {
        assertActive()
        abortIfNeeded(signal)
        const task = openDocument(bytes)
        const document = await task.promise
        try {
          const start = Math.max(1, range.startPage)
          const end = Math.min(
            document.numPages,
            range.endPage ?? document.numPages,
          )
          const rendered: { page: number; dataUrl: string }[] = []
          for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
            abortIfNeeded(signal)
            const page = await document.getPage(pageNumber)
            try {
              const viewport = page.getViewport({ scale: RENDER_SCALE })
              const canvas = RENDER_DOCUMENT.createElement('canvas')
              try {
                canvas.width = viewport.width
                canvas.height = viewport.height
                await page.render({ canvas, viewport }).promise
                rendered.push({
                  page: pageNumber,
                  dataUrl: canvas.toDataURL('image/png'),
                })
              } finally {
                canvas.width = 0
                canvas.height = 0
              }
            } finally {
              page.cleanup()
            }
          }
          return { totalPages: document.numPages, rendered }
        } finally {
          await task.destroy()
        }
      },

      async slicePages(
        bytes: Uint8Array,
        range: { startPage: number; endPage?: number },
      ) {
        assertActive()
        let source: PDFDocument
        try {
          source = await PDFDocument.load(bytes)
        } catch (error) {
          throw new ComponentPdfSliceError(
            'load-failed',
            `Failed to load PDF (may be encrypted, corrupt, or unsupported): ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        const totalSourcePages = source.getPageCount()
        if (!Number.isInteger(range.startPage) || range.startPage < 1) {
          throw new ComponentPdfSliceError(
            'invalid-range',
            `Invalid startPage ${range.startPage}; must be a positive integer.`,
          )
        }
        if (range.startPage > totalSourcePages) {
          throw new ComponentPdfSliceError(
            'invalid-range',
            `startPage ${range.startPage} exceeds the source document's ${totalSourcePages} pages.`,
          )
        }
        const actualStart = range.startPage
        const actualEnd =
          range.endPage === undefined
            ? totalSourcePages
            : Math.min(range.endPage, totalSourcePages)
        if (actualEnd < actualStart) {
          throw new ComponentPdfSliceError(
            'invalid-range',
            `endPage ${range.endPage} is less than startPage ${range.startPage}.`,
          )
        }
        const pageCount = actualEnd - actualStart + 1
        if (pageCount > MAX_SLICE_PAGES) {
          throw new ComponentPdfSliceError(
            'too-many-pages',
            `Requested ${pageCount} pages but the maximum is ${MAX_SLICE_PAGES}.`,
          )
        }
        const target = await PDFDocument.create()
        const indices = Array.from(
          { length: pageCount },
          (_, index) => actualStart - 1 + index,
        )
        const copied = await target.copyPages(source, indices)
        copied.forEach((page) => target.addPage(page))
        const saved = await target.save()
        const result =
          saved instanceof Uint8Array ? saved : new Uint8Array(saved)
        if (result.byteLength > MAX_SLICE_BYTES) {
          throw new ComponentPdfSliceError(
            'too-large',
            `PDF slice is ${result.byteLength} bytes, exceeding ${MAX_SLICE_BYTES}.`,
          )
        }
        return {
          bytes: result,
          totalSourcePages,
          actualStart,
          actualEnd,
        }
      },

      dispose(): void {
        if (disposed) return
        disposed = true
        for (const document of openDocuments) void document.destroy()
        URL.revokeObjectURL(workerUrl)
      },
    })
  },
})
