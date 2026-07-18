import type { App, DataAdapter, EventRef, TAbstractFile, Vault } from 'obsidian'

import { ModuleSettingsCorruptionError } from './moduleSettingsStore'
import {
  type CapturedModuleSettingsLocation,
  type ObsidianModuleConfigSettings,
  createObsidianModuleConfigBackendFactory,
  createObsidianModuleTransitionSettingsBackend,
} from './obsidianModuleConfigBackend'

type VaultEvent = 'create' | 'modify' | 'delete' | 'rename'
type EventHandler = (entry: TAbstractFile, oldPath?: string) => void

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

class VaultEvents {
  private nextRef = 0
  private readonly handlers = new Map<EventRef, EventHandler>()
  private readonly events = new Map<EventRef, VaultEvent>()
  readonly removed: EventRef[] = []

  constructor(readonly adapter: DataAdapter) {}

  async create(path: string, data: string): Promise<{ path: string }> {
    await (this.adapter as unknown as MemoryAdapter).create(path, data)
    return { path }
  }

  on(event: VaultEvent, handler: EventHandler): EventRef {
    const ref = { id: ++this.nextRef } as unknown as EventRef
    this.handlers.set(ref, handler)
    this.events.set(ref, event)
    return ref
  }

  offref(ref: EventRef): void {
    this.removed.push(ref)
    this.handlers.delete(ref)
    this.events.delete(ref)
  }

  emit(event: VaultEvent, path: string, oldPath?: string): void {
    const entry = { path } as TAbstractFile
    for (const [ref, handler] of [...this.handlers]) {
      if (this.events.get(ref) === event) handler(entry, oldPath)
    }
  }
}

function createHarness(baseDir = 'YOLO') {
  const adapter = new MemoryAdapter()
  const vault = new VaultEvents(adapter as unknown as DataAdapter)
  let settings: ObsidianModuleConfigSettings = { yolo: { baseDir } }
  const settingsListeners = new Set<() => void>()
  const settingsDisposer = jest.fn()
  const factory = createObsidianModuleConfigBackendFactory<{
    enabled: boolean
  }>({
    app: { vault: vault as unknown as Vault } as App,
    getSettings: () => settings,
    subscribeSettingsChange: (listener) => {
      settingsListeners.add(listener)
      return () => {
        settingsDisposer()
        settingsListeners.delete(listener)
      }
    },
  })
  const transitionBackend = createObsidianModuleTransitionSettingsBackend({
    app: { vault: vault as unknown as Vault } as App,
    getSettings: () => settings,
  })

  return {
    adapter,
    vault,
    settingsDisposer,
    backend: factory('notes'),
    transitionBackend,
    setBaseDir(next: string, notify = true) {
      settings = { yolo: { baseDir: next } }
      if (notify) for (const listener of [...settingsListeners]) listener()
    },
    notifySettingsChange() {
      for (const listener of [...settingsListeners]) listener()
    },
  }
}

