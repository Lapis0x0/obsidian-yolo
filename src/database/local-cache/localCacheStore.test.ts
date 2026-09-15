import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'

const DECLARED_SIZE_PREFIX = '#declared-size:'

jest.mock('../../utils/common/utf8-byte-length', () => {
  const actual = jest.requireActual<
    typeof import('../../utils/common/utf8-byte-length')
  >('../../utils/common/utf8-byte-length')
  return {
    utf8ByteLength: (text: string) => {
      const declared = /^#declared-size:(\d+)#/.exec(text)
      return declared ? Number(declared[1]) : actual.utf8ByteLength(text)
    },
  }
})

import {
  LOCAL_CACHE_MAX_BYTES,
  clearLocalCache,
  getLocalCacheUsageBytes,
  lookupImageDataUrls,
  lookupPdfText,
  resetLocalCacheStateForTests,
  startLegacyImageCacheImport,
  writeImageDataUrls,
  writePdfText,
} from './localCacheStore'

let namespaceCounter = 0

const createApp = () => {
  namespaceCounter += 1
  const suffix = String(namespaceCounter).padStart(12, '0')
  const namespaceId = `00000000-0000-4000-8000-${suffix}`
  const store = new Map<string, string>([
    ['yolo-module-device-local-database-namespace', namespaceId],
  ])
  return {
    loadLocalStorage: (key: string) => store.get(key) ?? null,
    saveLocalStorage: (key: string, value: string) => {
      store.set(key, value)
    },
  }
}

/**
 * A data URL the size measurement reports as `bytes` bytes. Budget tests need
 * hundreds of megabytes; allocating them for real makes the suite slow enough
 * to time out under a full parallel run.
 */
const dataUrlOfSize = (bytes: number): string =>
  `${DECLARED_SIZE_PREFIX}${bytes}#data:image/png;base64,AAAA`

const MB = 1024 * 1024

