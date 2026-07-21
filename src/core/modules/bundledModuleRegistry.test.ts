import {
  BundledModuleCatalogSource,
  parseBundledModuleIndex,
} from './bundledModuleRegistry'

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value))

const descriptorMetadata = (id: string, version: string) => ({
  hostApi: '^1.0.0',
  dataSchemas: {},
  platforms: ['desktop', 'mobile'],
  manifestUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-${id}-v${version}/module.json`,
})

const localizations = (name: string, description: string) => ({
  en: { name, description },
  zh: { name: `ZH ${name}`, description: `ZH ${description}` },
  it: { name: `IT ${name}`, description: `IT ${description}` },
})

const index = {
  schemaVersion: 1,
  modules: [
    {
      id: 'learning',
      version: '0.1.0',
      localizations: localizations('Learning', 'Learn from notes'),
      ...descriptorMetadata('learning', '0.1.0'),
      manifest: { byteSize: 100, sha256: 'a'.repeat(64) },
    },
    {
      id: 'second',
      version: '1.0.0',
      localizations: localizations('Second', 'Second description'),
      ...descriptorMetadata('second', '1.0.0'),
      manifest: { byteSize: 200, sha256: 'b'.repeat(64) },
    },
  ],
}

describe('BundledModuleCatalogSource', () => {
  it('projects the immutable bundled index as catalog candidates', async () => {
    const readBundledIndexBytes = jest.fn(async () => encode(index))
    const source = new BundledModuleCatalogSource({
      store: { readBundledIndexBytes },
      platform: 'desktop',
      locale: 'en',
    })

    await expect(source.load()).resolves.toEqual([
      {
        id: 'learning',
        version: '0.1.0',
        name: 'Learning',
        description: 'Learn from notes',
      },
      {
        id: 'second',
        version: '1.0.0',
        name: 'Second',
        description: 'Second description',
      },
    ])
    expect(source.getResolvedVersion('learning')).toEqual({
      version: '0.1.0',
      hostApi: '^1.0.0',
      dataSchemas: {},
      platforms: ['desktop', 'mobile'],
      manifestUrl:
        'https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-learning-v0.1.0/module.json',
      manifest: { byteSize: 100, sha256: 'a'.repeat(64) },
    })
    expect(
      source.getResolvedArtifactDescriptor('learning', '0.1.0', 'desktop'),
    ).toEqual({
      id: 'learning',
      version: '0.1.0',
      hostApi: '^1.0.0',
      dataSchemas: {},
      platform: 'desktop',
      manifestUrl:
        'https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-learning-v0.1.0/module.json',
      manifest: { byteSize: 100, sha256: 'a'.repeat(64) },
    })

    await source.load()
    expect(readBundledIndexBytes).toHaveBeenCalledTimes(1)
  })

  it('reads the current locale for every load', async () => {
    let locale: 'en' | 'zh' = 'en'
    const source = new BundledModuleCatalogSource({
      store: { readBundledIndexBytes: async () => encode(index) },
      platform: 'desktop',
      locale: () => locale,
    })

    expect((await source.load())[0]?.name).toBe('Learning')
    locale = 'zh'
    expect((await source.load())[0]?.name).toBe('ZH Learning')
  })

  it('publishes a platform issue instead of resolving an unsupported artifact', async () => {
    const source = new BundledModuleCatalogSource({
      store: {
        readBundledIndexBytes: async () =>
          encode({
            ...index,
            modules: [{ ...index.modules[0], platforms: ['desktop'] }],
          }),
      },
      platform: 'mobile',
      locale: 'en',
    })

    await expect(source.load()).resolves.toEqual([
      expect.objectContaining({
        id: 'learning',
        compatibilityIssues: [{ kind: 'platform' }],
      }),
    ])
    expect(source.getResolvedVersion('learning')).toBeUndefined()
    expect(
      source.getResolvedArtifactDescriptor('learning', '0.1.0', 'mobile'),
    ).toBeUndefined()
  })

  it('rejects stale candidates and a mismatched runtime platform', async () => {
    const source = new BundledModuleCatalogSource({
      store: { readBundledIndexBytes: async () => encode(index) },
      platform: 'desktop',
      locale: 'en',
    })
    await source.load()

    expect(() =>
      source.getResolvedArtifactDescriptor('learning', '0.0.9', 'desktop'),
    ).toThrow('resolved candidate changed')
    expect(() =>
      source.getResolvedArtifactDescriptor('learning', '0.1.0', 'mobile'),
    ).toThrow('platform desktop does not match mobile')
  })

  it('rejects malformed or duplicate descriptors', () => {
    expect(() =>
      parseBundledModuleIndex({ schemaVersion: 2, modules: [] }),
    ).toThrow('index is invalid')
    expect(() =>
      parseBundledModuleIndex({
        schemaVersion: 1,
        modules: [index.modules[0], index.modules[0]],
      }),
    ).toThrow('duplicate id')
    expect(() =>
      parseBundledModuleIndex({
        schemaVersion: 1,
        modules: [{ ...index.modules[0], id: '../learning' }],
      }),
    ).toThrow('path segment')
  })

  it('accepts an encoded release tag without changing the bundled preview', () => {
    const manifestUrl =
      'https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning%2Fv0.1.0/module.json'
    const parsed = parseBundledModuleIndex({
      schemaVersion: 1,
      modules: [{ ...index.modules[0], manifestUrl }],
    })
    expect(parsed.modules[0]?.manifestUrl).toBe(manifestUrl)
  })

  it.each(['learning/v0.1.0', 'learning%252Fv0.1.0', 'learning%2F..'])(
    'rejects unsafe bundled release tag form %s',
    (tag) => {
      expect(() =>
        parseBundledModuleIndex({
          schemaVersion: 1,
          modules: [
            {
              ...index.modules[0],
              manifestUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/${tag}/module.json`,
            },
          ],
        }),
      ).toThrow('compatibility metadata is invalid')
    },
  )

  it('strictly rejects unknown root and nested fields', () => {
    expect(() =>
      parseBundledModuleIndex({ ...index, unexpected: true }),
    ).toThrow('fields are invalid')
    expect(() =>
      parseBundledModuleIndex({
        ...index,
        modules: [{ ...index.modules[0], unexpected: true }],
      }),
    ).toThrow('fields are invalid')
    expect(() =>
      parseBundledModuleIndex({
        ...index,
        modules: [
          {
            ...index.modules[0],
            manifest: { ...index.modules[0].manifest, unexpected: true },
          },
        ],
      }),
    ).toThrow('fields are invalid')
    expect(() =>
      parseBundledModuleIndex({
        ...index,
        modules: [
          {
            ...index.modules[0],
            dataSchemas: {
              learning: {
                readMin: 0,
                readMax: 1,
                write: 1,
                unexpected: true,
              },
            },
          },
        ],
      }),
    ).toThrow('fields are invalid')
  })
})
