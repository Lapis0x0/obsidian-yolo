import type { DataAdapter, ListedFiles } from 'obsidian'

import { ModuleLifecycleScope } from './lifecycleScope'
import {
  MAX_MODULE_PRIVATE_BLOB_BYTES,
  MAX_MODULE_PRIVATE_JSON_DEPTH,
  MAX_MODULE_PRIVATE_JSON_NODES,
  MAX_MODULE_PRIVATE_KEY_DEPTH,
  MAX_MODULE_PRIVATE_LIST_DEPTH,
  MAX_MODULE_PRIVATE_LIST_ENTRIES,
  ModulePrivateStorageCapabilityProvider,
  ModulePrivateStorageVerificationError,
} from './modulePrivateStorage'

class MemoryAdapter {
  readonly files = new Map<string, string | ArrayBuffer>()
  readonly folders = new Set<string>()
  readonly existsChecks: string[] = []
  readonly reads: string[] = []
  readonly writes: string[] = []
  readonly lists: string[] = []
  writeHook?: (path: string, value: string | ArrayBuffer) => Promise<void>
  removeHook?: (path: string) => Promise<void>

  async exists(path: string): Promise<boolean> {
    this.existsChecks.push(path)
    return this.files.has(path) || this.folders.has(path)
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path)
  }

  async stat(path: string) {
    const value = this.files.get(path)
    if (typeof value === 'string') {
      return {
        type: 'file' as const,
        size: new TextEncoder().encode(value).length,
      }
    }
    if (value instanceof ArrayBuffer) {
      return { type: 'file' as const, size: value.byteLength }
    }
    if (this.folders.has(path)) return { type: 'folder' as const, size: 0 }
    const prefix = `${path}/`
    if ([...this.files.keys()].some((key) => key.startsWith(prefix))) {
      return { type: 'folder' as const, size: 0 }
    }
    return null
  }

  async list(path: string): Promise<ListedFiles> {
    this.lists.push(path)
    const prefix = `${path}/`
    const files: string[] = []
    const folders = new Set<string>()
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash === -1) files.push(key)
      else folders.add(`${path}/${rest.slice(0, slash)}`)
    }
    return { files, folders: [...folders] }
  }

  async read(path: string): Promise<string> {
    this.reads.push(path)
    const value = this.files.get(path)
    if (typeof value !== 'string') throw new Error(`Missing text: ${path}`)
    return value
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    this.reads.push(path)
    const value = this.files.get(path)
    if (!(value instanceof ArrayBuffer))
      throw new Error(`Missing bytes: ${path}`)
    return value.slice(0)
  }

  async write(path: string, value: string): Promise<void> {
    this.writes.push(path)
    if (this.writeHook) await this.writeHook(path, value)
    else this.files.set(path, value)
  }

  async writeBinary(path: string, value: ArrayBuffer): Promise<void> {
    this.writes.push(path)
    if (this.writeHook) await this.writeHook(path, value)
    else this.files.set(path, value.slice(0))
  }

  async remove(path: string): Promise<void> {
    if (this.removeHook) await this.removeHook(path)
    else this.files.delete(path)
  }
}

const asAdapter = (adapter: MemoryAdapter): DataAdapter =>
  adapter as unknown as DataAdapter

function createStorage(
  adapter: MemoryAdapter,
  moduleId = 'notes',
  getSyncRoot: () => string = () => 'sync/private',
) {
  const lifecycle = new ModuleLifecycleScope()
  const activation = new ModulePrivateStorageCapabilityProvider({
    synchronized: { adapter: asAdapter(adapter), getRootPath: getSyncRoot },
    deviceLocal: {
      adapter: asAdapter(adapter),
      getRootPath: () => 'local/private',
    },
  }).create(moduleId, lifecycle)
  return { activation, lifecycle }
}

