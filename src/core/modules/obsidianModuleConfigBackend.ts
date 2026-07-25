import {
  type App,
  type EventRef,
  type TAbstractFile,
  normalizePath,
} from 'obsidian'

import { getYoloJsonDbRootDir } from '../paths/yoloPaths'

import type { ModuleConfigBackend, ModuleConfigSnapshot } from './moduleConfig'
import {
  type ModuleCreateIfAbsentResult,
  type ModuleDataEnvelope,
  ModuleSettingsStore,
} from './moduleSettingsStore'
import { assertModuleId } from './moduleStore'
import type { ModuleDisposer } from './types'

const MODULE_SETTINGS_DIR_NAME = 'module-settings'
const EMPTY_MODULE_CONFIG = Object.freeze({
  schemaVersion: 0,
  data: Object.freeze({}),
})
const configWriteListeners = new WeakMap<App, Map<string, Set<() => void>>>()

function publishConfigWrite(app: App, path: string): void {
  for (const listener of configWriteListeners.get(app)?.get(path) ?? []) {
    try {
      listener()
    } catch (error) {
      console.error('[YOLO] Module config write listener failed', {
        path,
        error,
      })
    }
  }
}

function subscribeConfigWrite(app: App, path: string, listener: () => void) {
  let byPath = configWriteListeners.get(app)
  if (!byPath) {
    byPath = new Map()
    configWriteListeners.set(app, byPath)
  }
  const listeners = byPath.get(path) ?? new Set<() => void>()
  listeners.add(listener)
  byPath.set(path, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) byPath.delete(path)
  }
}

export type ObsidianModuleConfigSettings = Readonly<{
  yolo?: Readonly<{
    baseDir?: string
  }>
}>

export type ObsidianModuleConfigBackendFactoryOptions = Readonly<{
  app: App
  getSettings(): ObsidianModuleConfigSettings | null
  subscribeSettingsChange(listener: () => void): ModuleDisposer
}>

export type ObsidianModuleConfigBackendFactory<T = unknown> = ((
  moduleId: string,
) => ModuleConfigBackend<T>) &
  Readonly<{
    createIfAbsent: ObsidianModuleConfigCreateIfAbsent<T>
  }>

export type ObsidianModuleConfigCreateIfAbsent<T = unknown> = (
  moduleId: string,
  envelope: ModuleDataEnvelope<T>,
) => Promise<ModuleCreateIfAbsentResult>

export function createObsidianModuleConfigBackendFactory<T = unknown>(
  options: ObsidianModuleConfigBackendFactoryOptions,
): ObsidianModuleConfigBackendFactory<T> {
  const rootPath = (): string =>
    normalizePath(
      `${getYoloJsonDbRootDir(options.getSettings())}/${MODULE_SETTINGS_DIR_NAME}`,
    )
  const createStore = (capturedRoot: string): ModuleSettingsStore =>
    new ModuleSettingsStore({
      kind: 'synchronized-intent',
      adapter: options.app.vault.adapter,
      rootPath: capturedRoot,
    })

  const factory = (moduleId: string): ModuleConfigBackend<T> => {
    assertModuleId(moduleId, 'Module id')

    const targetPath = (): string =>
      normalizePath(`${rootPath()}/${moduleId}.json`)

    return Object.freeze({
      read: async () =>
        (await createStore(rootPath()).read<T>(moduleId)) ??
        (EMPTY_MODULE_CONFIG as ModuleConfigSnapshot<T>),
      write: async (next) => createStore(rootPath()).write(moduleId, next),
      subscribe: (listener) => {
        if (typeof listener !== 'function') {
          throw new TypeError(
            'Module config backend listener must be a function',
          )
        }

        let subscribed = true
        let settingsPath = targetPath()
        let unsubscribeWrite: (() => void) | undefined
        const refs: EventRef[] = []
        let unsubscribeSettings: ModuleDisposer | undefined
        const publishIfCurrent = (entry: TAbstractFile): void => {
          if (subscribed && entry.path === targetPath()) listener()
        }
        const unsubscribe = (): void => {
          if (!subscribed) return
          subscribed = false
          let firstError: Error | undefined
          for (const ref of refs.splice(0)) {
            try {
              options.app.vault.offref(ref)
            } catch (error) {
              firstError ??=
                error instanceof Error ? error : new Error(String(error))
            }
          }
          const disposeSettings = unsubscribeSettings
          unsubscribeSettings = undefined
          try {
            disposeSettings?.()
          } catch (error) {
            firstError ??=
              error instanceof Error ? error : new Error(String(error))
          }
          unsubscribeWrite?.()
          unsubscribeWrite = undefined
          if (firstError !== undefined) throw firstError
        }

        try {
          refs.push(
            options.app.vault.on('create', publishIfCurrent),
            options.app.vault.on('modify', publishIfCurrent),
            options.app.vault.on('delete', publishIfCurrent),
            options.app.vault.on('rename', (entry, oldPath) => {
              if (
                subscribed &&
                (entry.path === targetPath() ||
                  normalizePath(oldPath) === targetPath())
              ) {
                listener()
              }
            }),
          )
          unsubscribeSettings = options.subscribeSettingsChange(() => {
            if (!subscribed) return
            const nextPath = targetPath()
            if (nextPath === settingsPath) return
            settingsPath = nextPath
            unsubscribeWrite?.()
            unsubscribeWrite = subscribeConfigWrite(
              options.app,
              settingsPath,
              listener,
            )
            listener()
          })
          unsubscribeWrite = subscribeConfigWrite(
            options.app,
            settingsPath,
            listener,
          )
        } catch (error) {
          try {
            unsubscribe()
          } catch {
            // Preserve the registration error; cleanup has already been attempted.
          }
          throw error
        }

        return unsubscribe
      },
    })
  }

  return Object.freeze(
    Object.assign(factory, {
      createIfAbsent: createObsidianModuleConfigCreateIfAbsent<T>(options),
    }),
  )
}

