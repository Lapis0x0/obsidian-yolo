import { App, type EventRef, TFile, TFolder, normalizePath } from 'obsidian'

import type { ModuleLifecycleScope } from './lifecycleScope'
import type {
  YoloModuleVaultEntryV1,
  YoloModuleVaultEventV1,
  YoloModuleVaultFileV1,
  YoloModuleVaultV1,
} from './types'

export type ModuleVaultCapabilityActivationV1 = Readonly<{
  api: YoloModuleVaultV1
  activate(): void
}>

export type ModuleVaultCapabilityProviderV1 = {
  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): ModuleVaultCapabilityActivationV1
}

type ObsidianModuleVaultCapabilityProviderOptions = {
  reportListenerError?: (moduleId: string, error: unknown) => void
}

class ModuleVaultCleanupError extends Error {
  constructor(
    message: string,
    readonly errors: unknown[],
  ) {
    super(message)
    this.name = 'ModuleVaultCleanupError'
  }
}

export class ObsidianModuleVaultCapabilityProvider
  implements ModuleVaultCapabilityProviderV1
{
  private readonly reportListenerError: (
    moduleId: string,
    error: unknown,
  ) => void

  constructor(
    private readonly app: App,
    {
      reportListenerError = (moduleId, error) => {
        console.error(
          `[YOLO] Module "${moduleId}" vault listener failed`,
          error,
        )
      },
    }: ObsidianModuleVaultCapabilityProviderOptions = {},
  ) {
    this.reportListenerError = reportListenerError
  }

  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): ModuleVaultCapabilityActivationV1 {
    return createObsidianModuleVaultCapability({
      app: this.app,
      moduleId,
      lifecycle,
      reportListenerError: this.reportListenerError,
    })
  }
}

export const UNAVAILABLE_MODULE_VAULT_CAPABILITY_PROVIDER: ModuleVaultCapabilityProviderV1 =
  Object.freeze({
    create: () => ({
      api: UNAVAILABLE_MODULE_VAULT_API,
      activate: () => undefined,
    }),
  })

const UNAVAILABLE_MODULE_VAULT_API: YoloModuleVaultV1 = Object.freeze({
  getEntry: () => unavailable(),
  listChildren: () => unavailable(),
  listMarkdownFiles: () => unavailable(),
  exists: () => Promise.reject(new Error('Module vault is unavailable')),
  readText: () => Promise.reject(new Error('Module vault is unavailable')),
  readBinary: () => Promise.reject(new Error('Module vault is unavailable')),
  subscribe: () => unavailable(),
})

