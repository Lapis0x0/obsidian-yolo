import { encode } from 'gpt-tokenizer/encoding/cl100k_base'

import {
  type PdfEngineComponentApi,
  type PdfSliceErrorKind,
  type RuntimeComponentApiMap,
  type RuntimeComponentId,
  type RuntimeComponentLease,
} from '../src/core/runtime-components/contracts'
import { setRuntimeComponentAcquirerForTests } from '../src/core/runtime-components/runtimeComponentAccess'

setRuntimeComponentAcquirerForTests(
  async <I extends RuntimeComponentId>(id: I) => {
    let api: RuntimeComponentApiMap[I]
    if (id === 'tokenizer') {
      api = {
        count: (text: string) => encode(text).length,
        dispose: () => undefined,
      } as RuntimeComponentApiMap[I]
    } else if (id === 'pdf-engine') {
      api = createPdfApi() as RuntimeComponentApiMap[I]
    } else {
      throw new Error(
        `Runtime component "${String(id)}" is not configured in tests`,
      )
    }
    return {
      api,
      release: () => undefined,
    } as RuntimeComponentLease<I>
  },
)

function createPdfApi(): PdfEngineComponentApi {
  return {
    async extractPages(bytes, options) {
      const pdf = await openPdf(bytes)
      const pages: { page: number; text: string }[] = []
      for (
        let pageNumber = 1;
        pageNumber <= Math.min(pdf.numPages, options.maxPages);
        pageNumber += 1
      ) {
        const page = await pdf.getPage(pageNumber)
        const content = await page.getTextContent()
        pages.push({ page: pageNumber, text: itemsToText(content.items) })
      }
      return { totalPages: pdf.numPages, pages }
    },
    async getPageCount(bytes) {
      return (await openPdf(bytes)).numPages
    },
    async extractPageText(bytes, pageNumber) {
      const pdf = await openPdf(bytes)
      if (pageNumber < 1 || pageNumber > pdf.numPages) throw new RangeError()
      const page = await pdf.getPage(pageNumber)
      return itemsToText((await page.getTextContent()).items)
    },
    async renderPages() {
      throw new Error('PDF rendering test double is not configured')
    },
    async slicePages(bytes, range) {
      const mockedPdfLib: {
        PDFDocument: {
          load(bytes: Uint8Array): Promise<{
            getPageCount(): number
          }>
          create(): Promise<{
            copyPages(source: unknown, indices: number[]): Promise<unknown[]>
            addPage(page: unknown): void
            save(): Promise<Uint8Array>
          }>
        }
      } = jest.requireMock('pdf-lib')
      const { PDFDocument } = mockedPdfLib
      let source: Awaited<ReturnType<typeof PDFDocument.load>>
      try {
        source = await PDFDocument.load(bytes)
      } catch (error) {
        throw sliceError('load-failed', String(error))
      }
      const totalSourcePages = source.getPageCount()
      if (
        !Number.isInteger(range.startPage) ||
        range.startPage < 1 ||
        range.startPage > totalSourcePages
      ) {
        throw sliceError('invalid-range', 'Invalid PDF page range')
      }
      const actualStart = range.startPage
      const actualEnd = Math.min(
        range.endPage ?? totalSourcePages,
        totalSourcePages,
      )
      if (actualEnd < actualStart) {
        throw sliceError('invalid-range', 'Invalid PDF page range')
      }
      const count = actualEnd - actualStart + 1
      if (count > 100) throw sliceError('too-many-pages', 'Too many PDF pages')
      const target = await PDFDocument.create()
      const pages = await target.copyPages(
        source,
        Array.from({ length: count }, (_, index) => actualStart - 1 + index),
      )
      pages.forEach((page) => target.addPage(page))
      const output = await target.save()
      if (output.byteLength > 24 * 1024 * 1024) {
        throw sliceError('too-large', 'PDF slice is too large')
      }
      return { bytes: output, totalSourcePages, actualStart, actualEnd }
    },
    dispose: () => undefined,
  }
}

type PdfTestDocument = {
  numPages: number
  getPage(page: number): Promise<{
    getTextContent(): Promise<{ items: unknown[] }>
  }>
}

async function openPdf(bytes: Uint8Array): Promise<PdfTestDocument> {
  const pdfjs: {
    getDocument(options: unknown): { promise: Promise<PdfTestDocument> }
  } = jest.requireMock('pdfjs-dist')
  return await pdfjs.getDocument({ data: bytes }).promise
}

function itemsToText(items: unknown[]): string {
  return items
    .filter(
      (item): item is { str: string } =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { str?: unknown }).str === 'string',
    )
    .map((item) => item.str)
    .join(' ')
}

function sliceError(kind: PdfSliceErrorKind, message: string): Error {
  return Object.assign(new Error(message), { name: 'PdfSliceError', kind })
}
