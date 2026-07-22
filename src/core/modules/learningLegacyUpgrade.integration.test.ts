jest.mock('obsidian', () => ({
  normalizePath: (path: string) =>
    path.replace(/\\/g, '/').replace(/\/{2,}/g, '/'),
}))

import { migrateLearningLegacyInstallIntent } from './learningLegacyInstallMigration'
import { handoffLearningLegacySettings } from './learningModuleSettingsHandoff'
import { ModuleIntentStore } from './moduleIntentStore'
import {
  ModuleSettingsStore,
  type SynchronizedModuleSettingsBackend,
} from './moduleSettingsStore'

class MemoryAdapter {
  readonly files = new Map<string, string>()
  readonly folders = new Set<string>()

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
    if (this.files.has(path)) throw new Error(`File already exists: ${path}`)
    this.files.set(path, data)
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path)
  }
}

function backend(
  adapter: MemoryAdapter,
  rootPath: string,
): SynchronizedModuleSettingsBackend {
  return {
    kind: 'synchronized-intent',
    adapter,
    create: (path, data) => adapter.create(path, data),
    rootPath,
  }
}

function createUpgradeHarness() {
  const adapter = new MemoryAdapter()
  const config = new ModuleSettingsStore(
    backend(adapter, 'YOLO/.yolo_json_db/module-settings'),
  )
  const intentBackend = backend(adapter, 'YOLO/.yolo_json_db/module-intent-v1')
  const intents = new ModuleIntentStore({
    capture: () => intentBackend,
    listModuleIds: async () => [],
    subscribe: () => () => undefined,
    subscribeAll: () => () => undefined,
  })
  return { adapter, config, intents }
}

describe('Learning upgrade from Core 1.6.0.3', () => {
  it('hands off settings and enables Learning for an existing user', async () => {
    const harness = createUpgradeHarness()
    const dataJson = JSON.parse(`{
      "version": 75,
      "learningOptions": {
        "modelId": "openai/gpt-5",
        "betaNoticeAcknowledged": true
      }
    }`) as Record<string, unknown>
    const legacy = dataJson.learningOptions

    await handoffLearningLegacySettings(
      (moduleId, envelope) => harness.config.createIfAbsent(moduleId, envelope),
      legacy,
    )
    await migrateLearningLegacyInstallIntent({
      adapter: harness.adapter,
      settings: { yolo: { baseDir: 'YOLO' } },
      legacySettings: legacy,
      enableIfAbsent: (moduleId) =>
        harness.intents.setIfAbsent(moduleId, 'enabled'),
    })

    await expect(harness.config.read('learning')).resolves.toEqual({
      schemaVersion: 0,
      data: {
        modelId: 'openai/gpt-5',
        betaNoticeAcknowledged: true,
      },
    })
    await expect(harness.intents.get('learning')).resolves.toBe('enabled')
  })

  it('does not install Learning for a never-used 1.6.0.3 user', async () => {
    const harness = createUpgradeHarness()
    const dataJson = JSON.parse(`{
      "version": 75,
      "learningOptions": {
        "modelId": "openai/automatically-normalized-default",
        "betaNoticeAcknowledged": false
      }
    }`) as Record<string, unknown>

    await migrateLearningLegacyInstallIntent({
      adapter: harness.adapter,
      settings: { yolo: { baseDir: 'YOLO' } },
      legacySettings: dataJson.learningOptions,
      enableIfAbsent: (moduleId) =>
        harness.intents.setIfAbsent(moduleId, 'enabled'),
    })

    await expect(harness.intents.get('learning')).resolves.toBeUndefined()
  })

  it('uses persisted project data when legacy settings are inconclusive', async () => {
    const harness = createUpgradeHarness()
    harness.adapter.folders.add('YOLO/learning')

    await migrateLearningLegacyInstallIntent({
      adapter: harness.adapter,
      settings: { yolo: { baseDir: 'YOLO' } },
      legacySettings: undefined,
      enableIfAbsent: (moduleId) =>
        harness.intents.setIfAbsent(moduleId, 'enabled'),
    })

    await expect(harness.intents.get('learning')).resolves.toBe('enabled')
  })

  it('does not override a later explicit uninstall', async () => {
    const harness = createUpgradeHarness()
    await harness.intents.set('learning', 'uninstalled')

    await migrateLearningLegacyInstallIntent({
      adapter: harness.adapter,
      settings: { yolo: { baseDir: 'YOLO' } },
      legacySettings: { betaNoticeAcknowledged: true },
      enableIfAbsent: (moduleId) =>
        harness.intents.setIfAbsent(moduleId, 'enabled'),
    })

    await expect(harness.intents.get('learning')).resolves.toBe('uninstalled')
  })
})
