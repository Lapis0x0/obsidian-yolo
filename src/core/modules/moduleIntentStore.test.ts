import {
  type ModuleIntentBackend,
  ModuleIntentStore,
} from './moduleIntentStore'
import {
  ModuleSettingsCorruptionError,
  type SynchronizedModuleSettingsBackend,
} from './moduleSettingsStore'

class MemoryAdapter {
  readonly files = new Map<string, string>()
  readonly folders = new Set<string>()
  readonly writes: string[] = []
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
    this.writes.push(path)
    if (this.writeHook) await this.writeHook(path, data)
    else this.files.set(path, data)
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path)
  }
}

function createBackend(
  adapter: MemoryAdapter,
  getRoot: () => string,
): ModuleIntentBackend {
  return {
    capture: (): SynchronizedModuleSettingsBackend => ({
      kind: 'synchronized-intent',
      adapter,
      rootPath: getRoot(),
    }),
    listModuleIds: async () => [],
    subscribe: () => () => undefined,
    subscribeAll: () => () => undefined,
  }
}

function createHarness(rootPath = 'YOLO/.yolo_json_db/module-intent') {
  const adapter = new MemoryAdapter()
  let root = rootPath
  const backend = createBackend(adapter, () => root)
  return {
    adapter,
    backend,
    store: new ModuleIntentStore(backend),
    path: (moduleId: string) => `${root}/${moduleId}.json`,
    setRoot: (next: string) => {
      root = next
    },
  }
}

function envelope(data: unknown, schemaVersion = 1): string {
  return JSON.stringify({ schemaVersion, data })
}

describe('ModuleIntentStore', () => {
  it('represents a missing file as no intent and persists all three states', async () => {
    const harness = createHarness()

    await expect(harness.store.get('missing')).resolves.toBeUndefined()

    for (const state of ['uninstalled', 'disabled', 'enabled'] as const) {
      await expect(harness.store.set('notes', state)).resolves.toBe(state)
      await expect(harness.store.get('notes')).resolves.toBe(state)
      expect(
        JSON.parse(harness.adapter.files.get(harness.path('notes')) ?? ''),
      ).toEqual({ schemaVersion: 1, data: { state } })
    }
  })

  it.each([
    ['old boolean schema', envelope({ desiredInstalled: true, enabled: true })],
    ['old version', envelope({ state: 'enabled' }, 0)],
    ['future version', envelope({ state: 'enabled' }, 2)],
    ['missing state', envelope({})],
    ['unknown state', envelope({ state: 'paused' })],
    ['unknown field', envelope({ state: 'enabled', extra: true })],
    ['non-object data', envelope('enabled')],
    ['broken JSON', '{broken'],
  ])('fails closed and does not overwrite %s', async (_label, raw) => {
    const harness = createHarness()
    harness.adapter.files.set(harness.path('notes'), raw)

    await expect(harness.store.set('notes', 'disabled')).rejects.toBeInstanceOf(
      ModuleSettingsCorruptionError,
    )
    expect(harness.adapter.files.get(harness.path('notes'))).toBe(raw)
    expect(harness.adapter.writes).toEqual([])
  })

  it('validates module ids and intent values', () => {
    const harness = createHarness()

    expect(() => harness.store.set('../notes', 'enabled')).toThrow(
      'path segment',
    )
    expect(() => harness.store.set('notes', 'paused' as 'enabled')).toThrow(
      'must be uninstalled, disabled, or enabled',
    )
  })

  it('forwards discovery and subscription APIs', async () => {
    const harness = createHarness()
    const listener = jest.fn()
    const dispose = jest.fn()
    jest
      .spyOn(harness.backend, 'listModuleIds')
      .mockResolvedValue(['notes', 'search'])
    const subscribe = jest
      .spyOn(harness.backend, 'subscribe')
      .mockReturnValue(dispose)
    const subscribeAll = jest
      .spyOn(harness.backend, 'subscribeAll')
      .mockReturnValue(dispose)

    await expect(harness.store.listModuleIds()).resolves.toEqual([
      'notes',
      'search',
    ])
    expect(harness.store.subscribe('notes', listener)).toBe(dispose)
    expect(harness.store.subscribeAll(listener)).toBe(dispose)
    expect(subscribe).toHaveBeenCalledWith('notes', listener)
    expect(subscribeAll).toHaveBeenCalledWith(listener)
    expect(() => harness.store.subscribe('notes', null as never)).toThrow(
      'must be a function',
    )
    expect(() => harness.store.subscribeAll(null as never)).toThrow(
      'must be a function',
    )
  })

  it('uses the settings store queue for concurrent writes', async () => {
    const harness = createHarness()
    const secondStore = new ModuleIntentStore(harness.backend)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let writes = 0
    harness.adapter.writeHook = async (path, data) => {
      writes += 1
      if (writes === 1) {
        started()
        await blocked
      }
      harness.adapter.files.set(path, data)
    }

    const first = harness.store.set('notes', 'disabled')
    await writeStarted
    const second = secondStore.set('notes', 'enabled')
    await Promise.resolve()
    expect(writes).toBe(1)
    release()
    await Promise.all([first, second])

    await expect(harness.store.get('notes')).resolves.toBe('enabled')
  })

  it('captures the configured root for each operation', async () => {
    const oldRoot = 'Old/.yolo_json_db/module-intent'
    const newRoot = 'New/.yolo_json_db/module-intent'
    const harness = createHarness(oldRoot)

    await harness.store.set('notes', 'disabled')
    harness.setRoot(newRoot)
    await harness.store.set('notes', 'enabled')

    expect(harness.adapter.files.has(`${oldRoot}/notes.json`)).toBe(true)
    expect(harness.adapter.files.has(`${newRoot}/notes.json`)).toBe(true)
    await expect(harness.store.get('notes')).resolves.toBe('enabled')
  })
})
