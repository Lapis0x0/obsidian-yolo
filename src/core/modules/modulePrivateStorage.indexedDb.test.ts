import { IDBFactory } from 'fake-indexeddb'

import { IndexedDbDataAdapter } from './indexedDbDataAdapter'
import { ModuleLifecycleScope } from './lifecycleScope'
import { ModulePrivateStorageCapabilityProvider } from './modulePrivateStorage'

const NAMESPACE = '33333333-3333-4333-8333-333333333333'

class FakeAppLocalStorage {
  readonly values = new Map<string, unknown>()

  loadLocalStorage(key: string): unknown {
    return this.values.get(key) ?? null
  }

  saveLocalStorage(key: string, value: unknown): void {
    this.values.set(key, value)
  }
}

function createStorage() {
  const adapter = new IndexedDbDataAdapter(new FakeAppLocalStorage(), {
    indexedDB: new IDBFactory(),
    createNamespaceId: () => NAMESPACE,
  })
  const lifecycle = new ModuleLifecycleScope()
  const activation = new ModulePrivateStorageCapabilityProvider({
    synchronized: {
      adapter,
      getRootPath: () => 'sync/private',
    },
    deviceLocal: {
      adapter,
      getRootPath: () => 'local/private',
    },
  }).create('anki', lifecycle)
  activation.activate()
  return { adapter, lifecycle, storage: activation.api.deviceLocal }
}

describe('ModulePrivateStorageCapabilityProvider with IndexedDbDataAdapter', () => {
  it('creates, writes, renames, and recursively removes an Anki runtime tree', async () => {
    const { adapter, lifecycle, storage } = createStorage()
    try {
      await storage.mkdir('runtime/empty')
      await storage.writeText('runtime/config.json', '{"version":1}')
      await storage.writeBinary(
        'runtime/sqlite/sqlite.wasm',
        new Uint8Array([1, 2, 3]).buffer,
      )

      await storage.rename('runtime', 'runtime-next')

      await expect(storage.stat('runtime')).resolves.toBeNull()
      await expect(storage.listEntries('runtime-next')).resolves.toEqual({
        files: ['runtime-next/config.json'],
        folders: ['runtime-next/empty', 'runtime-next/sqlite'],
      })
      await expect(
        storage.readBinary('runtime-next/sqlite/sqlite.wasm'),
      ).resolves.toEqual(new Uint8Array([1, 2, 3]).buffer)
      await expect(storage.removeFile('runtime-next')).rejects.toThrow(
        'requires a file',
      )

      await storage.remove('runtime-next')

      await expect(storage.stat('runtime-next')).resolves.toBeNull()
      await expect(
        storage.readBinary('runtime-next/sqlite/sqlite.wasm'),
      ).resolves.toBeNull()
    } finally {
      lifecycle.dispose()
      adapter.close()
    }
  })

  it('preserves both trees when a directory rename conflicts', async () => {
    const { adapter, lifecycle, storage } = createStorage()
    try {
      await storage.writeText('runtime/state.json', 'source')
      await storage.writeText('archive/state.json', 'destination')

      await expect(storage.rename('runtime', 'archive')).rejects.toThrow(
        'destination already exists',
      )

      await expect(storage.readText('runtime/state.json')).resolves.toBe(
        'source',
      )
      await expect(storage.readText('archive/state.json')).resolves.toBe(
        'destination',
      )
    } finally {
      lifecycle.dispose()
      adapter.close()
    }
  })

  it('serializes a directory rename with concurrent descendant writes', async () => {
    const { adapter, lifecycle, storage } = createStorage()
    try {
      await storage.writeText('runtime/state.json', 'old')

      const rename = storage.rename('runtime', 'archive')
      const writeSource = storage.writeText('runtime/new.json', 'source-new')
      const writeDestination = storage.writeText(
        'archive/added.json',
        'destination-new',
      )
      await Promise.all([rename, writeSource, writeDestination])

      await expect(storage.readText('archive/state.json')).resolves.toBe('old')
      await expect(storage.readText('runtime/new.json')).resolves.toBe(
        'source-new',
      )
      await expect(storage.readText('archive/added.json')).resolves.toBe(
        'destination-new',
      )
    } finally {
      lifecycle.dispose()
      adapter.close()
    }
  })
})