let now = 1_000
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetLocalCacheStateForTests()
  now = 1_000
  jest.spyOn(Date, 'now').mockImplementation(() => now)
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('localCacheStore', () => {
  it('reads back images and PDF text, and misses unknown keys', async () => {
    const app = createApp()
    await writeImageDataUrls(app, [
      {
        key: 'img',
        dataUrl: 'data:image/png;base64,AAAA',
        sourcePath: 'a.png',
      },
    ])
    await writePdfText(app, {
      key: 'pdf',
      sourcePath: 'book.pdf',
      pages: [{ page: 1, text: '你好' }],
    })

    const images = await lookupImageDataUrls(app, ['img', 'missing'])
    expect([...images]).toEqual([['img', 'data:image/png;base64,AAAA']])
    expect(await lookupPdfText(app, 'pdf')).toEqual([{ page: 1, text: '你好' }])
    expect(await lookupPdfText(app, 'missing')).toBeNull()
  })

  it('does not serve an entry of one kind to a lookup of the other', async () => {
    const app = createApp()
    await writePdfText(app, {
      key: 'shared',
      sourcePath: 'book.pdf',
      pages: [{ page: 1, text: 'text' }],
    })

    expect((await lookupImageDataUrls(app, ['shared'])).size).toBe(0)
  })

  it('counts usage in UTF-8 bytes and clears everything', async () => {
    const app = createApp()
    await writeImageDataUrls(app, [
      { key: 'img', dataUrl: dataUrlOfSize(100), sourcePath: 'a.png' },
    ])
    // '你好' is 6 bytes in UTF-8.
    await writePdfText(app, {
      key: 'pdf',
      sourcePath: 'book.pdf',
      pages: [{ page: 1, text: '你好' }],
    })

    expect(await getLocalCacheUsageBytes(app)).toBe(106)

    await clearLocalCache(app)
    expect(await getLocalCacheUsageBytes(app)).toBe(0)
    expect((await lookupImageDataUrls(app, ['img'])).size).toBe(0)
  })

  it('evicts least recently used entries once the budget is exceeded', async () => {
    const app = createApp()
    const third = Math.floor(LOCAL_CACHE_MAX_BYTES / 3)

    now = 1
    await writeImageDataUrls(app, [
      { key: 'oldest', dataUrl: dataUrlOfSize(third), sourcePath: 'a' },
    ])
    now = 2
    await writeImageDataUrls(app, [
      { key: 'middle', dataUrl: dataUrlOfSize(third), sourcePath: 'b' },
    ])
    now = 3
    // Reading `oldest` makes it the most recently used.
    await lookupImageDataUrls(app, ['oldest'])
    now = 4
    await writeImageDataUrls(app, [
      {
        key: 'newest',
        dataUrl: dataUrlOfSize(third + 10 * MB),
        sourcePath: 'c',
      },
    ])

    const found = await lookupImageDataUrls(app, ['oldest', 'middle', 'newest'])
    expect([...found.keys()].sort()).toEqual(['newest', 'oldest'])
    expect(await getLocalCacheUsageBytes(app)).toBeLessThanOrEqual(
      LOCAL_CACHE_MAX_BYTES,
    )
  })

  it('never stores an entry larger than the whole budget', async () => {
    const app = createApp()
    await writeImageDataUrls(app, [
      { key: 'kept', dataUrl: dataUrlOfSize(100), sourcePath: 'a' },
      {
        key: 'huge',
        dataUrl: dataUrlOfSize(LOCAL_CACHE_MAX_BYTES + 1),
        sourcePath: 'b',
      },
    ])

    const found = await lookupImageDataUrls(app, ['kept', 'huge'])
    expect([...found.keys()]).toEqual(['kept'])
  })

  it('keeps the budget when a single batch exceeds it', async () => {
    const app = createApp()
    const half = Math.floor(LOCAL_CACHE_MAX_BYTES / 2)
    await writeImageDataUrls(app, [
      { key: 'first', dataUrl: dataUrlOfSize(half + MB), sourcePath: 'a' },
      { key: 'second', dataUrl: dataUrlOfSize(half + MB), sourcePath: 'b' },
    ])

    expect(await getLocalCacheUsageBytes(app)).toBeLessThanOrEqual(
      LOCAL_CACHE_MAX_BYTES,
    )
    expect([
      ...(await lookupImageDataUrls(app, ['first', 'second'])).keys(),
    ]).toEqual(['second'])
  })

  describe('legacy image cache import', () => {
    it('imports most recently used entries first up to the budget, then cleans up', async () => {
      const app = createApp()
      const half = Math.floor(LOCAL_CACHE_MAX_BYTES / 2)
      const cleanup = jest.fn().mockResolvedValue(undefined)

      await startLegacyImageCacheImport(
        app,
        async () => [
          {
            key: 'old',
            dataUrl: dataUrlOfSize(half),
            sourcePath: 'a',
            lastAccessedAt: 1,
          },
          {
            key: 'recent',
            dataUrl: dataUrlOfSize(half),
            sourcePath: 'b',
            lastAccessedAt: 3,
          },
          {
            key: 'recent2',
            dataUrl: dataUrlOfSize(half),
            sourcePath: 'c',
            lastAccessedAt: 2,
          },
        ],
        cleanup,
      )

      const found = await lookupImageDataUrls(app, ['old', 'recent', 'recent2'])
      expect([...found.keys()].sort()).toEqual(['recent', 'recent2'])
      expect(cleanup).toHaveBeenCalledTimes(1)
    })

    it('makes lookups wait for the import instead of missing', async () => {
      const app = createApp()
      let releaseLoad: () => void = () => undefined
      const loadGate = new Promise<void>((resolve) => {
        releaseLoad = resolve
      })

      void startLegacyImageCacheImport(
        app,
        async () => {
          await loadGate
          return [
            {
              key: 'img',
              dataUrl: dataUrlOfSize(50),
              sourcePath: 'a',
              lastAccessedAt: 1,
            },
          ]
        },
        async () => undefined,
      )
      const lookup = lookupImageDataUrls(app, ['img'])
      releaseLoad()

      expect((await lookup).has('img')).toBe(true)
    })

    it('does not clean up when there was nothing to load', async () => {
      const app = createApp()
      const cleanup = jest.fn().mockResolvedValue(undefined)

      await startLegacyImageCacheImport(app, async () => null, cleanup)

      expect(cleanup).not.toHaveBeenCalled()
    })
  })
})
