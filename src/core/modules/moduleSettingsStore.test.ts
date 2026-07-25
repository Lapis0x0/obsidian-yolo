import {
  ModuleRuntimeStateStore,
  ModuleSettingsConflictError,
  ModuleSettingsCorruptionError,
  ModuleSettingsStore,
} from './moduleSettingsStore'

class MemoryAdapter {
  readonly files = new Map<string, string>()
  readonly folders = new Set<string>()
  readonly writes: string[] = []
  writeHook?: (path: string, data: string) => Promise<void>
  createHook?: (path: string, data: string) => Promise<void>

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
    this.writes.push(path)
    if (this.writeHook) await this.writeHook(path, data)
    else this.files.set(path, data)
  }

  async create(path: string, data: string): Promise<void> {
    if (this.createHook) return this.createHook(path, data)
    if (this.files.has(path)) throw new Error(`File already exists: ${path}`)
    this.files.set(path, data)
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path)
  }
}

describe('ModuleSettingsStore', () => {
  it('isolates module ids and returns a frozen deep copy', async () => {
    const adapter = new MemoryAdapter()
    const store = new ModuleSettingsStore({
      kind: 'synchronized-intent',
      adapter,
      rootPath: '.config/yolo/module-settings',
    })
    const source = { nested: { enabled: true }, names: ['one'] }

    const written = await store.write('notes', {
      schemaVersion: 1,
      data: source,
    })
    source.nested.enabled = false
    source.names.push('two')
    await store.write('search', {
      schemaVersion: 2,
      data: { provider: 'local' },
    })

    const notes = await store.read<typeof source>('notes')
    expect(notes).toEqual({
      schemaVersion: 1,
      data: { nested: { enabled: true }, names: ['one'] },
    })
    expect(written).not.toBe(source)
    expect(Object.isFrozen(notes)).toBe(true)
    expect(Object.isFrozen(notes?.data.nested)).toBe(true)
    expect(Object.isFrozen(notes?.data.names)).toBe(true)
    expect(await store.read('search')).toEqual({
      schemaVersion: 2,
      data: { provider: 'local' },
    })
    expect(adapter.files.has('.config/yolo/module-settings/notes.json')).toBe(
      true,
    )
    expect(adapter.files.has('.config/yolo/module-settings/search.json')).toBe(
      true,
    )
  })

  it('round-trips schema version zero', async () => {
    const adapter = new MemoryAdapter()
    const store = new ModuleSettingsStore({
      kind: 'synchronized-intent',
      adapter,
      rootPath: 'settings/modules',
    })

    await expect(
      store.write('generic', { schemaVersion: 0, data: { enabled: true } }),
    ).resolves.toEqual({ schemaVersion: 0, data: { enabled: true } })
    await expect(store.read('generic')).resolves.toEqual({
      schemaVersion: 0,
      data: { enabled: true },
    })
  })

  it('keeps synchronized intent and device-local state in explicit backends', async () => {
    const adapter = new MemoryAdapter()
    const settings = new ModuleSettingsStore({
      kind: 'synchronized-intent',
      adapter,
      rootPath: 'sync/modules',
    })
    const runtime = new ModuleRuntimeStateStore({
      kind: 'device-local-runtime-state',
      adapter,
      rootPath: 'local/modules',
    })

    await settings.write('learning', { schemaVersion: 1, data: { deck: 'A' } })
    await runtime.write('learning', { schemaVersion: 1, data: { cursor: 8 } })

    expect(settings.kind).toBe('synchronized-intent')
    expect(runtime.kind).toBe('device-local-runtime-state')
    expect(adapter.files.get('sync/modules/learning.json')).toContain('deck')
    expect(adapter.files.get('local/modules/learning.json')).toContain('cursor')
    expect(
      () =>
        new ModuleRuntimeStateStore({
          kind: 'device-local-runtime-state',
          adapter,
          rootPath: 'sync/modules',
        }),
    ).toThrow('requires a distinct backend root')
    expect(
      () =>
        new ModuleRuntimeStateStore({
          kind: 'device-local-runtime-state',
          adapter,
          rootPath: 'SYNC/MODULES',
        }),
    ).toThrow('requires a distinct backend root')
  })

  it('rejects unsafe ids, paths, non-JSON data, and corrupted envelopes', async () => {
    const adapter = new MemoryAdapter()
    const store = new ModuleSettingsStore({
      kind: 'synchronized-intent',
      adapter,
      rootPath: 'settings/modules',
    })

    expect(() => store.read('../notes')).toThrow('path segment')
    expect(
      () =>
        new ModuleSettingsStore({
          kind: 'synchronized-intent',
          adapter,
          rootPath: '../settings',
        }),
    ).toThrow('safe vault-relative path')
    expect(() =>
      store.write('notes', { schemaVersion: 1, data: { value: undefined } }),
    ).toThrow('JSON values')

    adapter.files.set('settings/modules/notes.json', '{broken')
    await expect(store.read('notes')).rejects.toBeInstanceOf(
      ModuleSettingsCorruptionError,
    )
    adapter.files.set(
      'settings/modules/notes.json',
      JSON.stringify({ schemaVersion: -1, data: {} }),
    )
    await expect(store.read('notes')).rejects.toThrow('invalid envelope')
    await expect(store.remove('notes')).resolves.toBeUndefined()
    await expect(store.read('notes')).resolves.toBeNull()
  })

  it('accepts Unicode storage roots while preserving portable path rules', async () => {
    const adapter = new MemoryAdapter()
    const store = new ModuleSettingsStore({
      kind: 'synchronized-intent',
      adapter,
      rootPath: '19AI资料/YOLO/.yolo_json_db/module-intent-v1',
    })

    await store.write('learning', {
      schemaVersion: 1,
      data: { state: 'enabled' },
    })

    expect(
      adapter.files.has(
        '19AI资料/YOLO/.yolo_json_db/module-intent-v1/learning.json',
      ),
    ).toBe(true)

    for (const rootPath of [
      'YOLO/bad:name',
      'YOLO/CON',
      'YOLO/trailing.',
      'YOLO/control\u0000character',
    ]) {
      expect(
        () =>
          new ModuleSettingsStore({
            kind: 'synchronized-intent',
            adapter,
            rootPath,
          }),
      ).toThrow('unsupported path segment')
    }
  })

  it('rejects JSON lookalikes without invoking accessors', async () => {
    const adapter = new MemoryAdapter()
    const store = new ModuleSettingsStore({
      kind: 'synchronized-intent',
      adapter,
      rootPath: 'strict/modules',
    })
    let accessorInvoked = false
    const accessor = {}
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: () => {
        accessorInvoked = true
        return 1
      },
    })
    const withToJson = { value: 1, toJSON: () => ({ value: 1 }) }
    const customPrototype = Object.assign(Object.create({ inherited: true }), {
      value: 1,
    }) as object
    const customArray = [1, 2] as number[] & { extra?: number }
    customArray.extra = 3
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic

    expect(() =>
      store.write('accessor', { schemaVersion: 1, data: accessor }),
    ).toThrow('data property')
    expect(accessorInvoked).toBe(false)
    expect(() =>
      store.write('to-json', { schemaVersion: 1, data: withToJson }),
    ).toThrow('JSON values')
    expect(() =>
      store.write('prototype', { schemaVersion: 1, data: customPrototype }),
    ).toThrow('ordinary object prototype')
    expect(() =>
      store.write('array', { schemaVersion: 1, data: customArray }),
    ).toThrow('custom properties')

    const objectPrototype = Object.prototype as object & {
      toJSON?: () => unknown
    }
    const objectToJson = objectPrototype.toJSON
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value: () => ({ replaced: true }),
    })
    try {
      await expect(
        store.write('learning', {
          schemaVersion: 1,
          data: { preserved: true },
        }),
      ).resolves.toEqual({
        schemaVersion: 1,
        data: { preserved: true },
      })
    } finally {
      if (objectToJson === undefined) delete objectPrototype.toJSON
      else objectPrototype.toJSON = objectToJson
    }
    expect(() =>
      store.write('cycle', { schemaVersion: 1, data: cyclic }),
    ).toThrow('cycles')
    expect(adapter.writes).toHaveLength(1)
  })

  it('serializes concurrent writes across store instances', async () => {
    const adapter = new MemoryAdapter()
    const backend = {
      kind: 'synchronized-intent' as const,
      adapter,
      rootPath: 'settings/modules',
    }
    const firstStore = new ModuleSettingsStore(backend)
    const secondStore = new ModuleSettingsStore(backend)
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let markTargetStarted!: () => void
    const targetStarted = new Promise<void>((resolve) => {
      markTargetStarted = resolve
    })
    let targetWrites = 0
    adapter.writeHook = async (path, data) => {
      if (path.endsWith('/notes.json')) {
        targetWrites += 1
        if (targetWrites === 1) {
          markTargetStarted()
          await firstBlocked
        }
      }
      adapter.files.set(path, data)
    }

    const first = firstStore.write('notes', {
      schemaVersion: 1,
      data: { order: 1 },
    })
    await targetStarted
    const second = secondStore.write('notes', {
      schemaVersion: 1,
      data: { order: 2 },
    })
    await Promise.resolve()
    expect(targetWrites).toBe(1)
    releaseFirst()
    await Promise.all([first, second])

    await expect(firstStore.read('notes')).resolves.toEqual({
      schemaVersion: 1,
      data: { order: 2 },
    })
  })

  it('creates only when absent and preserves an existing schema-zero envelope', async () => {
    const adapter = new MemoryAdapter()
    const store = new ModuleSettingsStore({
      kind: 'synchronized-intent',
      adapter,
      create: (path, data) => adapter.create(path, data),
      rootPath: 'settings/modules',
    })

    await expect(
      store.createIfAbsent('learning', {
        schemaVersion: 0,
        data: { modelId: 'legacy' },
      }),
    ).resolves.toBe('created')
    await expect(
      store.createIfAbsent('learning', {
        schemaVersion: 0,
        data: { modelId: 'replacement' },
      }),
    ).resolves.toBe('already-present')
    await expect(store.read('learning')).resolves.toEqual({
      schemaVersion: 0,
      data: { modelId: 'legacy' },
    })
  })

  it('serializes create-if-absent across stores without a TOCTOU overwrite', async () => {
    const adapter = new MemoryAdapter()
    const backend = {
      kind: 'synchronized-intent' as const,
      adapter,
      create: (path: string, data: string) => adapter.create(path, data),
      rootPath: 'settings/modules',
    }
    const firstStore = new ModuleSettingsStore(backend)
    const secondStore = new ModuleSettingsStore(backend)

    const results = await Promise.all([
      firstStore.createIfAbsent('learning', {
        schemaVersion: 0,
        data: { owner: 'first' },
      }),
      secondStore.createIfAbsent('learning', {
        schemaVersion: 0,
        data: { owner: 'second' },
      }),
    ])

    expect(results).toEqual(['created', 'already-present'])
    await expect(firstStore.read('learning')).resolves.toEqual({
      schemaVersion: 0,
      data: { owner: 'first' },
    })
  })

  it('fails safely when create fails before mutation or cannot be read back', async () => {
    const adapter = new MemoryAdapter()
    const createFailure = new Error('create unavailable')
    const store = new ModuleSettingsStore({
      kind: 'synchronized-intent',
      adapter,
      create: async () => {
        throw createFailure
      },
      rootPath: 'settings/modules',
    })

    await expect(
      store.createIfAbsent('learning', { schemaVersion: 0, data: {} }),
    ).rejects.toBe(createFailure)
    expect(adapter.files).toEqual(new Map())

    adapter.createHook = async (path, data) => {
      adapter.files.set(path, data)
      throw createFailure
    }
    const uncertainStore = new ModuleSettingsStore({
      kind: 'synchronized-intent',
      adapter,
      create: (path, data) => adapter.create(path, data),
      rootPath: 'other/modules',
    })
    await expect(
      uncertainStore.createIfAbsent('learning', {
        schemaVersion: 0,
        data: { recovered: true },
      }),
    ).resolves.toBe('created')
  })

  it('rejects a successful create whose exact readback changed', async () => {
    const adapter = new MemoryAdapter()
    const store = new ModuleSettingsStore({
      kind: 'synchronized-intent',
      adapter,
      create: async (path) => {
        adapter.files.set(
          path,
          JSON.stringify({ schemaVersion: 1, data: { external: true } }),
        )
      },
      rootPath: 'settings/modules',
    })

    await expect(
      store.createIfAbsent('learning', {
        schemaVersion: 0,
        data: { legacy: true },
      }),
    ).rejects.toBeInstanceOf(ModuleSettingsConflictError)
    await expect(store.read('learning')).resolves.toEqual({
      schemaVersion: 1,
      data: { external: true },
    })
  })

  it('reports a verified-write conflict without overwriting the external value', async () => {
    const adapter = new MemoryAdapter()
    const store = new ModuleSettingsStore({
      kind: 'synchronized-intent',
      adapter,
      rootPath: 'settings/modules',
    })
    await store.write('notes', { schemaVersion: 1, data: { value: 'old' } })
    const external = JSON.stringify({
      schemaVersion: 1,
      data: { value: 'external' },
    })
    adapter.writeHook = async (path) => {
      adapter.files.set(path, external)
    }

    await expect(
      store.write('notes', { schemaVersion: 1, data: { value: 'new' } }),
    ).rejects.toBeInstanceOf(ModuleSettingsConflictError)
    await expect(store.read('notes')).resolves.toEqual({
      schemaVersion: 1,
      data: { value: 'external' },
    })
    expect(adapter.writes.every((path) => path.endsWith('/notes.json'))).toBe(
      true,
    )
  })

  it('naturally preserves the old value when a direct write fails before mutation', async () => {
    const adapter = new MemoryAdapter()
    const store = new ModuleSettingsStore({
      kind: 'synchronized-intent',
      adapter,
      rootPath: 'settings/modules',
    })
    await store.write('notes', { schemaVersion: 1, data: { value: 'old' } })
    adapter.writeHook = async () => {
      throw new Error('disk unavailable')
    }

    await expect(
      store.write('notes', { schemaVersion: 1, data: { value: 'new' } }),
    ).rejects.toThrow('disk unavailable')
    await expect(store.read('notes')).resolves.toEqual({
      schemaVersion: 1,
      data: { value: 'old' },
    })
  })

  it('runs only caller-supplied, version-by-version migrations', async () => {
    const adapter = new MemoryAdapter()
    const store = new ModuleSettingsStore({
      kind: 'synchronized-intent',
      adapter,
      rootPath: 'settings/modules',
    })
    await store.write('generic', { schemaVersion: 1, data: { count: 1 } })

    await expect(
      store.migrate('generic', 3, {
        1: (data) => ({ count: (data as { count: number }).count + 1 }),
        2: (data) => ({ count: (data as { count: number }).count * 2 }),
      }),
    ).resolves.toEqual({ schemaVersion: 3, data: { count: 4 } })
    await expect(store.read('generic')).resolves.toEqual({
      schemaVersion: 3,
      data: { count: 4 },
    })
  })

  it('migrates schema version zero to one', async () => {
    const adapter = new MemoryAdapter()
    const store = new ModuleSettingsStore({
      kind: 'synchronized-intent',
      adapter,
      rootPath: 'migration-zero/modules',
    })
    await store.write('generic', { schemaVersion: 0, data: { count: 1 } })

    await expect(
      store.migrate('generic', 1, {
        0: (data) => ({ count: (data as { count: number }).count + 1 }),
      }),
    ).resolves.toEqual({ schemaVersion: 1, data: { count: 2 } })
    await expect(store.read('generic')).resolves.toEqual({
      schemaVersion: 1,
      data: { count: 2 },
    })
  })

  it('rejects asynchronous and reentrant migration behavior', async () => {
    const adapter = new MemoryAdapter()
    const backend = {
      kind: 'synchronized-intent' as const,
      adapter,
      rootPath: 'migration/modules',
    }
    const store = new ModuleSettingsStore(backend)
    const secondStore = new ModuleSettingsStore(backend)
    await store.write('generic', { schemaVersion: 1, data: { count: 1 } })

    await expect(
      store.migrate('generic', 2, {
        1: async () => ({ count: 2 }),
      }),
    ).rejects.toThrow('must return synchronously')
    await expect(store.read('generic')).resolves.toEqual({
      schemaVersion: 1,
      data: { count: 1 },
    })

    await expect(
      store.migrate('generic', 2, {
        1: () => {
          expect(() =>
            secondStore.write('generic', {
              schemaVersion: 9,
              data: { count: 99 },
            }),
          ).toThrow('reentrantly')
          return { count: 2 }
        },
      }),
    ).resolves.toEqual({ schemaVersion: 2, data: { count: 2 } })
    await expect(store.read('generic')).resolves.toEqual({
      schemaVersion: 2,
      data: { count: 2 },
    })
  })
})
