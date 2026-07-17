import {
  BundledModuleRegistry,
  parseBundledModuleIndex,
} from './bundledModuleRegistry'

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value))

const index = {
  schemaVersion: 1,
  modules: [
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
      description: '',
    },
  ],
}

describe('BundledModuleRegistry', () => {
  it('publishes catalog and activation-backed installed states', async () => {
    const activate = jest.fn(async () => undefined)
    const load = jest.fn(async (entry: { id: string }) => ({
      id: entry.id,
      activate: () => undefined,
    }))
    const store = {
      readBundledIndexBytes: jest.fn(async () => encode(index)),
      readManifestBytes: jest.fn(async (id: string, version: string) =>
        encode({
          id,
          version,
          entry: { path: 'entry.js', byteSize: 3, sha256: 'a'.repeat(64) },
        }),
      ),
      readEntryBytes: jest.fn(async () => new Uint8Array([1, 2, 3])),
    }
    const registry = new BundledModuleRegistry({
      store,
      loader: { load },
      runtime: { activate },
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
    expect(store.readBundledIndexBytes).toHaveBeenCalledTimes(1)
    await registry.activateAll()
    expect(activate).toHaveBeenCalledTimes(2)
  })

  it('isolates a failed module and continues activating the remainder', async () => {
    const reportActivationError = jest.fn(() => {
      throw new Error('reporter failed')
    })
    const registry = new BundledModuleRegistry({
      store: {
        readBundledIndexBytes: async () => encode(index),
        readManifestBytes: async (id: string, version: string) =>
          encode({
            id,
            version,
            entry: {
              path: 'entry.js',
              byteSize: 1,
              sha256: 'b'.repeat(64),
            },
          }),
        readEntryBytes: async () => new Uint8Array([1]),
      },
      loader: {
        load: async (entry) => {
          if (entry.id === 'learning') throw new Error('entry is damaged')
          return { id: entry.id, activate: () => undefined }
        },
      },
      runtime: { activate: async () => undefined },
      reportActivationError,
    })

    await expect(registry.activateAll()).resolves.toBeUndefined()
    await expect(registry.installedStateSource.load()).resolves.toEqual([
      { id: 'learning', version: '0.1.0', error: 'entry is damaged' },
      { id: 'second', version: '1.0.0', active: true },
    ])
    expect(reportActivationError).toHaveBeenCalledWith(
      'learning',
      expect.objectContaining({ message: 'entry is damaged' }),
    )
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
})
