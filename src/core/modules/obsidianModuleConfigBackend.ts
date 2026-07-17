import {
  type App,
  type EventRef,
  type TAbstractFile,
  normalizePath,
} from 'obsidian'

import { getYoloJsonDbRootDir } from '../paths/yoloPaths'

import type { ModuleConfigBackend, ModuleConfigSnapshot } from './moduleConfig'
import { ModuleSettingsStore } from './moduleSettingsStore'
import { assertModuleId } from './moduleStore'
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
