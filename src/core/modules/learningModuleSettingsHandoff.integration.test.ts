jest.mock('obsidian', () => ({
  ItemView: class {},
  normalizePath: (path: string) =>
    path.replace(/\\/g, '/').replace(/\/{2,}/g, '/'),
}))

import type { App, DataAdapter, EventRef, TAbstractFile, Vault } from 'obsidian'

import { BackgroundActivityRegistry } from '../background/backgroundActivityRegistry'

import { CoreModuleHostCapabilityProvider } from './hostCapabilities'
import { handoffLearningLegacySettings } from './learningModuleSettingsHandoff'
import { ModuleLifecycleScope } from './lifecycleScope'
import { ModuleConfigCapabilityProvider } from './moduleConfig'
import { ModuleRuntime } from './moduleRuntime'
import {
  type ObsidianModuleConfigSettings,
  createObsidianModuleConfigBackendFactory,
} from './obsidianModuleConfigBackend'

type VaultEvent = 'create' | 'modify' | 'delete' | 'rename'
type EventHandler = (entry: TAbstractFile, oldPath?: string) => void

const LEARNING_CONFIG_PATH = (baseDir: string): string =>
  `${baseDir}/.yolo_json_db/module-settings/learning.json`

class MemoryAdapter {
  readonly files = new Map<string, string>()
  readonly folders = new Set<string>()
  createError: Error | undefined

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
    this.files.set(path, data)
  }

  async create(path: string, data: string): Promise<void> {
    if (this.createError) throw this.createError
    if (this.files.has(path)) throw new Error(`File already exists: ${path}`)
    this.files.set(path, data)
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path)
  }
}

class MemoryVault {
  private nextRef = 0
  private readonly handlers = new Map<EventRef, EventHandler>()

  constructor(readonly adapter: DataAdapter) {}

  async create(path: string, data: string): Promise<{ path: string }> {
    await (this.adapter as unknown as MemoryAdapter).create(path, data)
    return { path }
  }

  on(_event: VaultEvent, handler: EventHandler): EventRef {
    const ref = { id: ++this.nextRef } as unknown as EventRef
    this.handlers.set(ref, handler)
    return ref
  }

  offref(ref: EventRef): void {
    this.handlers.delete(ref)
  }
}

function createHarness(initialBaseDir = 'One') {
  const adapter = new MemoryAdapter()
  const vault = new MemoryVault(adapter as unknown as DataAdapter)
  let settings: ObsidianModuleConfigSettings = {
    yolo: { baseDir: initialBaseDir },
  }
  const settingsListeners = new Set<() => void>()
  const factory = createObsidianModuleConfigBackendFactory({
    app: { vault: vault as unknown as Vault } as App,
    getSettings: () => settings,
    subscribeSettingsChange: (listener) => {
      settingsListeners.add(listener)
      return () => settingsListeners.delete(listener)
    },
  })

  return {
    adapter,
    factory,
    setBaseDir(baseDir: string) {
      settings = { yolo: { baseDir } }
      for (const listener of [...settingsListeners]) listener()
    },
  }
}

