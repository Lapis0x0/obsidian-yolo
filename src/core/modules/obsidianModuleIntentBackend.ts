import {
  type App,
  type DataAdapter,
  type EventRef,
  type TAbstractFile,
  normalizePath,
} from 'obsidian'

import { getYoloJsonDbRootDir } from '../paths/yoloPaths'

import type { ModuleIntentBackend } from './moduleIntentStore'
import { ModuleSettingsStore } from './moduleSettingsStore'
import { assertModuleId } from './moduleStore'
import type { ModuleDisposer } from './types'

const MODULE_INTENT_DIR_NAME = 'module-intent-v1'

export type ObsidianModuleIntentSettings = Readonly<{
  yolo?: Readonly<{
    baseDir?: string
  }>
}>

export type ObsidianModuleIntentBackendOptions = Readonly<{
  app: App
  getSettings(): ObsidianModuleIntentSettings | null
  subscribeSettingsChange(listener: () => void): ModuleDisposer
}>

export class ModuleIntentSubscriptionRegistrationError extends Error {
  readonly registrationCause: unknown
  readonly cleanup: ModuleDisposer

  constructor(registrationCause: unknown, cleanup: ModuleDisposer) {
    super(
      `Module intent subscription registration failed: ${describeError(registrationCause)}`,
    )
    this.name = 'ModuleIntentSubscriptionRegistrationError'
    this.registrationCause = registrationCause
    this.cleanup = cleanup
  }
}