export function createObsidianModuleConfigCreateIfAbsent<T = unknown>(
  options: Pick<
    ObsidianModuleConfigBackendFactoryOptions,
    'app' | 'getSettings'
  >,
): ObsidianModuleConfigCreateIfAbsent<T> {
  return (moduleId, envelope) => {
    assertModuleId(moduleId, 'Module id')
    // Capture the active base directory before createIfAbsent can yield.
    // Vault.create excludes locally visible files; it cannot arbitrate a
    // remote sync write that has not reached this device yet.
    const capturedRoot = normalizePath(
      `${getYoloJsonDbRootDir(options.getSettings())}/${MODULE_SETTINGS_DIR_NAME}`,
    )
    const store = new ModuleSettingsStore({
      kind: 'synchronized-intent',
      adapter: options.app.vault.adapter,
      create: async (path, data) => {
        await options.app.vault.create(path, data)
      },
      rootPath: capturedRoot,
    })
    return store.createIfAbsent(moduleId, envelope)
  }
}

/**
 * Reads every synchronized module configuration envelope without knowing any
 * module implementation. Module intent and module-private storage deliberately
 * use different roots and are not included here.
 */
export async function readObsidianModuleConfigEnvelopes(
  app: App,
  settings: ObsidianModuleConfigSettings | null,
): Promise<Record<string, ModuleDataEnvelope>> {
  const rootPath = normalizePath(
    `${getYoloJsonDbRootDir(settings)}/${MODULE_SETTINGS_DIR_NAME}`,
  )
  const adapter = app.vault.adapter
  if (!(await adapter.exists(rootPath))) return {}
  const listing = await adapter.list(rootPath)
  const store = new ModuleSettingsStore({
    kind: 'synchronized-intent',
    adapter,
    rootPath,
  })
  const entries: Record<string, ModuleDataEnvelope> = {}
  for (const path of listing.files) {
    if (!path.startsWith(`${rootPath}/`) || !path.endsWith('.json')) continue
    const moduleId = path.slice(rootPath.length + 1, -'.json'.length)
    assertModuleId(moduleId, 'Module config id')
    const envelope = await store.read(moduleId)
    if (envelope !== null) entries[moduleId] = envelope
  }
  return entries
}

/**
 * Writes imported synchronized module configuration to the supplied settings
 * root. Each envelope is verified by ModuleSettingsStore; callers must report
 * a later failure as a partial import because Host and module stores cannot be
 * made transactional across sync backends. Each listed module id is replaced;
 * module ids absent from the import are intentionally left unchanged.
 */
export async function writeObsidianModuleConfigEnvelopes(
  app: App,
  settings: ObsidianModuleConfigSettings | null,
  entries: Readonly<Record<string, ModuleDataEnvelope>>,
): Promise<void> {
  const rootPath = normalizePath(
    `${getYoloJsonDbRootDir(settings)}/${MODULE_SETTINGS_DIR_NAME}`,
  )
  const store = new ModuleSettingsStore({
    kind: 'synchronized-intent',
    adapter: app.vault.adapter,
    rootPath,
  })
  for (const [moduleId, envelope] of Object.entries(entries)) {
    assertModuleId(moduleId, 'Module config id')
    await store.write(moduleId, envelope)
    publishConfigWrite(app, normalizePath(`${rootPath}/${moduleId}.json`))
  }
}
