import { RemoteImageSizes, remoteImageKey } from './remoteImageSizes'

const storage = () => {
  const files = new Map<string, unknown>()
  return {
    files,
    scope: {
      readJson: async (key: string) => files.get(key) ?? null,
      writeJson: async (key: string, value: unknown) => {
        files.set(key, value)
      },
    } as unknown as YoloModuleHostApiV1['privateStorage']['deviceLocal'],
  }
}

describe('RemoteImageSizes', () => {
  test('an image is kept by its address without a fragment', () => {
    expect(remoteImageKey('https://a.b/640?x=1#imgIndex=0')).toBe(
      'https://a.b/640?x=1',
    )
  })

  test('learns a size the browser found, and tells whoever listens', () => {
    const sizes = new RemoteImageSizes(storage().scope, () => undefined)
    const heard: string[] = []
    sizes.subscribe((key) => heard.push(key))
    expect(sizes.get('https://a.b/i')).toBeNull()
    const before = sizes.revision
    sizes.learn('https://a.b/i#x', { w: 640, h: 480 })
    expect(sizes.get('https://a.b/i')).toEqual({ w: 640, h: 480 })
    expect(heard).toEqual(['https://a.b/i'])
    expect(sizes.revision).toBeGreaterThan(before)
    // The same again changes nothing.
    sizes.learn('https://a.b/i', { w: 640, h: 480 })
    expect(heard).toHaveLength(1)
    sizes.dispose()
  })
})
