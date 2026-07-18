import { IDBFactory } from 'fake-indexeddb'

import { IndexedDbDataAdapter } from './indexedDbDataAdapter'
import {
  type ModuleDeviceState,
  ModuleDeviceStateCorruptionError,
  ModuleDeviceStateStore,
} from './moduleDeviceStateStore'

class MemoryAdapter {
  readonly files = new Map<string, string>()
  readonly folders = new Set<string>()
  writes = 0
  writeHook?: (path: string, data: string) => Promise<void>

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path)
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path)
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path)
    if (value === undefined) throw new Error(`Missing file: ${path}`)
    return value
  }

  async write(path: string, data: string): Promise<void> {
    this.writes += 1
    if (this.writeHook) await this.writeHook(path, data)
    else this.files.set(path, data)
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path)
  }
}

const ROOT = 'device/module-state'
const PATH = `${ROOT}/learning.json`
const HASH = 'a'.repeat(64)

function createStore(adapter = new MemoryAdapter()): ModuleDeviceStateStore {
  return new ModuleDeviceStateStore({
    kind: 'device-local-runtime-state',
    adapter,
    rootPath: ROOT,
  })
}

function state(): ModuleDeviceState {
  return {
    moduleId: 'learning',
    platform: 'desktop',
    activeVersion: '1.2.3',
    downloadedCandidate: '2.0.0-beta.1',
    pendingVersion: null,
    readyVersions: {
      '1.2.3': descriptor('1.2.3'),
      '2.0.0-beta.1': descriptor('2.0.0-beta.1'),
    },
  }
}

