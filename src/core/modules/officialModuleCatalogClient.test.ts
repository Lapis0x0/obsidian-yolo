import type { DataAdapter, RequestUrlResponse, Stat } from 'obsidian'

import {
  OFFICIAL_MODULE_CATALOG_URL,
  OFFICIAL_MODULE_RELEASE_REPOSITORIES,
  OfficialModuleCatalogClient,
  type OfficialModuleCatalogClientOptions,
  OfficialModuleCatalogUnavailableError,
} from './officialModuleCatalogClient'

const CACHE_PATH = 'runtime/catalog/cache.json'
const HASH = 'a'.repeat(64)

function catalog(
  version = '1.0.0',
  repository = 'Lapis0x0/obsidian-yolo',
): string {
  return JSON.stringify({
    schemaVersion: 1,
    modules: [
      {
        id: 'learning',
        versions: [
          {
            version,
            hostApi: '>=1.0.0 <2.0.0',
            platforms: ['desktop'],
            dataSchemas: {
              learning: { readMin: 0, readMax: 1, write: 1 },
            },
            manifestUrl: `https://github.com/${repository}/releases/download/v${version}/module.json`,
            manifest: { byteSize: 10, sha256: HASH },
          },
        ],
      },
    ],
  })
}

function envelope(raw: string, fetchedAt: number, extra = {}): string {
  return JSON.stringify({ schemaVersion: 1, fetchedAt, catalog: raw, ...extra })
}

function response(
  text: string,
  status = 200,
  headers: Record<string, string> = {},
): RequestUrlResponse {
  return {
    status,
    headers,
    text,
    arrayBuffer: new ArrayBuffer(0),
    json: null,
  }
}

function fileStat(size: number): Stat {
  return { type: 'file', ctime: 0, mtime: 0, size }
}

class FakeAdapter {
  readonly files = new Map<string, string>()
  readonly directories = new Set<string>()
  readonly statPaths: string[] = []
  readonly readPaths: string[] = []
  readonly writes: Array<readonly [string, string]> = []
  statOverride: (() => Promise<Stat | null>) | null = null
  readOverride: (() => Promise<string>) | null = null
  mkdirOverride: (() => Promise<void>) | null = null
  writeOverride: (() => Promise<void>) | null = null

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path)
  }

  async stat(path: string): Promise<Stat | null> {
    this.statPaths.push(path)
    if (this.statOverride) return this.statOverride()
    const value = this.files.get(path)
    if (value !== undefined) {
      return fileStat(new TextEncoder().encode(value).byteLength)
    }
    if (this.directories.has(path)) {
      return { type: 'folder', ctime: 0, mtime: 0, size: 0 }
    }
    return null
  }

  async read(path: string): Promise<string> {
    this.readPaths.push(path)
    if (this.readOverride) return this.readOverride()
    const value = this.files.get(path)
    if (value === undefined) throw new Error('Missing file')
    return value
  }

  async mkdir(path: string): Promise<void> {
    if (this.mkdirOverride) return this.mkdirOverride()
    this.directories.add(path)
  }

  async write(path: string, value: string): Promise<void> {
    this.writes.push([path, value])
    if (this.writeOverride) await this.writeOverride()
    this.files.set(path, value)
  }
}

