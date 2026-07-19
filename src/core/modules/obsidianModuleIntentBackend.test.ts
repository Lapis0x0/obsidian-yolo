import type {
  App,
  DataAdapter,
  EventRef,
  ListedFiles,
  TAbstractFile,
  Vault,
} from 'obsidian'

import { ModuleIntentStore } from './moduleIntentStore'
import {
  ModuleIntentSubscriptionRegistrationError,
  type ObsidianModuleIntentSettings,
  createObsidianModuleIntentBackend,
} from './obsidianModuleIntentBackend'

type VaultEvent = 'create' | 'modify' | 'delete' | 'rename'
type EventHandler = (entry: TAbstractFile, oldPath?: string) => void

class MemoryAdapter {
  readonly files = new Map<string, string>()
  readonly folders = new Set<string>()
  readonly writes: string[] = []
  writeHook?: (path: string, data: string) => Promise<void>
  listError?: Error

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

  async list(path: string): Promise<ListedFiles> {
    if (this.listError) throw this.listError
    const prefix = `${path}/`
    return {
      files: [...this.files.keys()].filter((entry) => entry.startsWith(prefix)),
      folders: [...this.folders].filter((entry) => entry.startsWith(prefix)),
    }
  }
}

class VaultEvents {
  private nextRef = 0
  private readonly handlers = new Map<EventRef, EventHandler>()
  private readonly events = new Map<EventRef, VaultEvent>()
  readonly removed: EventRef[] = []
  readonly offAttempts = new Map<EventRef, number>()
  failOnRegistration?: number
  failOffOnce = false
  registrations = 0

  constructor(readonly adapter: DataAdapter) {}

  on(event: VaultEvent, handler: EventHandler): EventRef {
    this.registrations += 1
    if (this.registrations === this.failOnRegistration) {
      throw new Error('registration failed')
    }
    const ref = { id: ++this.nextRef } as unknown as EventRef
    this.handlers.set(ref, handler)
    this.events.set(ref, event)
    return ref
  }