export function createObsidianModuleIntentBackend(
  options: ObsidianModuleIntentBackendOptions,
): ModuleIntentBackend {
  const rootPath = (): string =>
    normalizePath(
      `${getYoloJsonDbRootDir(options.getSettings())}/${MODULE_INTENT_DIR_NAME}`,
    )
  const targetPath = (moduleId: string): string =>
    normalizePath(`${rootPath()}/${moduleId}.json`)

  return Object.freeze({
    capture: () => {
      const captured = Object.freeze({
        kind: 'synchronized-intent' as const,
        adapter: options.app.vault.adapter,
        rootPath: rootPath(),
      })
      new ModuleSettingsStore(captured)
      return captured
    },
    listModuleIds: () => listModuleIdsAt(options.app.vault.adapter, rootPath()),
    subscribe: (moduleId, listener) => {
      assertModuleId(moduleId, 'Module id')
      if (typeof listener !== 'function') {
        throw new TypeError('Module intent listener must be a function')
      }
      let publishing = true
      let settingsPath = targetPath(moduleId)
      let refs: EventRef[] = []
      let unsubscribeSettings: ModuleDisposer | undefined
      const publishIfCurrent = (entry: TAbstractFile): void => {
        if (publishing && entry.path === targetPath(moduleId)) listener()
      }
      const unsubscribe = (): void => {
        publishing = false
        if (refs.length === 0 && unsubscribeSettings === undefined) return
        let firstError: Error | undefined
        const failedRefs: EventRef[] = []
        for (const ref of refs) {
          try {
            options.app.vault.offref(ref)
          } catch (error) {
            failedRefs.push(ref)
            firstError ??= asError(error)
          }
        }
        refs = failedRefs
        if (unsubscribeSettings) {
          try {
            unsubscribeSettings()
            unsubscribeSettings = undefined
          } catch (error) {
            firstError ??= asError(error)
          }
        }
        if (firstError) throw firstError
      }

      try {
        refs.push(options.app.vault.on('create', publishIfCurrent))
        refs.push(options.app.vault.on('modify', publishIfCurrent))
        refs.push(options.app.vault.on('delete', publishIfCurrent))
        refs.push(
          options.app.vault.on('rename', (entry, oldPath) => {
            const current = targetPath(moduleId)
            if (
              publishing &&
              (entry.path === current || normalizePath(oldPath) === current)
            ) {
              listener()
            }
          }),
        )
        unsubscribeSettings = options.subscribeSettingsChange(() => {
          if (!publishing) return
          const nextPath = targetPath(moduleId)
          if (nextPath === settingsPath) return
          settingsPath = nextPath
          listener()
        })
      } catch (error) {
        try {
          unsubscribe()
        } catch {
          // Failed resources remain in `unsubscribe` for caller-driven retry.
        }
        throw new ModuleIntentSubscriptionRegistrationError(error, unsubscribe)
      }
      return unsubscribe
    },
    subscribeAll: (listener) => {
      if (typeof listener !== 'function') {
        throw new TypeError('Module intent listener must be a function')
      }
      let publishing = true
      let currentRoot = rootPath()
      let acceptedRoots = new Set([currentRoot])
      let rootGeneration = 0
      let refs: EventRef[] = []
      let unsubscribeSettings: ModuleDisposer | undefined
      const reconcileRoots = async (
        roots: readonly string[],
        newRoot: string,
        generation: number,
      ): Promise<void> => {
        const listings = await Promise.all(
          roots.map((root) => listModuleIdsAt(options.app.vault.adapter, root)),
        )
        const ids = new Set(listings.flat())
        if (!publishing || generation !== rootGeneration) return
        acceptedRoots = new Set([newRoot])
        for (const moduleId of [...ids].sort()) listener(moduleId)
      }
      const relocateIfNeeded = (): void => {
        if (!publishing) return
        const nextRoot = rootPath()
        if (nextRoot === currentRoot) return
        currentRoot = nextRoot
        acceptedRoots.add(nextRoot)
        const roots = [...acceptedRoots]
        const generation = ++rootGeneration
        void reconcileRoots(roots, nextRoot, generation).catch(() => {
          // Event subscriptions cannot report asynchronous scan failures.
        })
      }
      const publishPath = (path: string): void => {
        if (!publishing) return
        relocateIfNeeded()
        const moduleId = moduleIdFromPath(path, acceptedRoots)
        if (moduleId !== undefined) listener(moduleId)
      }
      const unsubscribe = (): void => {
        publishing = false
        rootGeneration += 1
        if (refs.length === 0 && unsubscribeSettings === undefined) return
        let firstError: Error | undefined
        const failedRefs: EventRef[] = []
        for (const ref of refs) {
          try {
            options.app.vault.offref(ref)
          } catch (error) {
            failedRefs.push(ref)
            firstError ??= asError(error)
          }
        }
        refs = failedRefs
        if (unsubscribeSettings) {
          try {
            unsubscribeSettings()
            unsubscribeSettings = undefined
          } catch (error) {
            firstError ??= asError(error)
          }
        }
        if (firstError) throw firstError
      }

      try {
        refs.push(
          options.app.vault.on('create', (entry) => publishPath(entry.path)),
        )
        refs.push(
          options.app.vault.on('modify', (entry) => publishPath(entry.path)),
        )
        refs.push(
          options.app.vault.on('delete', (entry) => publishPath(entry.path)),
        )
        refs.push(
          options.app.vault.on('rename', (entry, oldPath) => {
            publishPath(oldPath)
            publishPath(entry.path)
          }),
        )
        unsubscribeSettings = options.subscribeSettingsChange(() => {
          relocateIfNeeded()
        })
      } catch (error) {
        try {
          unsubscribe()
        } catch {
          // Failed resources remain in `unsubscribe` for caller-driven retry.
        }
        throw new ModuleIntentSubscriptionRegistrationError(error, unsubscribe)
      }
      return unsubscribe
    },
  })
}

async function listModuleIdsAt(
  adapter: DataAdapter,
  rootPath: string,
): Promise<readonly string[]> {
  if (!(await adapter.exists(rootPath))) return []
  const listing = await adapter.list(rootPath)
  const roots = new Set([rootPath])
  return [
    ...new Set(
      listing.files.flatMap((path) => {
        const moduleId = moduleIdFromPath(path, roots)
        return moduleId === undefined ? [] : [moduleId]
      }),
    ),
  ].sort()
}

function moduleIdFromPath(
  value: string,
  roots: ReadonlySet<string>,
): string | undefined {
  const path = normalizePath(value)
  for (const root of roots) {
    const prefix = `${root}/`
    if (!path.startsWith(prefix)) continue
    const fileName = path.slice(prefix.length)
    if (fileName.includes('/') || !fileName.endsWith('.json')) continue
    const moduleId = fileName.slice(0, -'.json'.length)
    try {
      assertModuleId(moduleId, 'Module id')
      return moduleId
    } catch {
      continue
    }
  }
  return undefined
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function describeError(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