describe('createObsidianModuleConfigBackendFactory', () => {
  it('returns the same deeply frozen valid default when config is missing', async () => {
    const { backend } = createHarness()

    const first = await backend.read()
    const second = await backend.read()

    expect(first).toBe(second)
    expect(first).toEqual({ schemaVersion: 0, data: {} })
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.data)).toBe(true)
  })

  it('reads and writes through the active base directory', async () => {
    const harness = createHarness('One')

    await harness.backend.write({
      schemaVersion: 2,
      data: { enabled: true },
    })
    expect(harness.adapter.writes).toEqual([
      'One/.yolo_json_db/module-settings/notes.json',
    ])
    await expect(harness.backend.read()).resolves.toEqual({
      schemaVersion: 2,
      data: { enabled: true },
    })

    harness.setBaseDir('Two')
    await expect(harness.backend.read()).resolves.toEqual({
      schemaVersion: 0,
      data: {},
    })
    await harness.backend.write({
      schemaVersion: 3,
      data: { enabled: false },
    })
    expect(harness.adapter.writes).toEqual([
      'One/.yolo_json_db/module-settings/notes.json',
      'Two/.yolo_json_db/module-settings/notes.json',
    ])
  })

  it('creates config only when truly absent', async () => {
    const harness = createHarness()
    const factory = createObsidianModuleConfigBackendFactory({
      app: { vault: harness.vault as unknown as Vault } as App,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      subscribeSettingsChange: () => () => undefined,
    })
    const first = {
      schemaVersion: 0,
      data: { enabled: true },
    }

    await expect(factory.createIfAbsent('notes', first)).resolves.toBe(
      'created',
    )

    await expect(
      factory.createIfAbsent('notes', {
        schemaVersion: 1,
        data: { enabled: false },
      }),
    ).resolves.toBe('already-present')
    await expect(factory('notes').read()).resolves.toEqual(first)
  })

  it('captures the active base directory before create-if-absent yields', async () => {
    const harness = createHarness('Old')
    const factory = createObsidianModuleConfigBackendFactory({
      app: { vault: harness.vault as unknown as Vault } as App,
      getSettings: () =>
        ({ yolo: { baseDir: currentBaseDir } }) as ObsidianModuleConfigSettings,
      subscribeSettingsChange: () => () => undefined,
    })
    let currentBaseDir = 'Old'
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const createStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    harness.adapter.createHook = async (path, data) => {
      started()
      await blocked
      harness.adapter.files.set(path, data)
    }

    const pending = factory.createIfAbsent('learning', {
      schemaVersion: 0,
      data: { enabled: true },
    })
    await createStarted
    currentBaseDir = 'New'
    release()

    await expect(pending).resolves.toBe('created')
    expect(
      harness.adapter.files.has(
        'Old/.yolo_json_db/module-settings/learning.json',
      ),
    ).toBe(true)
    expect(
      harness.adapter.files.has(
        'New/.yolo_json_db/module-settings/learning.json',
      ),
    ).toBe(false)
  })

  it('returns the snapshot persisted under the root captured for the write', async () => {
    const harness = createHarness('One')
    let releaseWrite!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    let markWriteStarted!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve
    })
    harness.adapter.writeHook = async (path, data) => {
      markWriteStarted()
      await blocked
      harness.adapter.files.set(path, data)
    }

    const pending = harness.backend.write({
      schemaVersion: 0,
      data: { enabled: true },
    })
    await writeStarted
    harness.setBaseDir('Two')
    releaseWrite()

    await expect(pending).resolves.toEqual({
      schemaVersion: 0,
      data: { enabled: true },
    })
    expect(harness.adapter.writes).toEqual([
      'One/.yolo_json_db/module-settings/notes.json',
    ])
    await expect(harness.backend.read()).resolves.toEqual({
      schemaVersion: 0,
      data: {},
    })
  })

  it('notifies only for Vault events affecting the active config file', () => {
    const harness = createHarness('Active')
    const listener = jest.fn()
    harness.backend.subscribe(listener)
    const target = 'Active/.yolo_json_db/module-settings/notes.json'

    harness.vault.emit('create', target)
    harness.vault.emit('modify', target)
    harness.vault.emit('delete', target)
    harness.vault.emit('modify', `${target}.backup`)
    harness.vault.emit(
      'rename',
      'Active/.yolo_json_db/module-settings/other.json',
      target,
    )
    harness.vault.emit(
      'rename',
      target,
      'Active/.yolo_json_db/module-settings/other.json',
    )
    harness.vault.emit('rename', 'unrelated/new.json', 'unrelated/old.json')

    expect(listener).toHaveBeenCalledTimes(5)
  })

  it('switches event filtering and notifies when the base directory changes', () => {
    const harness = createHarness('Old')
    const listener = jest.fn()
    harness.backend.subscribe(listener)
    const oldPath = 'Old/.yolo_json_db/module-settings/notes.json'
    const newPath = 'New/.yolo_json_db/module-settings/notes.json'

    harness.setBaseDir('New')
    expect(listener).toHaveBeenCalledTimes(1)
    harness.vault.emit('modify', oldPath)
    harness.vault.emit('modify', newPath)
    expect(listener).toHaveBeenCalledTimes(2)

    harness.notifySettingsChange()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('tracks the current base directory on Vault events even before notification', () => {
    const harness = createHarness('Old')
    const listener = jest.fn()
    harness.backend.subscribe(listener)

    harness.setBaseDir('New', false)
    harness.vault.emit('modify', 'New/.yolo_json_db/module-settings/notes.json')

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes all sources synchronously and idempotently', () => {
    const harness = createHarness()
    const listener = jest.fn()
    const unsubscribe = harness.backend.subscribe(listener)

    unsubscribe()
    unsubscribe()
    harness.vault.emit(
      'modify',
      'YOLO/.yolo_json_db/module-settings/notes.json',
    )
    harness.setBaseDir('Other')

    expect(harness.vault.removed).toHaveLength(4)
    expect(harness.settingsDisposer).toHaveBeenCalledTimes(1)
    expect(listener).not.toHaveBeenCalled()
  })

  it('propagates stored corruption unchanged', async () => {
    const harness = createHarness()
    harness.adapter.files.set(
      'YOLO/.yolo_json_db/module-settings/notes.json',
      '{broken',
    )

    await expect(harness.backend.read()).rejects.toBeInstanceOf(
      ModuleSettingsCorruptionError,
    )
  })

  it('delegates unsafe module ids to the shared module validation', () => {
    const harness = createHarness()
    const factory = createObsidianModuleConfigBackendFactory({
      app: { vault: harness.vault as unknown as Vault } as App,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      subscribeSettingsChange: () => () => undefined,
    })

    expect(() => factory('../notes')).toThrow('path segment')
  })
})