function createObsidianModuleVaultCapability({
  app,
  moduleId,
  lifecycle,
  reportListenerError,
}: {
  app: App
  moduleId: string
  lifecycle: ModuleLifecycleScope
  reportListenerError: (moduleId: string, error: unknown) => void
}): ModuleVaultCapabilityActivationV1 {
  const subscriptionCleanups = new Set<() => void>()
  let disposed = false
  let deactivating = false
  let activationComplete = false
  lifecycle.add(() => {
    disposed = true
    const errors: unknown[] = []
    for (const cleanup of subscriptionCleanups) {
      try {
        cleanup()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) {
      throw new ModuleVaultCleanupError(
        'Module vault lifecycle cleanup reported errors',
        errors,
      )
    }
  })

  const assertAvailable = (): void => {
    if (disposed || deactivating) {
      throw new Error(`Module "${moduleId}" vault is not active`)
    }
  }
  const reportError = (error: unknown): void => {
    try {
      reportListenerError(moduleId, error)
    } catch {
      // Error reporting must not let module listeners escape the host boundary.
    }
  }
  const publish = (
    subscribed: () => boolean,
    listener: (event: YoloModuleVaultEventV1) => void | Promise<void>,
    event: YoloModuleVaultEventV1,
  ): void => {
    if (disposed || deactivating || !activationComplete || !subscribed()) {
      return
    }
    try {
      const result = listener(event)
      if (isThenable(result)) {
        void Promise.resolve(result).catch(reportError)
      }
    } catch (error) {
      reportError(error)
    }
  }

  const api: YoloModuleVaultV1 = Object.freeze({
    getEntry: (path) => {
      assertAvailable()
      const entry = app.vault.getAbstractFileByPath(
        normalizeModuleVaultPath(path, true),
      )
      return isVaultEntry(entry) ? describeEntry(entry) : null
    },
    listChildren: (folderPath) => {
      assertAvailable()
      const entry = app.vault.getAbstractFileByPath(
        normalizeModuleVaultPath(folderPath, true),
      )
      if (!(entry instanceof TFolder)) return Object.freeze([])
      return Object.freeze(entry.children.map(describeEntry))
    },
    listMarkdownFiles: () => {
      assertAvailable()
      return Object.freeze(app.vault.getMarkdownFiles().map(describeFile))
    },
    exists: async (path) => {
      assertAvailable()
      return Boolean(
        app.vault.getAbstractFileByPath(normalizeModuleVaultPath(path, true)),
      )
    },
    readText: async (filePath) => {
      assertAvailable()
      const path = normalizeModuleVaultPath(filePath)
      const entry = app.vault.getAbstractFileByPath(path)
      if (!(entry instanceof TFile)) {
        throw new Error(`Module vault file not found: ${path}`)
      }
      return app.vault.cachedRead(entry)
    },
    readBinary: async (filePath) => {
      assertAvailable()
      const path = normalizeModuleVaultPath(filePath)
      const entry = app.vault.getAbstractFileByPath(path)
      if (!(entry instanceof TFile)) {
        throw new Error(`Module vault file not found: ${path}`)
      }
      const bytes = await app.vault.readBinary(entry)
      return bytes.slice(0)
    },
    subscribe: (scopePath, listener) => {
      assertAvailable()
      if (typeof listener !== 'function') {
        throw new TypeError('Module vault listener must be a function')
      }
      const scope = normalizeModuleVaultPath(scopePath, true)
      let subscribed = true
      const isSubscribed = () => subscribed
      const refs = new Set<EventRef>()
      const unsubscribe = () => {
        if (refs.size === 0) return
        subscribed = false
        const errors: unknown[] = []
        for (const ref of refs) {
          try {
            app.vault.offref(ref)
            refs.delete(ref)
          } catch (error) {
            errors.push(error)
          }
        }
        if (refs.size === 0) subscriptionCleanups.delete(unsubscribe)
        if (errors.length > 0) {
          throw new ModuleVaultCleanupError(
            'Module vault subscription cleanup reported errors',
            errors,
          )
        }
      }
      subscriptionCleanups.add(unsubscribe)
      try {
        refs.add(
          app.vault.on('create', (entry) => {
            if (
              !isVaultEntry(entry) ||
              !doesPathAffectScope(entry.path, scope)
            ) {
              return
            }
            publish(isSubscribed, listener, freezeEvent('create', entry))
          }),
        )
        refs.add(
          app.vault.on('modify', (entry) => {
            if (
              !isVaultEntry(entry) ||
              !doesPathAffectScope(entry.path, scope)
            ) {
              return
            }
            publish(isSubscribed, listener, freezeEvent('modify', entry))
          }),
        )
        refs.add(
          app.vault.on('delete', (entry) => {
            if (
              !isVaultEntry(entry) ||
              !doesPathAffectScope(entry.path, scope)
            ) {
              return
            }
            publish(isSubscribed, listener, freezeEvent('delete', entry))
          }),
        )
        refs.add(
          app.vault.on('rename', (entry, oldPath) => {
            if (!isVaultEntry(entry)) return
            const normalizedOldPath = normalizeEventPath(oldPath)
            if (
              !doesPathAffectScope(entry.path, scope) &&
              !doesPathAffectScope(normalizedOldPath, scope)
            ) {
              return
            }
            publish(
              isSubscribed,
              listener,
              Object.freeze({
                type: 'rename',
                entry: describeEntry(entry),
                oldPath: normalizedOldPath,
              }),
            )
          }),
        )
      } catch (registrationError) {
        try {
          unsubscribe()
        } catch (cleanupError) {
          throw new ModuleVaultCleanupError(
            'Module vault subscription registration rollback reported errors',
            [registrationError, cleanupError],
          )
        }
        throw registrationError
      }
      return unsubscribe
    },
  })

  return Object.freeze({
    api,
    activate: () => {
      assertAvailable()
      if (activationComplete) {
        throw new Error('Module vault capability is already active')
      }
      lifecycle.add(() => {
        deactivating = true
      })
      activationComplete = true
    },
  })
}

export function normalizeModuleVaultPath(
  path: string,
  allowRoot = false,
): string {
  if (typeof path !== 'string') {
    throw new TypeError('Module vault path must be a string')
  }
  if (path.includes('\0')) {
    throw new Error('Module vault path must not contain NUL')
  }
  const slashPath = path.replace(/\\/g, '/')
  if (slashPath.startsWith('/')) {
    throw new Error('Module vault path must be vault-relative')
  }
  const segments = slashPath.split('/').filter(Boolean)
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Module vault path must not contain dot segments')
  }
  const normalized = normalizePath(segments.join('/'))
  if (!allowRoot && normalized === '') {
    throw new Error('Module vault path must not be empty')
  }
  return normalized
}

function normalizeEventPath(path: string): string {
  try {
    return normalizeModuleVaultPath(path, true)
  } catch {
    return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  }
}

function doesPathAffectScope(path: string, scopePath: string): boolean {
  const normalizedPath = normalizeEventPath(path)
  return (
    scopePath === '' ||
    normalizedPath === scopePath ||
    normalizedPath.startsWith(`${scopePath}/`) ||
    scopePath.startsWith(`${normalizedPath}/`)
  )
}

function isVaultEntry(entry: unknown): entry is TFile | TFolder {
  return entry instanceof TFile || entry instanceof TFolder
}

function describeFile(file: TFile): YoloModuleVaultFileV1 {
  return Object.freeze({
    kind: 'file',
    path: file.path,
    name: file.name,
    ctime: file.stat?.ctime ?? 0,
    mtime: file.stat?.mtime ?? 0,
  })
}

function describeEntry(entry: TFile | TFolder): YoloModuleVaultEntryV1 {
  return entry instanceof TFile
    ? describeFile(entry)
    : Object.freeze({ kind: 'folder', path: entry.path, name: entry.name })
}

function freezeEvent(
  type: 'create' | 'modify' | 'delete',
  entry: TFile | TFolder,
): YoloModuleVaultEventV1 {
  return Object.freeze({ type, entry: describeEntry(entry) })
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  )
}

function unavailable(): never {
  throw new Error('Module vault is unavailable')
}
