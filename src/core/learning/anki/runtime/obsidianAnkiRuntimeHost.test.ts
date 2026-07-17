import { type DataAdapter, requestUrl } from 'obsidian'

import {
  createObsidianAnkiRuntimeHost,
  resolveAnkiRuntimeRoot,
} from './obsidianAnkiRuntimeHost'

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>

describe('Obsidian Anki runtime host', () => {
  beforeEach(() => mockedRequestUrl.mockReset())

  it('roots storage at a custom plugin directory or the config fallback', async () => {
    const exists = jest.fn(async () => false)
    const adapter = { exists } as unknown as DataAdapter
    const custom = createObsidianAnkiRuntimeHost({
      adapter,
      manifest: { id: 'yolo', dir: 'custom\\plugin' },
      configDir: '.config',
    })

    await custom.storage.exists('version/sql-wasm.wasm')

    expect(exists).toHaveBeenCalledWith(
      'custom/plugin/runtime/anki-sqlite/version/sql-wasm.wasm',
    )
    expect(resolveAnkiRuntimeRoot({ id: 'yolo' }, '.config')).toBe(
      '.config/plugins/yolo/runtime/anki-sqlite',
    )
    expect(resolveAnkiRuntimeRoot({ id: 'yolo', dir: '' }, '.config')).toBe(
      '.config/plugins/yolo/runtime/anki-sqlite',
    )
    expect(
      resolveAnkiRuntimeRoot({ id: 'yolo', dir: 'custom/plugin' }, '../unused'),
    ).toBe('custom/plugin/runtime/anki-sqlite')
  })

  it('rejects absolute and traversal paths before calling the adapter', async () => {
    const exists = jest.fn(async () => false)
    const host = createObsidianAnkiRuntimeHost({
      adapter: { exists } as unknown as DataAdapter,
      manifest: { id: 'yolo' },
      configDir: '.config',
    })

    await expect(host.storage.exists('../escape')).rejects.toThrow(
      'safe vault-relative path',
    )
    await expect(host.storage.exists('/escape')).rejects.toThrow(
      'safe vault-relative path',
    )
    expect(exists).not.toHaveBeenCalled()
  })

  it.each([
    { manifest: { id: 'yolo', dir: '../plugin' }, configDir: '.config' },
    { manifest: { id: 'yolo', dir: '/plugin' }, configDir: '.config' },
    { manifest: { id: 'yolo', dir: 'C:\\plugin' }, configDir: '.config' },
    { manifest: { id: 'yolo', dir: 'C:plugin' }, configDir: '.config' },
    { manifest: { id: 'yolo', dir: 'plugins//yolo' }, configDir: '.config' },
    { manifest: { id: 'yolo' }, configDir: '../config' },
    { manifest: { id: 'yolo' }, configDir: '/config' },
    { manifest: { id: 'yolo' }, configDir: 'config/./nested' },
  ])('rejects unsafe plugin or config roots: $manifest.dir $configDir', (options) => {
    expect(() =>
      createObsidianAnkiRuntimeHost({
        adapter: {} as DataAdapter,
        ...options,
      }),
    ).toThrow('safe vault-relative path')
  })

  it('renames only within the resolved runtime root', async () => {
    const rename = jest.fn(async () => undefined)
    const host = createObsidianAnkiRuntimeHost({
      adapter: { rename } as unknown as DataAdapter,
      manifest: { id: 'yolo' },
      configDir: '.config',
    })

    await host.storage.rename('.tmp-v1', 'v1')

    expect(rename).toHaveBeenCalledWith(
      '.config/plugins/yolo/runtime/anki-sqlite/.tmp-v1',
      '.config/plugins/yolo/runtime/anki-sqlite/v1',
    )
  })

  it('serializes separate hosts for the same adapter and runtime root', async () => {
    const adapter = {} as DataAdapter
    const firstHost = createObsidianAnkiRuntimeHost({
      adapter,
      manifest: { id: 'yolo' },
      configDir: '.config',
    })
    const secondHost = createObsidianAnkiRuntimeHost({
      adapter,
      manifest: { id: 'yolo' },
      configDir: '.config',
    })
    const order: string[] = []
    let release!: () => void
    let markStarted!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })

    const first = firstHost.runExclusive(async () => {
      order.push('first-start')
      markStarted()
      await gate
      order.push('first-end')
    })
    const second = secondHost.runExclusive(async () => {
      order.push('second')
    })
    await started
    expect(order).toEqual(['first-start'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })

  it('downloads array buffers through requestUrl and reports HTTP errors', async () => {
    const bytes = Uint8Array.from([4, 2]).buffer
    mockedRequestUrl.mockResolvedValueOnce({
      status: 200,
      arrayBuffer: bytes,
    } as Awaited<ReturnType<typeof requestUrl>>)
    const host = createObsidianAnkiRuntimeHost({
      adapter: {} as DataAdapter,
      manifest: { id: 'yolo' },
      configDir: '.config',
    })

    await expect(host.downloadArrayBuffer('https://example.test')).resolves.toEqual(
      bytes,
    )
    expect(mockedRequestUrl).toHaveBeenCalledWith({
      url: 'https://example.test',
      method: 'GET',
      throw: false,
    })

    mockedRequestUrl.mockResolvedValueOnce({
      status: 503,
      arrayBuffer: new ArrayBuffer(0),
    } as Awaited<ReturnType<typeof requestUrl>>)
    await expect(
      host.downloadArrayBuffer('https://example.test/fail'),
    ).rejects.toThrow('HTTP 503')
  })
})
