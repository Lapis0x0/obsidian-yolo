/**
 * Mock the cache store: we want to verify the write path is invoked or skipped
 * without going through IndexedDB. SHA-256 keying still uses real
 * crypto.subtle, which is available in jsdom/node 20+.
 */
jest.mock('../../database/local-cache/localCacheStore', () => {
  const writes: Array<{ key: string; pages: unknown[] }> = []
  return {
    __esModule: true,
    buildPdfTextCacheKeyFromContent: jest.fn(
      async (b64: string) => `c:${b64.length}`,
    ),
    writePdfText: jest.fn(
      async (_app: unknown, entry: { key: string; pages: unknown[] }) => {
        writes.push(entry)
      },
    ),
    __getWrites: () => writes,
    __resetWrites: () => {
      writes.length = 0
    },
  }
})

// Pdfjs is mocked per-test (success vs throw). Default: succeed with 2 pages.
let pdfjsMode: 'ok' | 'throw-load' | 'throw-text' = 'ok'

// The build-time inlined worker source isn't available in Jest — supply an
// empty string so pdfjsLoader's Blob URL construction is a no-op.
jest.mock(
  'virtual:pdfjs-worker-script',
  () => ({ __esModule: true, default: '' }),
  { virtual: true },
)

jest.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' as string },
  getDocument: jest.fn(() => {
    if (pdfjsMode === 'throw-load') {
      return { promise: Promise.reject(new Error('load failed')) }
    }
    return {
      promise: Promise.resolve({
        numPages: 2,
        getPage: jest.fn(async (n: number) => ({
          getTextContent: jest.fn(async () => {
            if (pdfjsMode === 'throw-text') {
              throw new Error('text extraction failed')
            }
            return {
              items: [
                {
                  str: `page ${n} text`,
                  transform: [1, 0, 0, 1, 10, 20],
                  hasEOL: false,
                },
              ],
            }
          }),
        })),
      }),
    }
  }),
}))

import { fileToMentionablePDF } from './pdf'

const makeFile = (size: number, name = 'doc.pdf'): File => {
  const bytes = new Uint8Array(size).fill(0x41)
  return new File([bytes], name, { type: 'application/pdf' })
}

describe('fileToMentionablePDF', () => {
  beforeEach(() => {
    pdfjsMode = 'ok'
    const cacheStoreMock = jest.requireMock(
      '../../database/local-cache/localCacheStore',
    )
    cacheStoreMock.__resetWrites()
  })

  it('returns mentionable with pageCount and writes cache on happy path', async () => {
    const app = { vault: {} }
    const m = await fileToMentionablePDF(app as never, makeFile(8))
    expect(m.type).toBe('pdf')
    expect(m.pageCount).toBe(2)
    expect(typeof m.rawData).toBe('string')

    const cacheStoreMock = jest.requireMock(
      '../../database/local-cache/localCacheStore',
    )
    expect(cacheStoreMock.__getWrites()).toHaveLength(1)
    expect(cacheStoreMock.__getWrites()[0]?.pages).toHaveLength(2)
  })

  it('still returns a usable mentionable when pdfjs load fails (native-PDF path stays alive)', async () => {
    pdfjsMode = 'throw-load'
    const app = { vault: {} }
    const m = await fileToMentionablePDF(app as never, makeFile(8))
    // Upload must NOT throw — Claude / Gemini only need rawData.
    expect(m.type).toBe('pdf')
    expect(m.rawData).toBeDefined()
    // pageCount unknown (probe also went through the same broken pdfjs).
    expect(m.pageCount).toBeUndefined()

    const cacheStoreMock = jest.requireMock(
      '../../database/local-cache/localCacheStore',
    )
    // No cache write when extraction failed — non-native fallback will retry later.
    expect(cacheStoreMock.__getWrites()).toHaveLength(0)
  })

  it('rejects oversized uploads regardless of pdfjs availability', async () => {
    const app = { vault: {} }
    await expect(
      fileToMentionablePDF(app as never, makeFile(64), {
        maxBinaryBytes: 32,
      }),
    ).rejects.toThrow(/PDF too large/)
  })

  it('preserves pageCount when text extraction fails mid-pass (load OK, text throws)', async () => {
    pdfjsMode = 'throw-text'
    const app = { vault: {} }
    const m = await fileToMentionablePDF(app as never, makeFile(8))
    // loadPdfPages throws partway through per-page text extraction; the outer
    // catch falls back to getPdfPageCount (numPages-only, no text) which
    // succeeds. pageCount should come through even without text.
    expect(m.rawData).toBeDefined()
    expect(m.pageCount).toBe(2)

    const cacheStoreMock = jest.requireMock(
      '../../database/local-cache/localCacheStore',
    )
    expect(cacheStoreMock.__getWrites()).toHaveLength(0)
  })
})
