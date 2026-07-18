import {
  type App,
  type EventRef,
  type TAbstractFile,
  normalizePath,
} from 'obsidian'

import { getYoloJsonDbRootDir } from '../paths/yoloPaths'

import type { ModuleConfigBackend, ModuleConfigSnapshot } from './moduleConfig'
import {
  type ModuleDataEnvelope,
  ModuleSettingsStore,
} from './moduleSettingsStore'
import { assertModuleId } from './moduleStore'
import {
  type ModuleTransitionSettingsLocation,
  type ModuleTransitionSettingsSnapshot,
  parseModuleTransitionSettingsLocation,
} from './moduleTransitionJournal'
import type { ModuleDisposer } from './types'

const MODULE_SETTINGS_DIR_NAME = 'module-settings'
const EMPTY_MODULE_CONFIG = Object.freeze({
  schemaVersion: 0,
  data: Object.freeze({}),
})

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

export type CapturedModuleSettingsLocation = ModuleTransitionSettingsLocation

export type CapturedModuleTransitionSettings = Readonly<{
  location: CapturedModuleSettingsLocation
  snapshot: ModuleTransitionSettingsSnapshot
}>

export type ObsidianModuleTransitionSettingsBackend = Readonly<{
  capture(moduleId: string): Promise<CapturedModuleTransitionSettings>
  readAtCapturedLocation(
    location: CapturedModuleSettingsLocation,
  ): Promise<ModuleTransitionSettingsSnapshot>
  writeVerifiedAtCapturedLocation(
    location: CapturedModuleSettingsLocation,
    snapshot: ModuleTransitionSettingsSnapshot,
  ): Promise<ModuleTransitionSettingsSnapshot>
}>

export function createObsidianModuleConfigBackendFactory<T = unknown>(
  options: ObsidianModuleConfigBackendFactoryOptions,
): (moduleId: string) => ModuleConfigBackend<T> {
  return (moduleId) => {
    assertModuleId(moduleId, 'Module id')

    const rootPath = (): string =>
      normalizePath(
        `${getYoloJsonDbRootDir(options.getSettings())}/${MODULE_SETTINGS_DIR_NAME}`,
      )
    const targetPath = (): string =>
      normalizePath(`${rootPath()}/${moduleId}.json`)
    const createStore = (): ModuleSettingsStore =>
      new ModuleSettingsStore({
        kind: 'synchronized-intent',
        adapter: options.app.vault.adapter,
        rootPath: rootPath(),
      })

    return Object.freeze({
      read: async () =>
        (await createStore().read<T>(moduleId)) ??
        (EMPTY_MODULE_CONFIG as ModuleConfigSnapshot<T>),
      write: async (next) => createStore().write(moduleId, next),
      subscribe: (listener) => {
        if (typeof listener !== 'function') {
          throw new TypeError(
            'Module config backend listener must be a function',
          )
        }

        let subscribed = true
        let settingsPath = targetPath()
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
            listener()
          })
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
}

/**
 * Exact settings-file access for transition coordination. Captured locations
 * deliberately remain independent of subsequent base-directory changes.
 *
 * DataAdapter has no compare-and-swap primitive. Admission freshness and future
 * recovery must recheck this exact location; process serialization cannot
 * exclude an external sync writer between reads and writes.
 */
export function createObsidianModuleTransitionSettingsBackend(
  options: Pick<
    ObsidianModuleConfigBackendFactoryOptions,
    'app' | 'getSettings'
  >,
): ObsidianModuleTransitionSettingsBackend {
  const createStore = (storageRoot: string): ModuleSettingsStore =>
    new ModuleSettingsStore({
      kind: 'synchronized-intent',
      adapter: options.app.vault.adapter,
      rootPath: storageRoot,
    })
  const captureLocation = (
    moduleId: string,
  ): CapturedModuleSettingsLocation => {
    assertModuleId(moduleId, 'Module id')
    const storageRoot = normalizeStorageIdentity(
      `${getYoloJsonDbRootDir(options.getSettings())}/${MODULE_SETTINGS_DIR_NAME}`,
    )
    // Construction applies the shared module-storage root validation.
    createStore(storageRoot)
    return Object.freeze({
      moduleId,
      storageRoot,
      storagePath: normalizePath(`${storageRoot}/${moduleId}.json`),
    })
  }
  const storeAt = (
    value: CapturedModuleSettingsLocation,
  ): Readonly<{
    location: CapturedModuleSettingsLocation
    store: ModuleSettingsStore
  }> => {
    const location = parseModuleTransitionSettingsLocation(value)
    return { location, store: createStore(location.storageRoot) }
  }
  const readAt = async (
    value: CapturedModuleSettingsLocation,
  ): Promise<ModuleTransitionSettingsSnapshot> => {
    const { location, store } = storeAt(value)
    const envelope = await store.read(location.moduleId)
    return snapshotFromEnvelope(envelope)
  }

  return Object.freeze({
    capture: async (moduleId) => {
      // Resolve and bind the current base directory before the first await.
      const location = captureLocation(moduleId)
      const snapshot = await readAt(location)
      return Object.freeze({ location, snapshot })
    },
    readAtCapturedLocation: readAt,
    writeVerifiedAtCapturedLocation: async (value, snapshot) => {
      const { location, store } = storeAt(value)
      const parsed = parseTransitionSnapshot(snapshot)
      if (!parsed.present) {
        await store.remove(location.moduleId)
        return ABSENT_TRANSITION_SETTINGS
      }
      const envelope = await store.write(location.moduleId, parsed.envelope)
      return snapshotFromEnvelope(envelope)
    },
  })
}

const ABSENT_TRANSITION_SETTINGS: ModuleTransitionSettingsSnapshot =
  Object.freeze({ present: false, envelope: null })

function normalizeStorageIdentity(value: string): string {
  return normalizePath(value)
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
}

function snapshotFromEnvelope(
  envelope: ModuleDataEnvelope | null,
): ModuleTransitionSettingsSnapshot {
  return envelope === null
    ? ABSENT_TRANSITION_SETTINGS
    : Object.freeze({ present: true, envelope })
}

function parseTransitionSnapshot(
  value: ModuleTransitionSettingsSnapshot,
): ModuleTransitionSettingsSnapshot {
  assertExactPlainObject(
    value,
    ['present', 'envelope'],
    'Module transition settings snapshot',
  )
  const present = dataProperty(value, 'present')
  const envelope = dataProperty(value, 'envelope')
  if (present === false && envelope === null) return ABSENT_TRANSITION_SETTINGS
  if (present !== true || envelope === null || typeof envelope !== 'object') {
    throw new Error('Module transition settings snapshot is invalid')
  }
  return Object.freeze({
    present: true,
    envelope: envelope as ModuleDataEnvelope,
  })
}

function assertExactPlainObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is object {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new TypeError(`${label} must be a plain object`)
  }
  const names = Object.getOwnPropertyNames(value)
  if (
    names.length !== keys.length ||
    !keys.every((key) => names.includes(key))
  ) {
    throw new Error(`${label} has invalid fields`)
  }
}

function dataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError(`${key} must be an enumerable data property`)
  }
  return descriptor.value
}
