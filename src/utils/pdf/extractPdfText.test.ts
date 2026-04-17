jest.mock('pdfjs-dist/build/pdf.worker.mjs', () => {
  const g = globalThis as typeof globalThis & {
    pdfjsWorker?: { WorkerMessageHandler: unknown }
  }
  g.pdfjsWorker = { WorkerMessageHandler: class {} }
  return {}
})

jest.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' as string },
  getDocument: jest.fn().mockReturnValue({
    promise: Promise.resolve({
      numPages: 1,
      getPage: jest.fn().mockResolvedValue({
        getTextContent: jest.fn().mockResolvedValue({
          items: [
            {
              str: 'Hello',
              transform: [1, 0, 0, 1, 10, 20],
              hasEOL: false,
            },
          ],
        }),
      }),
    }),
  }),
}))

import { extractPdfText } from './extractPdfText'

describe('extractPdfText', () => {
  it('returns one page from mocked pdfjs', async () => {
    const app = {
      vault: {
        readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(4)),
      },
    }
    const file = {
      path: 'x.pdf',
      stat: { size: 4 },
    }
    const { pages } = await extractPdfText(app as never, file as never)
    expect(pages).toHaveLength(1)
    expect(pages[0]?.page).toBe(1)
    expect(pages[0]?.text).toContain('Hello')
  })
})