describe('Learning module settings handoff integration', () => {
  it('seeds an absent config and carries the legacy values through the module config activation', async () => {
    const harness = createHarness()
    const legacy = {
      modelId: 'provider/legacy',
      betaNoticeAcknowledged: true,
    }

    await expect(
      handoffLearningLegacySettings(harness.factory.createIfAbsent, legacy),
    ).resolves.toBe('created')
    await expect(harness.factory('learning').read()).resolves.toEqual({
      schemaVersion: 0,
      data: legacy,
    })

    const lifecycle = new ModuleLifecycleScope()
    const config = new ModuleConfigCapabilityProvider({
      createBackend: harness.factory,
    }).create('learning', lifecycle)
    await config.activate()
    expect(config.api.getSnapshot()).toEqual({ schemaVersion: 0, data: legacy })

    await expect(
      config.api.replace({ schemaVersion: 1, data: legacy }),
    ).resolves.toEqual({ schemaVersion: 1, data: legacy })
    await expect(harness.factory('learning').read()).resolves.toEqual({
      schemaVersion: 1,
      data: legacy,
    })
    lifecycle.dispose()
  })

  it('does not replace an existing schema-zero or schema-one config', async () => {
    const harness = createHarness()
    const backend = harness.factory('learning')
    const existingSchemaZero = {
      schemaVersion: 0,
      data: { modelId: 'existing/zero', betaNoticeAcknowledged: false },
    }
    await backend.write(existingSchemaZero)

    await expect(
      handoffLearningLegacySettings(harness.factory.createIfAbsent, {
        modelId: 'legacy/ignored',
        betaNoticeAcknowledged: true,
      }),
    ).resolves.toBe('already-present')
    await expect(backend.read()).resolves.toEqual(existingSchemaZero)

    const existingSchemaOne = {
      schemaVersion: 1,
      data: { modelId: 'existing/one', betaNoticeAcknowledged: true },
    }
    await backend.write(existingSchemaOne)
    await expect(
      handoffLearningLegacySettings(harness.factory.createIfAbsent, {
        modelId: 'legacy/still-ignored',
        betaNoticeAcknowledged: false,
      }),
    ).resolves.toBe('already-present')
    await expect(backend.read()).resolves.toEqual(existingSchemaOne)
  })

  it('resolves the current base directory for each handoff and config operation', async () => {
    const harness = createHarness('First')
    const backend = harness.factory('learning')
    const first = {
      modelId: 'provider/first',
      betaNoticeAcknowledged: false,
    }
    const second = {
      modelId: 'provider/second',
      betaNoticeAcknowledged: true,
    }

    await handoffLearningLegacySettings(harness.factory.createIfAbsent, first)
    harness.setBaseDir('Second')
    await expect(backend.read()).resolves.toEqual({
      schemaVersion: 0,
      data: {},
    })
    await expect(
      handoffLearningLegacySettings(harness.factory.createIfAbsent, second),
    ).resolves.toBe('created')
    await backend.write({ schemaVersion: 1, data: second })

    expect(
      JSON.parse(harness.adapter.files.get(LEARNING_CONFIG_PATH('First'))!),
    ).toEqual({ schemaVersion: 0, data: first })
    expect(
      JSON.parse(harness.adapter.files.get(LEARNING_CONFIG_PATH('Second'))!),
    ).toEqual({ schemaVersion: 1, data: second })
  })

  it('gates only Learning activation when the handoff fails', async () => {
    const harness = createHarness()
    harness.adapter.createError = new Error('vault is read only')
    let handoffReady = false
    const performHandoff = async (): Promise<void> => {
      await handoffLearningLegacySettings(harness.factory.createIfAbsent, {
        modelId: 'provider/legacy',
        betaNoticeAcknowledged: false,
      })
      handoffReady = true
    }
    await expect(performHandoff()).rejects.toThrow('vault is read only')

    const commit = jest.fn()
    const configProvider = new ModuleConfigCapabilityProvider({
      createBackend: (moduleId) => {
        if (moduleId === 'learning' && !handoffReady) {
          throw new Error('Learning module settings handoff is incomplete')
        }
        return harness.factory(moduleId)
      },
    })
    const runtime = new ModuleRuntime(
      { commit },
      new CoreModuleHostCapabilityProvider({
        backgroundActivities: new BackgroundActivityRegistry(),
        config: configProvider,
      }),
    )
    const learningActivate = jest.fn()

    await expect(
      runtime.activate({ id: 'learning', activate: learningActivate }),
    ).rejects.toThrow('Learning module settings handoff is incomplete')
    expect(learningActivate).not.toHaveBeenCalled()
    expect(runtime.isActive('learning')).toBe(false)
    expect(commit).not.toHaveBeenCalled()

    await expect(
      runtime.activate({ id: 'notes', activate: () => undefined }),
    ).resolves.toBeUndefined()
    expect(runtime.isActive('notes')).toBe(true)
    expect(commit).toHaveBeenCalledTimes(1)
    runtime.dispose()
  })
})