describe('createObsidianModuleTransitionSettingsBackend', () => {
  it('distinguishes an absent file from a present schema-0 envelope', async () => {
    const harness = createHarness()

    await expect(harness.transitionBackend.capture('notes')).resolves.toEqual({
      location: {
        moduleId: 'notes',
        storageRoot: 'YOLO/.yolo_json_db/module-settings',
        storagePath: 'YOLO/.yolo_json_db/module-settings/notes.json',
      },
      snapshot: { present: false, envelope: null },
    })

    harness.adapter.files.set(
      'YOLO/.yolo_json_db/module-settings/notes.json',
      JSON.stringify({ schemaVersion: 0, data: {} }),
    )
    await expect(harness.transitionBackend.capture('notes')).resolves.toEqual({
      location: {
        moduleId: 'notes',
        storageRoot: 'YOLO/.yolo_json_db/module-settings',
        storagePath: 'YOLO/.yolo_json_db/module-settings/notes.json',
      },
      snapshot: {
        present: true,
        envelope: { schemaVersion: 0, data: {} },
      },
    })
  })

  it('resolves and normalizes the current base directory for each capture', async () => {
    const harness = createHarness('First//Root')

    const first = await harness.transitionBackend.capture('notes')
    harness.setBaseDir('Second\\Root')
    const second = await harness.transitionBackend.capture('notes')

    expect(first.location.storageRoot).toBe(
      'First/Root/.yolo_json_db/module-settings',
    )
    expect(second.location.storageRoot).toBe(
      'Second/Root/.yolo_json_db/module-settings',
    )
  })

  it('binds the base directory synchronously when capture starts', async () => {
    const harness = createHarness('Old')

    const pending = harness.transitionBackend.capture('notes')
    harness.setBaseDir('New')

    await expect(pending).resolves.toMatchObject({
      location: {
        storageRoot: 'Old/.yolo_json_db/module-settings',
        storagePath: 'Old/.yolo_json_db/module-settings/notes.json',
      },
    })
  })

  it('reads the exact captured root after the active base directory changes', async () => {
    const harness = createHarness('Old')
    harness.adapter.files.set(
      'Old/.yolo_json_db/module-settings/notes.json',
      JSON.stringify({ schemaVersion: 1, data: { enabled: true } }),
    )
    const captured = await harness.transitionBackend.capture('notes')
    harness.setBaseDir('New')
    harness.adapter.files.set(
      'New/.yolo_json_db/module-settings/notes.json',
      JSON.stringify({ schemaVersion: 2, data: { enabled: false } }),
    )

    await expect(
      harness.transitionBackend.readAtCapturedLocation(captured.location),
    ).resolves.toEqual({
      present: true,
      envelope: { schemaVersion: 1, data: { enabled: true } },
    })
  })

  it.each([
    {
      moduleId: '../notes',
      storageRoot: 'Safe/.yolo_json_db/module-settings',
      storagePath: 'Safe/.yolo_json_db/module-settings/../notes.json',
    },
    {
      moduleId: 'notes',
      storageRoot: '../Outside',
      storagePath: '../Outside/notes.json',
    },
    {
      moduleId: 'notes',
      storageRoot: 'Safe/.yolo_json_db/module-settings',
      storagePath: 'Outside/notes.json',
    },
    {
      moduleId: 'notes',
      storageRoot: 'Safe/arbitrary/root',
      storagePath: 'Safe/arbitrary/root/notes.json',
    },
    {
      moduleId: 'notes',
      storageRoot: 'Safe/.yolo_json_db/module-setting',
      storagePath: 'Safe/.yolo_json_db/module-setting/notes.json',
    },
    {
      moduleId: 'notes',
      storageRoot: 'Safe/not.yolo_json_db/module-settings',
      storagePath: 'Safe/not.yolo_json_db/module-settings/notes.json',
    },
  ])('rejects a malicious captured location %#', async (location) => {
    const harness = createHarness()

    await expect(
      harness.transitionBackend.readAtCapturedLocation(
        location as CapturedModuleSettingsLocation,
      ),
    ).rejects.toThrow()
    await expect(
      harness.transitionBackend.writeVerifiedAtCapturedLocation(
        location as CapturedModuleSettingsLocation,
        { present: false, envelope: null },
      ),
    ).rejects.toThrow()
    expect(harness.adapter.writes).toEqual([])
  })

  it('returns deeply frozen capture data', async () => {
    const harness = createHarness()
    harness.adapter.files.set(
      'YOLO/.yolo_json_db/module-settings/notes.json',
      JSON.stringify({
        schemaVersion: 3,
        data: { nested: [{ enabled: true }] },
      }),
    )

    const captured = await harness.transitionBackend.capture('notes')
    const present = captured.snapshot
    if (!present.present) throw new Error('Expected present settings')

    expect(Object.isFrozen(captured)).toBe(true)
    expect(Object.isFrozen(captured.location)).toBe(true)
    expect(Object.isFrozen(present)).toBe(true)
    expect(Object.isFrozen(present.envelope)).toBe(true)
    expect(Object.isFrozen(present.envelope.data)).toBe(true)
    expect(
      Object.isFrozen(
        (present.envelope.data as { nested: readonly unknown[] }).nested,
      ),
    ).toBe(true)
  })

  it('does not write while capturing or reading a captured location', async () => {
    const harness = createHarness()
    const captured = await harness.transitionBackend.capture('notes')

    await harness.transitionBackend.readAtCapturedLocation(captured.location)

    expect(harness.adapter.writes).toEqual([])
    expect(harness.adapter.folders).toEqual(new Set())
  })
})