  offref(ref: EventRef): void {
    const attempts = (this.offAttempts.get(ref) ?? 0) + 1
    this.offAttempts.set(ref, attempts)
    if (this.failOffOnce && attempts === 1) throw new Error('offref failed')
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
  let settings: ObsidianModuleIntentSettings = { yolo: { baseDir } }
  const settingsListeners = new Set<() => void>()
  let settingsDisposeAttempts = 0
  let failSettingsDisposeOnce = false
  let failSettingsRegistration = false
  const backend = createObsidianModuleIntentBackend({
    app: { vault: vault as unknown as Vault } as App,
    getSettings: () => settings,
    subscribeSettingsChange: (listener) => {
      if (failSettingsRegistration) {
        throw new Error('settings registration failed')
      }
      settingsListeners.add(listener)
      return () => {
        settingsDisposeAttempts += 1
        if (failSettingsDisposeOnce && settingsDisposeAttempts === 1) {
          throw new Error('settings dispose failed')
        }
        settingsListeners.delete(listener)
      }
    },
  })
  return {
    adapter,
    vault,
    backend,
    store: new ModuleIntentStore(backend),
    get settingsDisposeAttempts() {
      return settingsDisposeAttempts
    },
    failSettingsDisposeOnce() {
      failSettingsDisposeOnce = true
    },
    failSettingsRegistration() {
      failSettingsRegistration = true
    },
    setBaseDir(next: string, notify = true) {
      settings = { yolo: { baseDir: next } }
      if (notify) for (const listener of [...settingsListeners]) listener()
    },
    notifySettingsChange() {
      for (const listener of [...settingsListeners]) listener()
    },
  }
}

describe('createObsidianModuleIntentBackend', () => {
  it('writes each module to its own file under the current JSON root', async () => {
    const harness = createHarness('First')

    await Promise.all([
      harness.store.set('notes', 'disabled'),
      harness.store.set('search', 'uninstalled'),
    ])
    harness.setBaseDir('Second')
    await harness.store.set('notes', 'uninstalled')

    expect(harness.adapter.writes).toEqual([
      'First/.yolo_json_db/module-intent/notes.json',
      'First/.yolo_json_db/module-intent/search.json',
      'Second/.yolo_json_db/module-intent/notes.json',
    ])
  })

  it('keeps an in-flight operation on its synchronously captured root', async () => {
    const harness = createHarness('Old')
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    harness.adapter.writeHook = async (path, data) => {
      started()
      await blocked
      harness.adapter.files.set(path, data)
    }

    const pending = harness.store.set('notes', 'enabled')
    await writeStarted
    harness.setBaseDir('New')
    release()
    await pending

    expect(harness.adapter.writes).toEqual([
      'Old/.yolo_json_db/module-intent/notes.json',
    ])
  })

  it('lists only sorted unique valid intent files directly under the current root', async () => {
    const harness = createHarness('Active')
    const root = 'Active/.yolo_json_db/module-intent'
    harness.adapter.folders.add(root)
    for (const path of [
      `${root}/search.json`,
      `${root}/notes.json`,
      `${root}/notes.json.tmp`,
      `${root}/Bad.json`,
      `${root}/nested/deep.json`,
    ]) {
      harness.adapter.files.set(path, '')
    }
    harness.adapter.folders.add(`${root}/folder.json`)

    await expect(harness.store.listModuleIds()).resolves.toEqual([
      'notes',
      'search',
    ])
    harness.setBaseDir('Missing', false)
    await expect(harness.store.listModuleIds()).resolves.toEqual([])

    harness.adapter.folders.add('Missing/.yolo_json_db/module-intent')
    harness.adapter.listError = new Error('list failed')
    await expect(harness.store.listModuleIds()).rejects.toThrow('list failed')
  })

  it('publishes both ids for a rename and ignores invalid or nested JSON paths', () => {
    const harness = createHarness('Active')
    const listener = jest.fn()
    harness.store.subscribeAll(listener)
    const root = 'Active/.yolo_json_db/module-intent'

    harness.vault.emit('rename', `${root}/search.json`, `${root}/notes.json`)
    harness.vault.emit('create', `${root}/nested/deep.json`)
    harness.vault.emit('create', `${root}/Bad.json`)
    harness.vault.emit('create', `${root}/notes.json.tmp`)

    expect(listener.mock.calls).toEqual([['notes'], ['search']])
  })

  it('covers old and new roots while switching and then relocates', async () => {
    const harness = createHarness('Old')
    const oldRoot = 'Old/.yolo_json_db/module-intent'
    const newRoot = 'New/.yolo_json_db/module-intent'
    harness.adapter.folders.add(oldRoot)
    harness.adapter.folders.add(newRoot)
    harness.adapter.files.set(`${oldRoot}/old-only.json`, '')
    harness.adapter.files.set(`${newRoot}/new-only.json`, '')
    const listener = jest.fn()
    harness.store.subscribeAll(listener)

    harness.setBaseDir('New')
    harness.vault.emit('modify', `${oldRoot}/during-old.json`)
    harness.vault.emit('modify', `${newRoot}/during-new.json`)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const callsBeforeRelocationCheck = listener.mock.calls.length
    harness.vault.emit('modify', `${oldRoot}/after.json`)
    harness.vault.emit('modify', `${newRoot}/after.json`)

    expect(listener.mock.calls).toEqual(
      expect.arrayContaining([
        ['during-old'],
        ['during-new'],
        ['old-only'],
        ['new-only'],
        ['after'],
      ]),
    )
    expect(listener).toHaveBeenCalledTimes(callsBeforeRelocationCheck + 1)
  })

  it('relocates from a Vault event before settings notification arrives', () => {
    const harness = createHarness('Old')
    const listener = jest.fn()
    harness.store.subscribeAll(listener)

    harness.setBaseDir('New', false)
    harness.vault.emit(
      'create',
      'New/.yolo_json_db/module-intent/discovered.json',
    )

    expect(listener).toHaveBeenCalledWith('discovered')
  })

  it('gives subscribeAll registration failures retryable cleanup', () => {
    const harness = createHarness()
    harness.vault.failOnRegistration = 3
    harness.vault.failOffOnce = true

    let registrationError: ModuleIntentSubscriptionRegistrationError | undefined
    try {
      harness.store.subscribeAll(jest.fn())
    } catch (error) {
      registrationError = error as ModuleIntentSubscriptionRegistrationError
    }

    expect(registrationError).toBeInstanceOf(
      ModuleIntentSubscriptionRegistrationError,
    )
    expect(registrationError?.registrationCause).toMatchObject({
      message: 'registration failed',
    })
    expect(harness.vault.removed).toHaveLength(0)
    expect(() => registrationError?.cleanup()).not.toThrow()
    expect(harness.vault.removed).toHaveLength(2)
  })

  it('cleans subscribeAll Vault refs when settings registration fails', () => {
    const harness = createHarness()
    harness.failSettingsRegistration()

    let registrationError: ModuleIntentSubscriptionRegistrationError | undefined
    try {
      harness.store.subscribeAll(jest.fn())
    } catch (error) {
      registrationError = error as ModuleIntentSubscriptionRegistrationError
    }

    expect(registrationError).toBeInstanceOf(
      ModuleIntentSubscriptionRegistrationError,
    )
    expect(registrationError?.registrationCause).toMatchObject({
      message: 'settings registration failed',
    })
    expect(harness.vault.removed).toHaveLength(4)
    expect(() => registrationError?.cleanup()).not.toThrow()
    expect(harness.vault.removed).toHaveLength(4)
  })

  it('publishes only exact current module-path events and matching renames', () => {
    const harness = createHarness('Active')
    const listener = jest.fn()
    harness.store.subscribe('notes', listener)
    const target = 'Active/.yolo_json_db/module-intent/notes.json'

    harness.vault.emit('create', target)
    harness.vault.emit('modify', target)
    harness.vault.emit('delete', target)
    harness.vault.emit('modify', `${target}.backup`)
    harness.vault.emit(
      'modify',
      'Active/.yolo_json_db/module-intent/nested/notes.json',
    )
    harness.vault.emit(
      'modify',
      'Active/.yolo_json_db/module-intent/search.json',
    )
    harness.vault.emit('rename', 'other.json', target)
    harness.vault.emit('rename', target, 'other.json')
    harness.vault.emit('rename', 'new.json', 'old.json')

    expect(listener).toHaveBeenCalledTimes(5)
  })

  it('publishes once for a changed root and dynamically switches filtering', () => {
    const harness = createHarness('Old')
    const listener = jest.fn()
    harness.store.subscribe('notes', listener)
    const oldPath = 'Old/.yolo_json_db/module-intent/notes.json'
    const newPath = 'New/.yolo_json_db/module-intent/notes.json'

    harness.setBaseDir('New')
    harness.notifySettingsChange()
    harness.vault.emit('modify', oldPath)
    harness.vault.emit('modify', newPath)

    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('filters events using current settings even before settings notification', () => {
    const harness = createHarness('Old')
    const listener = jest.fn()
    harness.store.subscribe('notes', listener)

    harness.setBaseDir('New', false)
    harness.vault.emit('modify', 'New/.yolo_json_db/module-intent/notes.json')
    harness.vault.emit('modify', 'Old/.yolo_json_db/module-intent/notes.json')

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes synchronously and is idempotent after success', () => {
    const harness = createHarness()
    const listener = jest.fn()
    const unsubscribe = harness.store.subscribe('notes', listener)

    unsubscribe()
    unsubscribe()
    harness.vault.emit('modify', 'YOLO/.yolo_json_db/module-intent/notes.json')
    harness.setBaseDir('Other')

    expect(harness.vault.removed).toHaveLength(4)
    expect(harness.settingsDisposeAttempts).toBe(1)
    expect(listener).not.toHaveBeenCalled()
  })

  it('stops publishing immediately and retries failed cleanup resources', () => {
    const harness = createHarness()
    const listener = jest.fn()
    harness.vault.failOffOnce = true
    harness.failSettingsDisposeOnce()
    const unsubscribe = harness.store.subscribe('notes', listener)

    expect(unsubscribe).toThrow('offref failed')
    harness.vault.emit('modify', 'YOLO/.yolo_json_db/module-intent/notes.json')
    harness.setBaseDir('Other')
    expect(listener).not.toHaveBeenCalled()
    expect(harness.vault.removed).toHaveLength(0)
    expect(harness.settingsDisposeAttempts).toBe(1)

    expect(unsubscribe).not.toThrow()
    expect(harness.vault.removed).toHaveLength(4)
    expect(harness.settingsDisposeAttempts).toBe(2)
    expect(unsubscribe).not.toThrow()
  })

  it('exposes retryable cleanup when registration and rollback both fail', () => {
    const harness = createHarness()
    harness.vault.failOnRegistration = 3
    harness.vault.failOffOnce = true
    const listener = jest.fn()

    let registrationError: ModuleIntentSubscriptionRegistrationError | undefined
    try {
      harness.store.subscribe('notes', listener)
    } catch (error) {
      expect(error).toBeInstanceOf(ModuleIntentSubscriptionRegistrationError)
      registrationError = error as ModuleIntentSubscriptionRegistrationError
    }

    expect(registrationError).toBeDefined()
    expect(registrationError?.registrationCause).toMatchObject({
      message: 'registration failed',
    })
    expect(harness.vault.removed).toHaveLength(0)
    harness.vault.emit('modify', 'YOLO/.yolo_json_db/module-intent/notes.json')
    expect(listener).not.toHaveBeenCalled()

    expect(() => registrationError?.cleanup()).not.toThrow()
    expect(harness.vault.removed).toHaveLength(2)
    expect(() => registrationError?.cleanup()).not.toThrow()
    expect(harness.vault.removed).toHaveLength(2)
  })

  it('cleans Vault refs when settings subscription registration fails', () => {
    const harness = createHarness()
    harness.failSettingsRegistration()

    let registrationError: ModuleIntentSubscriptionRegistrationError | undefined
    try {
      harness.store.subscribe('notes', jest.fn())
    } catch (error) {
      registrationError = error as ModuleIntentSubscriptionRegistrationError
    }

    expect(registrationError).toBeInstanceOf(
      ModuleIntentSubscriptionRegistrationError,
    )
    expect(registrationError?.registrationCause).toMatchObject({
      message: 'settings registration failed',
    })
    expect(harness.vault.removed).toHaveLength(4)
    expect(harness.settingsDisposeAttempts).toBe(0)
    expect(() => registrationError?.cleanup()).not.toThrow()
    expect(harness.vault.removed).toHaveLength(4)
  })

  it('validates module ids before registering subscriptions', () => {
    const harness = createHarness()

    expect(() => harness.store.subscribe('../notes', jest.fn())).toThrow(
      'path segment',
    )
    expect(harness.vault.registrations).toBe(0)
  })
})
