import { RemoteImages, remoteImageKey } from './remoteImages'

type Scope = YoloModuleHostApiV1['privateStorage']['deviceLocal']
type Network = Pick<YoloModuleHostApiV1['network'], 'requestBinary'>

const storage = (initial: Record<string, unknown> = {}) => {
  const files = new Map<string, unknown>(Object.entries(initial))
  return {
    files,
    scope: {
      readJson: async (key: string) => files.get(key) ?? null,
      writeJson: async (key: string, value: unknown) => {
        files.set(key, value)
      },
      readBinary: async (key: string) =>
        (files.get(key) as ArrayBuffer | undefined) ?? null,
      writeBinary: async (key: string, value: ArrayBuffer) => {
        files.set(key, value)
      },
      removeFile: async (key: string) => files.delete(key),
    } as unknown as Scope,
  }
}

const png = (bytes = 3): Network['requestBinary'] =>
  jest.fn(async () => ({
    contentType: 'image/png',
    body: new Uint8Array(bytes).fill(7).buffer,
  }))

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('RemoteImages', () => {
  test('an image is kept by its address without a fragment', () => {
    expect(remoteImageKey('https://a.b/640?x=1#imgIndex=0')).toBe(
      'https://a.b/640?x=1',
    )
  })

  test('an image the browser showed: its size at once, its bytes fetched once', async () => {
    const { scope } = storage()
    const requestBinary = png()
    const images = new RemoteImages(scope, { requestBinary }, () => undefined)
    images.load()
    await settle()
    const heard: string[] = []
    images.subscribe((key) => heard.push(key))
    expect(images.get('https://a.b/i')).toBeNull()
    const before = images.revision
    images.shown('https://a.b/i#x', { w: 640, h: 480 })
    expect(images.get('https://a.b/i')).toEqual({ w: 640, h: 480 })
    expect(images.revision).toBeGreaterThan(before)
    expect(images.kept('https://a.b/i')).toBe(false)
    await settle()
    expect(requestBinary).toHaveBeenCalledWith('https://a.b/i')
    expect(images.kept('https://a.b/i')).toBe(true)
    expect([...new Uint8Array(await images.bytes('https://a.b/i'))]).toEqual([
      7, 7, 7,
    ])
    // Size learned, then bytes kept.
    expect(heard).toEqual(['https://a.b/i', 'https://a.b/i'])
    images.shown('https://a.b/i', { w: 640, h: 480 })
    await settle()
    expect(requestBinary).toHaveBeenCalledTimes(1)
    images.dispose()
  })

  test('nothing is fetched before the browser shows an image', async () => {
    const requestBinary = png()
    const images = new RemoteImages(
      storage().scope,
      { requestBinary },
      () => undefined,
    )
    images.load()
    await settle()
    expect(images.get('https://a.b/i')).toBeNull()
    await expect(images.bytes('https://a.b/i')).rejects.toThrow()
    expect(requestBinary).not.toHaveBeenCalled()
    images.dispose()
  })

  test('what is not an image, or not there, is not kept, nor asked again', async () => {
    const requestBinary = jest
      .fn<ReturnType<Network['requestBinary']>, [string]>()
      .mockResolvedValueOnce({
        contentType: 'text/html',
        body: new ArrayBuffer(4),
      })
      .mockRejectedValueOnce(new Error('offline'))
    const images = new RemoteImages(
      storage().scope,
      { requestBinary },
      () => undefined,
    )
    images.load()
    await settle()
    images.shown('https://a.b/page', { w: 10, h: 10 })
    images.shown('https://a.b/gone', { w: 10, h: 10 })
    await settle()
    expect(images.kept('https://a.b/page')).toBe(false)
    expect(images.kept('https://a.b/gone')).toBe(false)
    images.shown('https://a.b/gone', { w: 10, h: 10 })
    await settle()
    expect(requestBinary).toHaveBeenCalledTimes(2)
    images.dispose()
  })

  test('what was kept is read back; bytes gone from under it are forgotten', async () => {
    const first = storage()
    const images = new RemoteImages(
      first.scope,
      { requestBinary: png() },
      () => undefined,
    )
    images.load()
    await settle()
    images.shown('https://a.b/i', { w: 4, h: 2 })
    await settle()
    images.dispose()
    await settle()

    const again = new RemoteImages(
      first.scope,
      { requestBinary: png() },
      () => undefined,
    )
    again.load()
    await settle()
    expect(again.get('https://a.b/i')).toEqual({ w: 4, h: 2 })
    expect(again.kept('https://a.b/i')).toBe(true)
    for (const key of [...first.files.keys()]) {
      if (!key.endsWith('index.json')) first.files.delete(key)
    }
    await expect(again.bytes('https://a.b/i')).rejects.toThrow()
    expect(again.kept('https://a.b/i')).toBe(false)
    expect(again.get('https://a.b/i')).toEqual({ w: 4, h: 2 })
    again.dispose()
  })
})