function descriptor(version: string) {
  return {
    id: 'learning',
    version,
    hostApi: '^1.0.0',
    dataSchemas: {
      cards: { readMin: 1, readMax: 3, write: 2 },
    },
    platform: 'desktop' as const,
    manifestUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning-v${version}/module.json`,
    manifest: { byteSize: 42, sha256: HASH },
  }
}

function rawData(value: unknown, schemaVersion = 1): string {
  return JSON.stringify({ schemaVersion, data: value })
}

describe('ModuleDeviceStateStore', () => {
  it('reads empty state, writes a v1 snapshot, and removes it', async () => {
    const adapter = new MemoryAdapter()
    const store = createStore(adapter)

    await expect(store.read('learning')).resolves.toBeNull()
    await expect(store.remove('learning')).resolves.toBeUndefined()
    await expect(store.write(state())).resolves.toEqual(state())
    expect(JSON.parse(adapter.files.get(PATH) ?? '')).toMatchObject({
      schemaVersion: 1,
      data: { moduleId: 'learning', platform: 'desktop' },
    })
    await expect(store.read('learning')).resolves.toEqual(state())
    await expect(store.remove('learning')).resolves.toBeUndefined()
    expect(adapter.files.has(PATH)).toBe(false)
    await expect(store.read('learning')).resolves.toBeNull()
  })

  it('returns defensive, deeply frozen snapshots', async () => {
    const adapter = new MemoryAdapter()
    const store = createStore(adapter)
    const source = state() as {
      activeVersion: string | null
      readyVersions: Record<string, ReturnType<typeof descriptor>>
    } & ModuleDeviceState

    const written = await store.write(source)
    source.activeVersion = null
    source.readyVersions['1.2.3'].manifest.sha256 = 'b'.repeat(64)
    source.readyVersions['1.2.3'].dataSchemas.cards.write = 3

    const read = await store.read('learning')
    expect(read?.activeVersion).toBe('1.2.3')
    expect(read?.readyVersions['1.2.3'].manifest.sha256).toBe(HASH)
    for (const value of [
      written,
      written.readyVersions,
      written.readyVersions['1.2.3'],
      written.readyVersions['1.2.3'].manifest,
      written.readyVersions['1.2.3'].dataSchemas,
      written.readyVersions['1.2.3'].dataSchemas.cards,
      read,
    ]) {
      expect(Object.isFrozen(value)).toBe(true)
    }
  })

  it.each([
    ['dangling active pointer', { activeVersion: '9.9.9' }],
    ['dangling candidate pointer', { downloadedCandidate: '9.9.9' }],
    ['dangling pending pointer', { pendingVersion: '9.9.9' }],
    ['malformed pointer version', { activeVersion: 'v1' }],
    ['invalid platform', { platform: 'web' }],
    ['unknown state field', { unexpected: true }],
  ])('rejects the %s invariant', async (_label, patch) => {
    await expect(
      createStore().write({
        ...state(),
        ...patch,
      } as unknown as ModuleDeviceState),
    ).rejects.toThrow()
  })

  it('requires every descriptor identity to match its record', async () => {
    for (const patch of [
      { id: 'other' },
      { version: '1.2.4' },
      { platform: 'mobile' },
    ]) {
      const value = state()
      const altered = {
        ...value,
        readyVersions: {
          ...value.readyVersions,
          '1.2.3': { ...value.readyVersions['1.2.3'], ...patch },
        },
      }
      await expect(
        createStore().write(altered as unknown as ModuleDeviceState),
      ).rejects.toThrow('Descriptor identity')
    }
  })

  it.each([
    ['version', { version: '01.2.3' }],
    ['host API', { hostApi: 'latest' }],
    ['manifest URL', { manifestUrl: 'https://example.com/module.json' }],
    [
      'non-official release URL',
      {
        manifestUrl:
          'https://github.com/other/project/releases/download/v1/module.json',
      },
    ],
    ['manifest size', { manifest: { byteSize: 0, sha256: HASH } }],
    ['manifest hash', { manifest: { byteSize: 42, sha256: 'nope' } }],
    ['unknown descriptor field', { extra: true }],
    [
      'schema bounds',
      { dataSchemas: { cards: { readMin: 3, readMax: 1, write: 2 } } },
    ],
    [
      'schema namespace',
      { dataSchemas: { Bad_Name: { readMin: 1, readMax: 1, write: 1 } } },
    ],
    [
      'unknown schema field',
      {
        dataSchemas: {
          cards: { readMin: 1, readMax: 1, write: 1, extra: 1 },
        },
      },
    ],
  ])('rejects malformed descriptor %s data', async (_label, patch) => {
    const value = state()
    const altered = {
      ...value,
      activeVersion: null,
      readyVersions: {
        '1.2.3': { ...value.readyVersions['1.2.3'], ...patch },
      },
      downloadedCandidate: null,
    }
    await expect(createStore().write(altered)).rejects.toThrow()
  })

  it('rejects prototype-pollution names and unknown persisted fields', async () => {
    const adapter = new MemoryAdapter()
    const store = createStore(adapter)
    adapter.files.set(
      PATH,
      `{"schemaVersion":1,"data":{"moduleId":"learning","platform":"desktop","activeVersion":null,"downloadedCandidate":null,"pendingVersion":null,"readyVersions":{"__proto__":{}}}}`,
    )
    await expect(store.read('learning')).rejects.toBeInstanceOf(
      ModuleDeviceStateCorruptionError,
    )

    adapter.files.set(PATH, rawData({ ...state(), unknown: true }))
    await expect(store.read('learning')).rejects.toBeInstanceOf(
      ModuleDeviceStateCorruptionError,
    )
  })

  it('rejects corruption in envelopes, schema versions, namespaces, and data', async () => {
    const adapter = new MemoryAdapter()
    const store = createStore(adapter)
    for (const raw of [
      '{broken',
      rawData(state(), 2),
      rawData({ ...state(), moduleId: 'other' }),
      rawData({ ...state(), activeVersion: '8.0.0' }),
      rawData({
        ...state(),
        readyVersions: {
          '1.2.3': { ...descriptor('1.2.3'), manifestUrl: 'http://bad' },
        },
        downloadedCandidate: null,
      }),
    ]) {
      adapter.files.set(PATH, raw)
      await expect(store.read('learning')).rejects.toBeInstanceOf(
        ModuleDeviceStateCorruptionError,
      )
    }
  })

  it('can explicitly clear corrupted device-local state', async () => {
    const adapter = new MemoryAdapter()
    const store = createStore(adapter)
    adapter.files.set(PATH, '{broken')

    await expect(store.read('learning')).rejects.toBeInstanceOf(
      ModuleDeviceStateCorruptionError,
    )
    await expect(store.remove('learning')).resolves.toBeUndefined()
    await expect(store.read('learning')).resolves.toBeNull()
  })

  it('rejects non-plain inputs without invoking accessors', async () => {
    const store = createStore()
    let invoked = false
    const accessor = descriptor('1.2.3') as Record<string, unknown>
    Object.defineProperty(accessor, 'manifestUrl', {
      enumerable: true,
      get: () => {
        invoked = true
        return 'https://example.com'
      },
    })
    const value = state()
    await expect(
      store.write({
        ...value,
        downloadedCandidate: null,
        readyVersions: { '1.2.3': accessor } as never,
      }),
    ).rejects.toThrow('data property')
    expect(invoked).toBe(false)

    const custom = Object.assign(Object.create({ inherited: true }), state())
    await expect(store.write(custom)).rejects.toThrow('plain object')
  })

  it('accepts null-prototype descriptor maps produced by trusted parsers', async () => {
    const value = state()
    const schemas = Object.assign(Object.create(null), {
      cards: Object.freeze({ readMin: 1, readMax: 3, write: 2 }),
    }) as ModuleDeviceState['readyVersions'][string]['dataSchemas']
    const readyVersions = Object.assign(Object.create(null), {
      '1.2.3': { ...descriptor('1.2.3'), dataSchemas: schemas },
    }) as ModuleDeviceState['readyVersions']

    await expect(
      createStore().write({
        ...value,
        downloadedCandidate: null,
        readyVersions,
      }),
    ).resolves.toMatchObject({
      activeVersion: '1.2.3',
      readyVersions: {
        '1.2.3': { dataSchemas: { cards: { write: 2 } } },
      },
    })
  })

  it('serializes write and remove operations per module across instances', async () => {
    const adapter = new MemoryAdapter()
    const first = createStore(adapter)
    const second = createStore(adapter)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    adapter.writeHook = async (path, data) => {
      started()
      await blocked
      adapter.files.set(path, data)
    }

    const writing = first.write(state())
    await writeStarted
    const removing = second.remove('learning')
    await Promise.resolve()
    expect(adapter.files.has(PATH)).toBe(false)
    release()
    await Promise.all([writing, removing])
    await expect(first.read('learning')).resolves.toBeNull()
  })

  it('works directly with IndexedDbDataAdapter', async () => {
    const localStorage = new Map<string, unknown>()
    const adapter = new IndexedDbDataAdapter(
      {
        loadLocalStorage: (key) => localStorage.get(key) ?? null,
        saveLocalStorage: (key, value) => {
          localStorage.set(key, value)
        },
      },
      {
        indexedDB: new IDBFactory(),
        createNamespaceId: () => '11111111-1111-4111-8111-111111111111',
      },
    )
    const store = new ModuleDeviceStateStore({
      kind: 'device-local-runtime-state',
      adapter,
      rootPath: ROOT,
    })

    await store.write(state())
    await expect(store.read('learning')).resolves.toEqual(state())
    await store.remove('learning')
    await expect(store.read('learning')).resolves.toBeNull()
    adapter.close()
  })
})
