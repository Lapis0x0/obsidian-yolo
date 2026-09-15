jest.mock('../../database/local-cache/localCacheStore', () => {
  const cache: Record<string, { page: number; text: string }[]> = {}
  return {
    __esModule: true,
    buildPdfTextCacheKey: jest.fn(
      (vaultPath: string, mtime: number, size: number) =>
        `f:${vaultPath}:${mtime}:${size}`,
    ),
    buildPdfTextCacheKeyFromContent: jest.fn(
      (base64: string) => `c:${base64.length}:${base64.slice(0, 8)}`,
    ),
    lookupPdfText: jest.fn(
      async (_app: unknown, key: string) => cache[key] ?? null,
    ),
    writePdfText: jest.fn(
      async (
        _app: unknown,
        entry: { key: string; pages: { page: number; text: string }[] },
      ) => {
        cache[entry.key] = entry.pages
      },
    ),
    __resetCache: () => {
      for (const k of Object.keys(cache)) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- test-only helper resetting an internal Record
        delete cache[k]
      }
    },
  }
})

// The build-time inlined worker source isn't available in Jest — supply an
// empty string so pdfjsLoader's Blob URL construction is a no-op.
jest.mock(
  'virtual:pdfjs-worker-script',
  () => ({ __esModule: true, default: '' }),
  { virtual: true },
)

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

import { extractPdfText, extractPdfTextFromBase64 } from './extractPdfText'

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

describe('extractPdfTextFromBase64', () => {
  it('extracts pages from base64 input without touching the cache when useCache is omitted', async () => {
    const app = { vault: { adapter: {} } }
    // Tiny valid-looking base64 — content is irrelevant because pdfjs is mocked.
    const { pages } = await extractPdfTextFromBase64(
      app as never,
      'JVBERi0xLjQK',
    )
    expect(pages).toHaveLength(1)
    expect(pages[0]?.text).toContain('Hello')
  })

  it('serves cached pages on key hit, skipping pdfjs entirely', async () => {
    const cacheStoreMock = jest.requireMock(
      '../../database/local-cache/localCacheStore',
    )
    cacheStoreMock.__resetCache()
    cacheStoreMock.lookupPdfText.mockClear()
    cacheStoreMock.writePdfText.mockClear()

    const app = { vault: {} }

    // First call: cache miss → runs pdfjs (mocked) → writes entry.
    const first = await extractPdfTextFromBase64(app as never, 'JVBERi0xLjQK', {
      useCache: true,
      sourceLabel: 'upload:test.pdf',
    })
    expect(first.pages).toHaveLength(1)
    expect(cacheStoreMock.writePdfText).toHaveBeenCalledTimes(1)

    // Make pdfjs throw on next invocation — second call must come from cache.
    const pdfjs = jest.requireMock('pdfjs-dist')
    pdfjs.getDocument.mockImplementationOnce(() => {
      throw new Error('pdfjs should not be invoked on cache hit')
    })

    const second = await extractPdfTextFromBase64(
      app as never,
      'JVBERi0xLjQK',
      {
        useCache: true,
        sourceLabel: 'upload:test.pdf',
      },
    )
    expect(second.pages).toEqual(first.pages)
    // Still only one write — second call was a hit.
    expect(cacheStoreMock.writePdfText).toHaveBeenCalledTimes(1)
    expect(cacheStoreMock.lookupPdfText).toHaveBeenCalledTimes(2)
  })
})