describe('ModulePrivateStorageCapabilityProvider', () => {
  it('isolates modules and scopes while supporting text, binary, JSON, list, and remove', async () => {
    const adapter = new MemoryAdapter()
    const first = createStorage(adapter, 'notes')
    const second = createStorage(adapter, 'search')
    first.activation.activate()
    second.activation.activate()

    await first.activation.api.synchronized.writeText('cache/value.txt', 'one')
    await first.activation.api.synchronized.writeJson('state.json', {
      cursor: 3,
    })
    await first.activation.api.deviceLocal.writeBinary(
      'index.bin',
      new Uint8Array([1, 2, 3]).buffer,
    )
    await second.activation.api.synchronized.writeText('cache/value.txt', 'two')

    await expect(first.activation.api.synchronized.list()).resolves.toEqual([
      'cache/value.txt',
      'state.json',
    ])
    await expect(
      first.activation.api.synchronized.list('cache'),
    ).resolves.toEqual(['cache/value.txt'])
    const listCalls = adapter.lists.length
    await expect(
      first.activation.api.synchronized.list('state.json'),
    ).resolves.toEqual([])
    expect(adapter.lists).toHaveLength(listCalls)
    await expect(
      first.activation.api.synchronized.readText('cache/value.txt'),
    ).resolves.toBe('one')
    await expect(
      first.activation.api.synchronized.readJson('state.json'),
    ).resolves.toEqual({ cursor: 3 })
    expect(
      new Uint8Array(
        (await first.activation.api.deviceLocal.readBinary('index.bin'))!,
      ),
    ).toEqual(new Uint8Array([1, 2, 3]))
    expect(adapter.files.get('sync/private/notes/cache/value.txt')).toBe('one')
    expect(adapter.files.get('sync/private/search/cache/value.txt')).toBe('two')
    expect(adapter.files.has('local/private/notes/index.bin')).toBe(true)

    await first.activation.api.synchronized.remove('cache/value.txt')
    await expect(
      first.activation.api.synchronized.readText('cache/value.txt'),
    ).resolves.toBeNull()
  })

  it('rejects unsafe module ids, keys, roots, and metadata-like paths', async () => {
    const adapter = new MemoryAdapter()
    expect(() => createStorage(adapter, '../notes')).toThrow('path segment')
    const { activation } = createStorage(adapter)
    activation.activate()

    await expect(
      activation.api.synchronized.readText('../search/secret.json'),
    ).rejects.toThrow('safe relative path')
    await expect(
      activation.api.synchronized.readText('.metadata'),
    ).rejects.toThrow('path segment')
    await expect(
      activation.api.synchronized.readText('/absolute'),
    ).rejects.toThrow('safe relative path')

    expect(() => createStorage(adapter, 'other', () => '../private')).toThrow(
      'safe vault-relative path',
    )
    await expect(
      activation.api.synchronized.readText('Cache/value.txt'),
    ).rejects.toThrow('canonical lowercase')
    await expect(
      activation.api.synchronized.readText('cache\\value.txt'),
    ).rejects.toThrow('canonical lowercase')
    await expect(
      activation.api.synchronized.readText(
        Array.from(
          { length: MAX_MODULE_PRIVATE_KEY_DEPTH + 1 },
          () => 'x',
        ).join('/'),
      ),
    ).rejects.toThrow('depth limit')
  })

  it('snapshots a dynamic root once per operation', async () => {
    const adapter = new MemoryAdapter()
    let root = 'old/private'
    const getRoot = jest.fn(() => root)
    const { activation } = createStorage(adapter, 'notes', getRoot)
    activation.activate()

    adapter.writeHook = async (path, value) => {
      root = 'new/private'
      adapter.files.set(path, value)
    }
    await activation.api.synchronized.writeText('value.txt', 'old-root')
    expect(getRoot).toHaveBeenCalledTimes(2)
    expect(adapter.files.get('old/private/notes/value.txt')).toBe('old-root')
    expect(adapter.files.has('new/private/notes/value.txt')).toBe(false)

    adapter.writeHook = undefined
    await activation.api.synchronized.writeText('value.txt', 'new-root')
    expect(adapter.files.get('new/private/notes/value.txt')).toBe('new-root')
  })

  it('serializes process writes and verifies without rolling back conflicts', async () => {
    const adapter = new MemoryAdapter()
    const first = createStorage(adapter)
    const second = createStorage(adapter)
    first.activation.activate()
    second.activation.activate()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let calls = 0
    adapter.writeHook = async (path, value) => {
      calls += 1
      if (calls === 1) {
        started()
        await blocked
      }
      adapter.files.set(path, value)
    }

    const one = first.activation.api.synchronized.writeText('value.txt', 'one')
    await firstStarted
    const two = second.activation.api.synchronized.writeText('value.txt', 'two')
    await Promise.resolve()
    expect(calls).toBe(1)
    release()
    await Promise.all([one, two])
    expect(adapter.files.get('sync/private/notes/value.txt')).toBe('two')

    adapter.writeHook = async (path) => {
      adapter.files.set(path, 'external')
    }
    await expect(
      first.activation.api.synchronized.writeText('value.txt', 'ours'),
    ).rejects.toBeInstanceOf(ModulePrivateStorageVerificationError)
    expect(adapter.files.get('sync/private/notes/value.txt')).toBe('external')
    expect(adapter.writes.at(-1)).toBe('sync/private/notes/value.txt')
  })

  it('gates operations before activation and after lifecycle disposal', async () => {
    const adapter = new MemoryAdapter()
    const { activation, lifecycle } = createStorage(adapter)

    await expect(
      activation.api.synchronized.readText('value.txt'),
    ).rejects.toThrow('not active')
    activation.activate()
    await expect(
      activation.api.synchronized.writeText('value.txt', 'active'),
    ).resolves.toBeUndefined()
    lifecycle.dispose()
    await expect(
      activation.api.synchronized.readText('value.txt'),
    ).rejects.toThrow('no longer active')
  })

  it('rejects in-flight mutations after disposal without continuing verification', async () => {
    const adapter = new MemoryAdapter()
    const writeStorage = createStorage(adapter)
    writeStorage.activation.activate()
    let releaseWrite!: () => void
    let writeStarted!: () => void
    const writeBlocked = new Promise<void>(
      (resolve) => (releaseWrite = resolve),
    )
    const startedWrite = new Promise<void>(
      (resolve) => (writeStarted = resolve),
    )
    adapter.writeHook = async (path, value) => {
      writeStarted()
      await writeBlocked
      adapter.files.set(path, value)
    }
    const write = writeStorage.activation.api.synchronized.writeText(
      'value.txt',
      'written',
    )
    await startedWrite
    writeStorage.lifecycle.dispose()
    const readsBeforeWriteSettles = adapter.reads.length
    releaseWrite()
    await expect(write).rejects.toThrow('no longer active')
    expect(adapter.files.get('sync/private/notes/value.txt')).toBe('written')
    expect(adapter.reads).toHaveLength(readsBeforeWriteSettles)

    adapter.writeHook = undefined
    adapter.files.set('sync/private/notes/value.txt', 'existing')
    const removeStorage = createStorage(adapter)
    removeStorage.activation.activate()
    let releaseRemove!: () => void
    let removeStarted!: () => void
    const removeBlocked = new Promise<void>(
      (resolve) => (releaseRemove = resolve),
    )
    const startedRemove = new Promise<void>(
      (resolve) => (removeStarted = resolve),
    )
    adapter.removeHook = async (path) => {
      removeStarted()
      await removeBlocked
      adapter.files.delete(path)
    }
    const remove = removeStorage.activation.api.synchronized.remove('value.txt')
    await startedRemove
    removeStorage.lifecycle.dispose()
    const checksBeforeRemoveSettles = adapter.existsChecks.length
    releaseRemove()
    await expect(remove).rejects.toThrow('no longer active')
    expect(adapter.files.has('sync/private/notes/value.txt')).toBe(false)
    expect(adapter.existsChecks).toHaveLength(checksBeforeRemoveSettles)
  })

  it('enforces blob, JSON, list depth, and list entry limits', async () => {
    const adapter = new MemoryAdapter()
    const { activation } = createStorage(adapter)
    activation.activate()
    const oversizedText = 'x'.repeat(MAX_MODULE_PRIVATE_BLOB_BYTES + 1)

    expect(() =>
      activation.api.synchronized.writeText('large.txt', oversizedText),
    ).toThrow('byte limit')
    adapter.files.set('sync/private/notes/large.txt', oversizedText)
    const readsBeforeOversizedRead = adapter.reads.length
    await expect(
      activation.api.synchronized.readText('large.txt'),
    ).rejects.toThrow('byte limit')
    await expect(
      activation.api.synchronized.readJson('large.txt'),
    ).rejects.toThrow('byte limit')
    adapter.files.set(
      'sync/private/notes/large.bin',
      new ArrayBuffer(MAX_MODULE_PRIVATE_BLOB_BYTES + 1),
    )
    await expect(
      activation.api.synchronized.readBinary('large.bin'),
    ).rejects.toThrow('byte limit')
    expect(adapter.reads).toHaveLength(readsBeforeOversizedRead)

    let deep: unknown = null
    for (let index = 0; index <= MAX_MODULE_PRIVATE_JSON_DEPTH; index += 1) {
      deep = { child: deep }
    }
    expect(() =>
      activation.api.synchronized.writeJson('deep.json', deep),
    ).toThrow('depth limit')
    const manyNodes = Array.from(
      { length: MAX_MODULE_PRIVATE_JSON_NODES },
      () => null,
    )
    expect(() =>
      activation.api.synchronized.writeJson('many.json', manyNodes),
    ).toThrow('node limit')
    const toJSON = jest.fn(() => manyNodes)
    expect(() =>
      activation.api.synchronized.writeJson('generated.json', { toJSON }),
    ).toThrow('plain JSON')
    expect(toJSON).not.toHaveBeenCalled()

    const getter = jest.fn(() => 'secret')
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: getter,
    })
    expect(() =>
      activation.api.synchronized.writeJson('accessor.json', accessor),
    ).toThrow('plain JSON')
    expect(getter).not.toHaveBeenCalled()

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const customPrototype = Object.create({ inherited: true }) as Record<
      string,
      unknown
    >
    customPrototype.value = true
    const sparse = new Array(1)
    for (const invalid of [
      undefined,
      Symbol('value'),
      () => undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(),
      customPrototype,
      sparse,
      cyclic,
      { nested: undefined },
    ]) {
      expect(() =>
        activation.api.synchronized.writeJson('invalid.json', invalid),
      ).toThrow('plain JSON')
    }

    const objectToJSON = jest.fn(() => 'polluted')
    const arrayToJSON = jest.fn(() => 'polluted')
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value: objectToJSON,
    })
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      value: arrayToJSON,
    })
    try {
      await expect(
        activation.api.synchronized.writeJson('plain.json', {
          values: [1, true, null],
        }),
      ).resolves.toBeUndefined()
      await expect(
        activation.api.synchronized.readJson('plain.json'),
      ).resolves.toEqual({ values: [1, true, null] })
      expect(objectToJSON).not.toHaveBeenCalled()
      expect(arrayToJSON).not.toHaveBeenCalled()
    } finally {
      delete (Object.prototype as { toJSON?: unknown }).toJSON
      delete (Array.prototype as { toJSON?: unknown }).toJSON
    }
    adapter.files.set('sync/private/notes/deep.json', JSON.stringify(deep))
    await expect(
      activation.api.synchronized.readJson('deep.json'),
    ).rejects.toThrow('invalid')

    const tooDeep = Array.from(
      { length: MAX_MODULE_PRIVATE_LIST_DEPTH + 1 },
      () => 'd',
    ).join('/')
    adapter.files.set(`sync/private/notes/${tooDeep}/value.txt`, 'value')
    await expect(activation.api.synchronized.list()).rejects.toThrow(
      'depth limit',
    )

    adapter.files.clear()
    for (let index = 0; index <= MAX_MODULE_PRIVATE_LIST_ENTRIES; index += 1) {
      adapter.files.set(`sync/private/notes/file-${index}.txt`, 'value')
    }
    await expect(activation.api.synchronized.list()).rejects.toThrow(
      'entry limit',
    )
  })

  it('rejects static and dynamic overlap for roots on the same adapter', async () => {
    const adapter = new MemoryAdapter()
    expect(
      () =>
        new ModulePrivateStorageCapabilityProvider({
          synchronized: {
            adapter: asAdapter(adapter),
            getRootPath: () => 'private',
          },
          deviceLocal: {
            adapter: asAdapter(adapter),
            getRootPath: () => 'private/local',
          },
        }),
    ).toThrow('must not overlap')

    let localRoot = 'local/private'
    const lifecycle = new ModuleLifecycleScope()
    const activation = new ModulePrivateStorageCapabilityProvider({
      synchronized: {
        adapter: asAdapter(adapter),
        getRootPath: () => 'sync/private',
      },
      deviceLocal: {
        adapter: asAdapter(adapter),
        getRootPath: () => localRoot,
      },
    }).create('notes', lifecycle)
    activation.activate()
    localRoot = 'sync/private/nested'
    await expect(
      activation.api.synchronized.readText('value.txt'),
    ).rejects.toThrow('must not overlap')

    const otherAdapter = new MemoryAdapter()
    expect(
      () =>
        new ModulePrivateStorageCapabilityProvider({
          synchronized: {
            adapter: asAdapter(adapter),
            getRootPath: () => 'private',
          },
          deviceLocal: {
            adapter: asAdapter(otherAdapter),
            getRootPath: () => 'private',
          },
        }),
    ).not.toThrow()
  })
})
