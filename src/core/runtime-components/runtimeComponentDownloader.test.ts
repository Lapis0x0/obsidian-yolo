import {
  RUNTIME_COMPONENT_SOURCE_TIMEOUT_MS,
  createRuntimeComponentDownloader,
} from './runtimeComponentDownloader'

const descriptor = {
  id: 'tokenizer',
  platforms: ['desktop', 'mobile'],
  nameKey: 'name',
  descriptionKey: 'description',
  impactKey: 'impact',
  entry: 'runtime-components/tokenizer/dist/entry.js',
  byteSize: 3,
  sha256: 'a'.repeat(64),
} as const

describe('runtime component downloader', () => {
  it('uses the shared 30 second source timeout', () => {
    expect(RUNTIME_COMPONENT_SOURCE_TIMEOUT_MS).toBe(30_000)
  })

  it('downloads a successful source', async () => {
    const requestUrl = jest.fn(async () => ({
      status: 200,
      headers: {},
      arrayBuffer: new Uint8Array([1, 2, 3]).buffer,
    }))
    const download = createRuntimeComponentDownloader({
      requestUrl: requestUrl as never,
      timeoutMs: 100,
    })

    await expect(
      download({
        descriptor,
        source: 'https://updates.yoloapp.dev/component.js',
      }),
    ).resolves.toEqual(new Uint8Array([1, 2, 3]))
  })

  it('rejects a source after its timeout', async () => {
    const download = createRuntimeComponentDownloader({
      requestUrl: (() => new Promise(() => undefined)) as never,
      timeoutMs: 10,
    })

    await expect(
      download({
        descriptor,
        source: 'https://updates.yoloapp.dev/component.js',
      }),
    ).rejects.toThrow('timed out after 10 ms')
  })
})
