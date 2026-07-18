import {
  BundledModuleRegistry,
  parseBundledModuleIndex,
} from './bundledModuleRegistry'

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value))

const artifactManifest = (
  id: string,
  version: string,
  byteSize: number,
  sha256: string,
) => ({
  schemaVersion: 1,
  id,
  version,
  hostApi: '^1.0.0',
  dataSchemas: {},
  variants: ['desktop', 'mobile'].map((platform) => ({
    platform,
    entry: 'entry.js',
    files: [
      {
        role: 'entry',
        name: 'entry.js',
        path: 'entry.js',
        byteSize,
        sha256,
        url: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-${id}-v${version}/entry.js`,
        storage: 'module',
      },
    ],
  })),
})

const descriptorMetadata = (id: string, version: string) => ({
  hostApi: '^1.0.0',
  dataSchemas: {},
  platforms: ['desktop', 'mobile'],
  manifestUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-${id}-v${version}/module.json`,
})

const index = {
  schemaVersion: 1,
  modules: [
    {
      id: 'learning',
      version: '0.1.0',
      name: 'Learning',
      description: 'Learn from notes',
      ...descriptorMetadata('learning', '0.1.0'),
      manifest: {
        byteSize: encode(
          artifactManifest('learning', '0.1.0', 3, 'a'.repeat(64)),
        ).byteLength,
        sha256: 'c'.repeat(64),
      },
    },
    {
      id: 'second',
      version: '1.0.0',
      name: 'Second',
      description: '',
      ...descriptorMetadata('second', '1.0.0'),
      manifest: {
        byteSize: encode(artifactManifest('second', '1.0.0', 3, 'a'.repeat(64)))
          .byteLength,
        sha256: 'c'.repeat(64),
      },
    },
  ],
}

describe('BundledModuleRegistry', () => {
  const subtleCrypto = (entryByte: number) => ({
    digest: jest.fn(
      async (_algorithm: AlgorithmIdentifier, data: BufferSource) =>
        new Uint8Array(32).fill(data.byteLength > 3 ? 0xcc : entryByte).buffer,
    ),
  })

  it('publishes catalog and activation-backed installed states', async () => {
    const activate = jest.fn(async (definition: { id: string }) => {
      expect(registry.getVerifiedArtifact(definition.id)?.manifest.id).toBe(
        definition.id,
      )
    })
    const load = jest.fn(async (entry: { id: string }) => ({
      id: entry.id,
      activate: () => undefined,
    }))
    const store = {
      readBundledIndexBytes: jest.fn(async () => encode(index)),
      readReadyMarkerBytes: jest.fn(
        async (id: string, version: string, platform: string) =>
          encode({
            schemaVersion: 1,
            id,
            version,
            platform,
            manifestSha256: 'c'.repeat(64),
          }),
      ),
      readManifestBytes: jest.fn(async (id: string, version: string) =>
        encode(artifactManifest(id, version, 3, 'a'.repeat(64))),
      ),
      readEntryBytes: jest.fn(async () => new Uint8Array([1, 2, 3])),
      listVersionFiles: jest.fn(async () => [
        'entry.js',
        'module.json',
        `ready.desktop.${'c'.repeat(64)}.json`,
        `ready.mobile.${'c'.repeat(64)}.json`,
      ]),
    }
    const registry = new BundledModuleRegistry({
      store,
      platform: 'desktop',
      loader: { load },
      runtime: { activate },
      subtleCrypto: subtleCrypto(0xaa),
    })

    await expect(registry.catalogSource.load()).resolves.toEqual([
      expect.objectContaining({ id: 'learning', version: '0.1.0' }),
      expect.objectContaining({ id: 'second', version: '1.0.0' }),
    ])
    await expect(registry.installedStateSource.load()).resolves.toEqual([
      { id: 'learning', version: '0.1.0' },
      { id: 'second', version: '1.0.0' },
    ])

    await registry.activateAll()

    await expect(registry.installedStateSource.load()).resolves.toEqual([
      { id: 'learning', version: '0.1.0', active: true },
      { id: 'second', version: '1.0.0', active: true },
    ])
    expect(activate).toHaveBeenCalledTimes(2)
    expect(activate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 'learning' }),
      '0.1.0',
    )
    expect(activate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 'second' }),
      '1.0.0',
    )
    expect(registry.getVerifiedArtifact('learning')).toEqual(
      expect.objectContaining({
        manifest: expect.objectContaining({ id: 'learning' }),
      }),
    )
    expect(registry.getVerifiedArtifact('missing')).toBeUndefined()
    expect(store.readBundledIndexBytes).toHaveBeenCalledTimes(1)
    await registry.activateAll()
    expect(activate).toHaveBeenCalledTimes(2)
  })

  it('shares concurrent activation and requires only the activation seam', async () => {
    let releaseFirst!: () => void
    const firstActivation = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const activate = jest
      .fn<Promise<void>, [{ id: string }, string?]>()
      .mockImplementationOnce(() => {
        markFirstStarted()
        return firstActivation
      })
      .mockResolvedValueOnce(undefined)
    const registry = new BundledModuleRegistry({
      store: {
        readBundledIndexBytes: async () => encode(index),
        readReadyMarkerBytes: async (
          id: string,
          version: string,
          platform: string,
        ) =>
          encode({
            schemaVersion: 1,
            id,
            version,
            platform,
            manifestSha256: 'c'.repeat(64),
          }),
        readManifestBytes: async (id: string, version: string) =>
          encode(artifactManifest(id, version, 3, 'a'.repeat(64))),
        readEntryBytes: async () => new Uint8Array([1, 2, 3]),
        listVersionFiles: async () => [
          'entry.js',
          'module.json',
          `ready.desktop.${'c'.repeat(64)}.json`,
          `ready.mobile.${'c'.repeat(64)}.json`,
        ],
      },
      loader: {
        load: async (entry) => ({
          id: entry.id,
          activate: () => undefined,
        }),
      },
      platform: 'desktop',
      runtime: { activate },
      subtleCrypto: subtleCrypto(0xaa),
    })

    const first = registry.activateAll()
    const raced = registry.activateAll()
    expect(raced).toBe(first)
    await firstStarted
    expect(activate).toHaveBeenCalledTimes(1)
    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'learning' }),
      '0.1.0',
    )

    releaseFirst()
    await expect(Promise.all([first, raced])).resolves.toEqual([
      undefined,
      undefined,
    ])
    expect(activate).toHaveBeenCalledTimes(2)
    expect(activate).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'second' }),
      '1.0.0',
    )
  })

  it('isolates a failed module and continues activating the remainder', async () => {
    const reportActivationError = jest.fn(() => {
      throw new Error('reporter failed')
    })
    const registry = new BundledModuleRegistry({
      store: {
        readBundledIndexBytes: async () => encode(index),
        readReadyMarkerBytes: async (
          id: string,
          version: string,
          platform: string,
        ) =>
          encode({
            schemaVersion: 1,
            id,
            version,
            platform,
            manifestSha256: 'c'.repeat(64),
          }),
        readManifestBytes: async (id: string, version: string) =>
          encode(artifactManifest(id, version, 1, 'b'.repeat(64))),
        readEntryBytes: async () => new Uint8Array([1]),
        listVersionFiles: async () => [
          'entry.js',
          'module.json',
          `ready.desktop.${'c'.repeat(64)}.json`,
          `ready.mobile.${'c'.repeat(64)}.json`,
        ],
      },
      loader: {
        load: async (entry) => ({
          id: entry.id,
          activate: () => undefined,
        }),
      },
      platform: 'desktop',
      runtime: {
        activate: async (definition) => {
          if (definition.id === 'learning') {
            throw new Error('activation failed')
          }
        },
      },
      reportActivationError,
      subtleCrypto: subtleCrypto(0xbb),
    })

    await expect(registry.activateAll()).resolves.toBeUndefined()
    await expect(registry.installedStateSource.load()).resolves.toEqual([
      { id: 'learning', version: '0.1.0', error: 'activation failed' },
      { id: 'second', version: '1.0.0', active: true },
    ])
    expect(reportActivationError).toHaveBeenCalledWith(
      'learning',
      expect.objectContaining({ message: 'activation failed' }),
    )
    expect(registry.getVerifiedArtifact('learning')).toBeUndefined()
    expect(registry.getVerifiedArtifact('second')?.manifest.id).toBe('second')
  })

  it('activates the current mobile platform from a shared immutable closure', async () => {
    const load = jest.fn(async (entry: { id: string }) => ({
      id: entry.id,
      activate: () => undefined,
    }))
    const registry = new BundledModuleRegistry({
      platform: 'mobile',
      store: {
        readBundledIndexBytes: async () => encode(index),
        readReadyMarkerBytes: async (
          id: string,
          version: string,
          platform: string,
        ) =>
          encode({
            schemaVersion: 1,
            id,
            version,
            platform,
            manifestSha256: 'c'.repeat(64),
          }),
        readManifestBytes: async (id: string, version: string) =>
          encode(artifactManifest(id, version, 3, 'a'.repeat(64))),
        readEntryBytes: async () => new Uint8Array([1, 2, 3]),
        listVersionFiles: async () => [
          'entry.js',
          'module.json',
          `ready.desktop.${'c'.repeat(64)}.json`,
          `ready.mobile.${'c'.repeat(64)}.json`,
        ],
      },
      loader: { load },
      runtime: { activate: async () => undefined },
      subtleCrypto: subtleCrypto(0xaa),
    })

    await registry.activateAll()

    expect(load).toHaveBeenCalledTimes(2)
    expect(registry.getVerifiedArtifact('learning')?.variant.platform).toBe(
      'mobile',
    )
  })

  it('reports a bundled module unsupported on the runtime platform without verification', async () => {
    const desktopOnly = {
      ...index,
      modules: [{ ...index.modules[0], platforms: ['desktop'] }],
    }
    const readManifestBytes = jest.fn()
    const registry = new BundledModuleRegistry({
      platform: 'mobile',
      store: {
        readBundledIndexBytes: async () => encode(desktopOnly),
        readReadyMarkerBytes: jest.fn(),
        readManifestBytes,
        readEntryBytes: jest.fn(),
        listVersionFiles: jest.fn(),
      },
      loader: { load: jest.fn() },
      runtime: { activate: jest.fn() },
      subtleCrypto: subtleCrypto(0xaa),
    })

    await registry.activateAll()

    await expect(registry.installedStateSource.load()).resolves.toEqual([
      {
        id: 'learning',
        version: '0.1.0',
        error: 'Bundled module "learning" does not support mobile',
      },
    ])
    expect(readManifestBytes).not.toHaveBeenCalled()
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
    expect(index.modules[0].manifestUrl).toContain(
      '/module-learning-v0.1.0/module.json',
    )
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