function options(
  adapter: FakeAdapter,
  overrides: Partial<OfficialModuleCatalogClientOptions> = {},
): OfficialModuleCatalogClientOptions {
  return {
    adapter: adapter as unknown as DataAdapter,
    cachePath: CACHE_PATH,
    timeoutMs: 100,
    cacheTtlMs: 1_000,
    now: () => 10_000,
    requestUrl: jest.fn(async () => response(catalog())),
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

describe('OfficialModuleCatalogClient', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('uses fixed code-owned catalog and release repository trust anchors', async () => {
    expect(OFFICIAL_MODULE_CATALOG_URL).toBe(
      'https://raw.githubusercontent.com/Lapis0x0/obsidian-yolo/main/modules/catalog-v1.json',
    )
    expect(OFFICIAL_MODULE_RELEASE_REPOSITORIES).toEqual([
      { owner: 'Lapis0x0', repo: 'obsidian-yolo' },
    ])
    expect(Object.isFrozen(OFFICIAL_MODULE_RELEASE_REPOSITORIES)).toBe(true)

    const adapter = new FakeAdapter()
    const request = jest.fn(async () => response(catalog()))
    await new OfficialModuleCatalogClient(
      options(adapter, { requestUrl: request }),
    ).load()
    expect(request).toHaveBeenCalledWith({
      url: OFFICIAL_MODULE_CATALOG_URL,
      method: 'GET',
      throw: false,
    })

    const untrusted = new OfficialModuleCatalogClient(
      options(new FakeAdapter(), {
        requestUrl: jest.fn(async () =>
          response(catalog('1.0.0', 'yolo-official/learning')),
        ),
      }),
    )
    await expect(untrusted.load()).rejects.toBeInstanceOf(
      OfficialModuleCatalogUnavailableError,
    )
  })

  it.each([
    '',
    '/absolute/cache.json',
    'C:/absolute/cache.json',
    'runtime\\cache.json',
    './runtime/cache.json',
    'runtime/../cache.json',
    'runtime//cache.json',
    'runtime/cache.json/',
    'runtime/cafe\u0301.json',
    'runtime/cache\0.json',
  ])('rejects unsafe or non-canonical cache path %p', (cachePath) => {
    expect(
      () =>
        new OfficialModuleCatalogClient(
          options(new FakeAdapter(), { cachePath }),
        ),
    ).toThrow(/cache path is invalid/)
  })

  it('uses the validated cache path consistently for stat, read, and write', async () => {
    const cachePath = 'données/catalog.json'
    const adapter = new FakeAdapter()
    adapter.files.set(cachePath, envelope(catalog('1.1.0'), 1))
    const client = new OfficialModuleCatalogClient(
      options(adapter, { cachePath }),
    )

    await client.load()
    await flushPromises()
    expect(adapter.statPaths).toEqual([cachePath])
    expect(adapter.readPaths).toEqual([cachePath])
    expect(adapter.writes[0]?.[0]).toBe(cachePath)
  })

  it('returns a fresh validated cache without requesting the network', async () => {
    const adapter = new FakeAdapter()
    adapter.files.set(CACHE_PATH, envelope(catalog('1.1.0'), 9_500))
    const request = jest.fn(async () => response(catalog()))
    const client = new OfficialModuleCatalogClient(
      options(adapter, { requestUrl: request }),
    )

    await expect(client.load()).resolves.toMatchObject({
      modules: [{ versions: [{ version: '1.1.0' }] }],
    })
    expect(request).not.toHaveBeenCalled()
    expect(adapter.writes).toHaveLength(0)
  })

  it.each([
    ['missing', null],
    ['folder', { type: 'folder', ctime: 0, mtime: 0, size: 1 } as Stat],
    ['oversized', fileStat(7_000_001)],
    ['negative size', fileStat(-1)],
  ])('does not read a %s cache after stat preflight', async (_label, stat) => {
    const adapter = new FakeAdapter()
    adapter.statOverride = async () => stat
    const request = jest.fn(async () => response(catalog('2.0.0')))

    await new OfficialModuleCatalogClient(
      options(adapter, { requestUrl: request }),
    ).load()
    expect(adapter.readPaths).toHaveLength(0)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['network rejection', () => Promise.reject(new Error('offline'))],
    ['non-2xx response', () => Promise.resolve(response('no', 300))],
    ['invalid remote catalog', () => Promise.resolve(response('{'))],
    [
      'oversized declared response',
      () =>
        Promise.resolve(
          response(catalog(), 200, { 'Content-Length': '1000001' }),
        ),
    ],
  ])('uses a validated stale cache after %s', async (_label, request) => {
    const adapter = new FakeAdapter()
    adapter.files.set(CACHE_PATH, envelope(catalog('1.1.0'), 1))
    const client = new OfficialModuleCatalogClient(
      options(adapter, { requestUrl: jest.fn(request) }),
    )

    await expect(client.load()).resolves.toMatchObject({
      modules: [{ versions: [{ version: '1.1.0' }] }],
    })
    expect(adapter.writes).toHaveLength(0)
  })

  it('accepts small clock skew but rejects cache timestamps too far ahead', async () => {
    const freshAdapter = new FakeAdapter()
    freshAdapter.files.set(CACHE_PATH, envelope(catalog('1.1.0'), 310_000))
    const freshRequest = jest.fn(async () => response(catalog()))
    await new OfficialModuleCatalogClient(
      options(freshAdapter, { requestUrl: freshRequest }),
    ).load()
    expect(freshRequest).not.toHaveBeenCalled()

    const futureAdapter = new FakeAdapter()
    futureAdapter.files.set(CACHE_PATH, envelope(catalog('1.1.0'), 310_001))
    const futureRequest = jest.fn(async () => response(catalog('2.0.0')))
    await expect(
      new OfficialModuleCatalogClient(
        options(futureAdapter, { requestUrl: futureRequest }),
      ).load(),
    ).resolves.toMatchObject({
      modules: [{ versions: [{ version: '2.0.0' }] }],
    })
    expect(futureRequest).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'throws',
      () => {
        throw new Error('clock failed')
      },
    ],
    ['is negative', () => -1],
    ['is fractional', () => 1.5],
    ['is infinite', () => Number.POSITIVE_INFINITY],
  ])('rejects stably before I/O when now() %s', async (_label, now) => {
    const adapter = new FakeAdapter()
    const request = jest.fn(async () => response(catalog()))
    const client = new OfficialModuleCatalogClient(
      options(adapter, { now, requestUrl: request }),
    )

    await expect(client.load()).rejects.toBeInstanceOf(
      OfficialModuleCatalogUnavailableError,
    )
    expect(adapter.statPaths).toHaveLength(0)
    expect(request).not.toHaveBeenCalled()
  })

  it.each([0, -1, 2_147_483_648, 1.5])(
    'rejects unsafe request timeout %p',
    (timeoutMs) => {
      expect(
        () =>
          new OfficialModuleCatalogClient(
            options(new FakeAdapter(), { timeoutMs }),
          ),
      ).toThrow(/options are invalid/)
    },
  )

  it('bounds a hanging cache read and continues to the network', async () => {
    jest.useFakeTimers()
    const adapter = new FakeAdapter()
    adapter.statOverride = async () => fileStat(10)
    adapter.readOverride = () => new Promise<string>(() => undefined)
    const request = jest.fn(async () => response(catalog('2.0.0')))
    const load = new OfficialModuleCatalogClient(
      options(adapter, { requestUrl: request }),
    ).load()

    await jest.advanceTimersByTimeAsync(999)
    expect(request).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    await expect(load).resolves.toMatchObject({
      modules: [{ versions: [{ version: '2.0.0' }] }],
    })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each(['mkdir', 'write'] as const)(
    'returns valid remote data without waiting for a hanging cache %s',
    async (operation) => {
      const adapter = new FakeAdapter()
      const pending = new Promise<void>(() => undefined)
      if (operation === 'mkdir') adapter.mkdirOverride = () => pending
      if (operation === 'write') {
        adapter.directories.add('runtime')
        adapter.directories.add('runtime/catalog')
        adapter.writeOverride = () => pending
      }

      await expect(
        new OfficialModuleCatalogClient(options(adapter)).load(),
      ).resolves.toMatchObject({ schemaVersion: 1 })
      await flushPromises()
      if (operation === 'write') expect(adapter.writes).toHaveLength(1)
    },
  )

  it('writes validated remote data in the background and handles write rejection', async () => {
    const adapter = new FakeAdapter()
    adapter.writeOverride = async () => {
      throw new Error('disk failure')
    }
    const client = new OfficialModuleCatalogClient(options(adapter))

    await expect(client.load()).resolves.toMatchObject({ schemaVersion: 1 })
    await flushPromises()
    expect(adapter.writes).toHaveLength(1)
  })

  it('writes a strict cache envelope in the background', async () => {
    const adapter = new FakeAdapter()
    const client = new OfficialModuleCatalogClient(options(adapter))

    await client.load()
    await flushPromises()
    expect([...adapter.directories]).toEqual(['runtime', 'runtime/catalog'])
    expect(JSON.parse(adapter.writes[0]?.[1] ?? '')).toEqual({
      schemaVersion: 1,
      fetchedAt: 10_000,
      catalog: catalog(),
    })
  })

  it('serializes successive writes so an older delayed catalog cannot win', async () => {
    const adapter = new FakeAdapter()
    adapter.directories.add('runtime')
    adapter.directories.add('runtime/catalog')
    const firstWrite = deferred<undefined>()
    let writeCount = 0
    adapter.writeOverride = () => {
      writeCount += 1
      return writeCount === 1 ? firstWrite.promise : Promise.resolve()
    }
    const request = jest
      .fn<Promise<RequestUrlResponse>, []>()
      .mockResolvedValueOnce(response(catalog('1.0.0')))
      .mockResolvedValueOnce(response(catalog('2.0.0')))
    const client = new OfficialModuleCatalogClient(
      options(adapter, { requestUrl: request }),
    )

    await expect(client.load()).resolves.toMatchObject({
      modules: [{ versions: [{ version: '1.0.0' }] }],
    })
    await flushPromises()
    expect(adapter.writes).toHaveLength(1)

    await expect(client.load()).resolves.toMatchObject({
      modules: [{ versions: [{ version: '2.0.0' }] }],
    })
    await flushPromises()
    expect(adapter.writes).toHaveLength(1)

    firstWrite.resolve(undefined)
    await flushPromises()
    expect(adapter.writes).toHaveLength(2)
    expect(JSON.parse(adapter.writes[1]?.[1] ?? '').catalog).toBe(
      catalog('2.0.0'),
    )
    expect(JSON.parse(adapter.files.get(CACHE_PATH) ?? '').catalog).toBe(
      catalog('2.0.0'),
    )
  })

  it('never inspects or writes a network response that completes after timeout', async () => {
    jest.useFakeTimers()
    const adapter = new FakeAdapter()
    const pending = deferred<RequestUrlResponse>()
    const client = new OfficialModuleCatalogClient(
      options(adapter, { requestUrl: () => pending.promise }),
    )
    const load = client.load()

    await jest.advanceTimersByTimeAsync(100)
    await expect(load).rejects.toBeInstanceOf(
      OfficialModuleCatalogUnavailableError,
    )

    let textReads = 0
    const lateResponse = response(catalog('2.0.0'))
    Object.defineProperty(lateResponse, 'text', {
      get: () => {
        textReads += 1
        return catalog('2.0.0')
      },
    })
    pending.resolve(lateResponse)
    await flushPromises()
    expect(textReads).toBe(0)
    expect(adapter.writes).toHaveLength(0)
  })

  it('rejects stably without a validated cache', async () => {
    const adapter = new FakeAdapter()
    adapter.files.set(CACHE_PATH, envelope('{', 1))
    const client = new OfficialModuleCatalogClient(
      options(adapter, {
        requestUrl: jest.fn(async () => {
          throw new Error('internal detail')
        }),
      }),
    )

    await expect(client.load()).rejects.toEqual(
      new OfficialModuleCatalogUnavailableError(),
    )
  })

  it('lets the parser enforce the body limit without a usable content-length', async () => {
    for (const headers of [{}, { 'content-length': 'unknown' }] as Record<
      string,
      string
    >[]) {
      const client = new OfficialModuleCatalogClient(
        options(new FakeAdapter(), {
          requestUrl: jest.fn(async () =>
            response(' '.repeat(1_000_001), 200, headers),
          ),
        }),
      )
      await expect(client.load()).rejects.toBeInstanceOf(
        OfficialModuleCatalogUnavailableError,
      )
    }
  })

  it('deduplicates concurrent loads and permits retry after settlement', async () => {
    const adapter = new FakeAdapter()
    const pending = deferred<RequestUrlResponse>()
    const request = jest
      .fn<Promise<RequestUrlResponse>, []>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(response(catalog('2.0.0')))
    const client = new OfficialModuleCatalogClient(
      options(adapter, { requestUrl: request }),
    )

    const first = client.load()
    const second = client.load()
    expect(second).toBe(first)
    await flushPromises()
    expect(request).toHaveBeenCalledTimes(1)
    pending.reject(new Error('offline'))
    await expect(first).rejects.toBeInstanceOf(
      OfficialModuleCatalogUnavailableError,
    )

    await expect(client.load()).resolves.toMatchObject({
      modules: [{ versions: [{ version: '2.0.0' }] }],
    })
    expect(request).toHaveBeenCalledTimes(2)
  })
})
