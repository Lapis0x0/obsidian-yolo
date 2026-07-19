import { App, type EventRef, TFile, TFolder, normalizePath } from 'obsidian'

import type { ModuleLifecycleScope } from './lifecycleScope'
import type {
  YoloModuleVaultEntryV1,
  YoloModuleVaultEventV1,
  YoloModuleVaultFileV1,
  YoloModuleVaultTextSnapshotV1,
  YoloModuleVaultV1,
} from './types'

type AppVaultWriteState = {
  readonly active: Map<symbol, readonly string[]>
  readonly pending: PendingVaultOperation[]
}

type PendingVaultOperation = {
  readonly paths: readonly string[]
  start(): void
}

type VaultSnapshotRecord = {
  readonly path: string
  readonly file: TFile | null
  readonly content: string
  readonly creationReceipt?: symbol
}

const appVaultWriteStates = new WeakMap<App, AppVaultWriteState>()
const processMismatch = new Error('Module vault process mismatch')

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
  stat: () => Promise.reject(new Error('Module vault is unavailable')),
  list: () => Promise.reject(new Error('Module vault is unavailable')),
  exists: () => Promise.reject(new Error('Module vault is unavailable')),
  readText: () => Promise.reject(new Error('Module vault is unavailable')),
  readBinary: () => Promise.reject(new Error('Module vault is unavailable')),
  ensureFolder: () => Promise.reject(new Error('Module vault is unavailable')),
  createFolder: () => Promise.reject(new Error('Module vault is unavailable')),
  createText: () => Promise.reject(new Error('Module vault is unavailable')),
  createBinary: () => Promise.reject(new Error('Module vault is unavailable')),
  writeText: () => Promise.reject(new Error('Module vault is unavailable')),
  renamePath: () => Promise.reject(new Error('Module vault is unavailable')),
  trashPath: () => Promise.reject(new Error('Module vault is unavailable')),
  removeFileExact: () =>
    Promise.reject(new Error('Module vault is unavailable')),
  removeEmptyFolderExact: () =>
    Promise.reject(new Error('Module vault is unavailable')),
  readTextSnapshot: () =>
    Promise.reject(new Error('Module vault is unavailable')),
  createTextIfAbsent: () =>
    Promise.reject(new Error('Module vault is unavailable')),
  replaceTextIfUnchanged: () =>
    Promise.reject(new Error('Module vault is unavailable')),
  revertOwnedCreatedTextIfUnchanged: () =>
    Promise.reject(new Error('Module vault is unavailable')),
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
  const writeState = getAppVaultWriteState(app)
  const snapshotRecords = new WeakMap<
    YoloModuleVaultTextSnapshotV1,
    VaultSnapshotRecord
  >()
  const activeCreationReceipts = new Set<symbol>()
  const subscriptionCleanups = new Set<() => void>()
  let disposed = false
  let deactivating = false
  let activationComplete = false
  lifecycle.add(() => {
    disposed = true
    activeCreationReceipts.clear()
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
  const createSnapshot = (
    file: TFile | null,
    path: string,
    content: string,
    creationReceipt?: symbol,
  ): YoloModuleVaultTextSnapshotV1 => {
    const snapshot = Object.freeze({ path, content })
    snapshotRecords.set(snapshot, {
      path,
      file,
      content,
      creationReceipt,
    })
    return snapshot
  }
  const getSnapshotRecord = (
    snapshot: YoloModuleVaultTextSnapshotV1,
  ): VaultSnapshotRecord | null => {
    if (!snapshot || typeof snapshot !== 'object') return null
    return snapshotRecords.get(snapshot) ?? null
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
    stat: async (rawPath) => {
      assertAvailable()
      const path = normalizeModuleVaultPath(rawPath, true)
      const indexed = app.vault.getAbstractFileByPath(path)
      if (isVaultEntry(indexed)) return describeEntry(indexed)
      const entry = await app.vault.adapter.stat(path)
      assertAvailable()
      return entry ? describeAdapterEntry(path, entry) : null
    },
    list: async (rawPath) => {
      assertAvailable()
      const path = normalizeModuleVaultPath(rawPath, true)
      const indexed = app.vault.getAbstractFileByPath(path)
      if (indexed instanceof TFolder) {
        return Object.freeze(indexed.children.map(describeEntry))
      }
      const entry = await app.vault.adapter.stat(path)
      assertAvailable()
      if (!entry) return Object.freeze([])
      if (entry.type !== 'folder') {
        throw new Error(`Module vault path is not a folder: ${path}`)
      }
      const listing = await app.vault.adapter.list(path)
      assertAvailable()
      const entries = await Promise.all(
        [...listing.folders, ...listing.files].map(async (childPath) => {
          const child = await app.vault.adapter.stat(childPath)
          if (!child) {
            throw new Error(`Module vault entry disappeared: ${childPath}`)
          }
          return describeAdapterEntry(childPath, child)
        }),
      )
      assertAvailable()
      return Object.freeze(entries.sort((a, b) => a.path.localeCompare(b.path)))
    },
    exists: async (path) => {
      assertAvailable()
      const exists = await app.vault.adapter.exists(
        normalizeModuleVaultPath(path, true),
      )
      assertAvailable()
      return exists
    },
    readText: async (filePath) => {
      assertAvailable()
      const path = normalizeModuleVaultPath(filePath)
      const entry = app.vault.getAbstractFileByPath(path)
      if (!(entry instanceof TFile)) {
        return readAdapterTextFile(app, path, assertAvailable)
      }
      return app.vault.cachedRead(entry)
    },
    readBinary: async (filePath) => {
      assertAvailable()
      const path = normalizeModuleVaultPath(filePath)
      const entry = app.vault.getAbstractFileByPath(path)
      if (!(entry instanceof TFile)) {
        return readAdapterBinaryFile(app, path, assertAvailable)
      }
      const bytes = await app.vault.readBinary(entry)
      return bytes.slice(0)
    },
    ensureFolder: async (folderPath) => {
      assertAvailable()
      await ensureVaultFolder(
        app,
        writeState,
        normalizeModuleVaultPath(folderPath, true),
        assertAvailable,
      )
    },
    createFolder: async (folderPath) => {
      assertAvailable()
      const path = normalizeModuleVaultPath(folderPath)
      await serializeVaultPaths(writeState, [path], async () => {
        assertAvailable()
        await assertParentFolder(app, path)
        if (isHiddenVaultPath(path)) await app.vault.adapter.mkdir(path)
        else await app.vault.createFolder(path)
      })
    },
    createText: async (filePath, content) => {
      assertAvailable()
      const path = normalizeModuleVaultPath(filePath)
      requireString(content, 'Module vault text content')
      return serializeVaultPaths(writeState, [path], async () => {
        assertAvailable()
        await assertParentFolder(app, path)
        if (isHiddenVaultPath(path)) {
          if (await app.vault.adapter.exists(path)) {
            throw new Error(`Module vault destination already exists: ${path}`)
          }
          await app.vault.adapter.write(path, content)
          assertAvailable()
          return freezeAdapterWrittenFile(app, path)
        }
        const file = await app.vault.create(path, content)
        return freezeWrittenFile(file)
      })
    },
    createBinary: async (filePath, content) => {
      assertAvailable()
      const path = normalizeModuleVaultPath(filePath)
      if (!(content instanceof ArrayBuffer)) {
        throw new TypeError(
          'Module vault binary content must be an ArrayBuffer',
        )
      }
      const bytes = content.slice(0)
      await serializeVaultPaths(writeState, [path], async () => {
        assertAvailable()
        await assertParentFolder(app, path)
        if (isHiddenVaultPath(path)) {
          if (await app.vault.adapter.exists(path)) {
            throw new Error(`Module vault destination already exists: ${path}`)
          }
          await app.vault.adapter.writeBinary(path, bytes)
          return
        }
        await app.vault.createBinary(path, bytes)
      })
    },
    writeText: async (filePath, content) => {
      assertAvailable()
      const path = normalizeModuleVaultPath(filePath)
      requireString(content, 'Module vault text content')
      return serializeVaultPaths(writeState, [path], async () => {
        assertAvailable()
        const entry = app.vault.getAbstractFileByPath(path)
        if (!(entry instanceof TFile)) {
          await assertAdapterFile(app, path)
          await app.vault.adapter.write(path, content)
          assertAvailable()
          return freezeAdapterWrittenFile(app, path)
        }
        await app.vault.modify(entry, content)
        return freezeWrittenFile(entry)
      })
    },
    renamePath: async (oldPath, newPath) => {
      assertAvailable()
      const sourcePath = normalizeModuleVaultPath(oldPath)
      const destinationPath = normalizeModuleVaultPath(newPath)
      if (sourcePath === destinationPath) return
      await serializeVaultPaths(
        writeState,
        [sourcePath, destinationPath],
        async () => {
          assertAvailable()
          const entry = app.vault.getAbstractFileByPath(sourcePath)
          if (!(entry instanceof TFile)) {
            throw new Error(`Module vault file not found: ${sourcePath}`)
          }
          if (app.vault.getAbstractFileByPath(destinationPath)) {
            throw new Error(
              `Module vault destination already exists: ${destinationPath}`,
            )
          }
          await assertParentFolder(app, destinationPath)
          await app.fileManager.renameFile(entry, destinationPath)
        },
      )
    },
    trashPath: async (rawPath) => {
      assertAvailable()
      const path = normalizeModuleVaultPath(rawPath)
      return serializeVaultPaths(writeState, [path], async () => {
        assertAvailable()
        const entry = app.vault.getAbstractFileByPath(path)
        if (!isVaultEntry(entry)) return false
        await app.fileManager.trashFile(entry)
        return true
      })
    },
    removeFileExact: async (rawPath) => {
      assertAvailable()
      const path = normalizeModuleVaultPath(rawPath)
      return serializeVaultPaths(writeState, [path], async () => {
        assertAvailable()
        const entry = app.vault.getAbstractFileByPath(path)
        if (!(entry instanceof TFile)) {
          const stat = await app.vault.adapter.stat(path)
          assertAvailable()
          if (stat?.type !== 'file') return false
          await app.vault.adapter.remove(path)
          assertAvailable()
          return true
        }
        // eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- Exact rollback must permanently delete only the validated file.
        await app.vault.delete(entry, true)
        return true
      })
    },
    removeEmptyFolderExact: async (rawPath) => {
      assertAvailable()
      const path = normalizeModuleVaultPath(rawPath)
      return serializeVaultPaths(writeState, [path], async () => {
        assertAvailable()
        const entry = app.vault.getAbstractFileByPath(path)
        if (!(entry instanceof TFolder)) {
          const stat = await app.vault.adapter.stat(path)
          assertAvailable()
          if (stat?.type !== 'folder') return false
          const listing = await app.vault.adapter.list(path)
          assertAvailable()
          if (listing.files.length > 0 || listing.folders.length > 0) {
            return false
          }
          await app.vault.adapter.rmdir(path, false)
          assertAvailable()
          return true
        }
        if (entry.children.length > 0) return false
        // eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- Exact rollback must permanently delete only the validated empty folder.
        await app.vault.delete(entry, false)
        return true
      })
    },
    readTextSnapshot: async (filePath) => {
      assertAvailable()
      const path = normalizeModuleVaultPath(filePath)
      return serializeVaultPaths(writeState, [path], async () => {
        assertAvailable()
        const entry = app.vault.getAbstractFileByPath(path)
        if (!entry) {
          const stat = await app.vault.adapter.stat(path)
          assertAvailable()
          if (!stat) return null
          if (stat.type !== 'file') {
            throw new Error(`Module vault path is not a file: ${path}`)
          }
          const content = await app.vault.adapter.read(path)
          assertAvailable()
          return createSnapshot(null, path, content)
        }
        if (!(entry instanceof TFile)) {
          throw new Error(`Module vault path is not a file: ${path}`)
        }
        return createSnapshot(entry, path, await app.vault.read(entry))
      })
    },
    createTextIfAbsent: async (filePath, content) => {
      assertAvailable()
      const path = normalizeModuleVaultPath(filePath)
      requireString(content, 'Module vault text content')
      return serializeVaultPaths(writeState, [path], async () => {
        assertAvailable()
        if (await app.vault.adapter.exists(path)) return null
        await assertParentFolder(app, path)
        if (isHiddenVaultPath(path)) {
          await app.vault.adapter.write(path, content)
          const creationReceipt = Symbol(path)
          activeCreationReceipts.add(creationReceipt)
          return createSnapshot(null, path, content, creationReceipt)
        }
        const file = await app.vault.create(path, content)
        const creationReceipt = Symbol(path)
        activeCreationReceipts.add(creationReceipt)
        return createSnapshot(file, path, content, creationReceipt)
      })
    },
    replaceTextIfUnchanged: async (expected, content) => {
      assertAvailable()
      requireString(content, 'Module vault text content')
      const record = getSnapshotRecord(expected)
      if (!record) return null
      return serializeVaultPaths(writeState, [record.path], async () => {
        assertAvailable()
        if (record.file) {
          if (!isCurrentIndexedSnapshot(app, record)) return null
        } else if (!(await isCurrentAdapterSnapshot(app, record))) return null
        if (!record.file) {
          await app.vault.adapter.write(record.path, content)
          assertAvailable()
          const creationReceipt =
            record.creationReceipt &&
            activeCreationReceipts.has(record.creationReceipt)
              ? record.creationReceipt
              : undefined
          return createSnapshot(null, record.path, content, creationReceipt)
        }
        try {
          await app.vault.process(record.file, (current) => {
            if (current !== record.content) throw processMismatch
            return content
          })
        } catch (error) {
          if (error === processMismatch) return null
          throw error
        }
        if (record.file) {
          if (!isCurrentIndexedSnapshot(app, record)) return null
        } else if (!(await isCurrentAdapterSnapshot(app, record))) return null
        const creationReceipt =
          record.creationReceipt &&
          activeCreationReceipts.has(record.creationReceipt)
            ? record.creationReceipt
            : undefined
        return createSnapshot(
          record.file,
          record.path,
          content,
          creationReceipt,
        )
      })
    },
    revertOwnedCreatedTextIfUnchanged: async (
      created,
      expected,
      fallbackContent,
    ) => {
      assertAvailable()
      requireString(fallbackContent, 'Module vault fallback content')
      const createdRecord = getSnapshotRecord(created)
      const expectedRecord = getSnapshotRecord(expected)
      if (
        !createdRecord?.creationReceipt ||
        !activeCreationReceipts.has(createdRecord.creationReceipt) ||
        !expectedRecord ||
        createdRecord.creationReceipt !== expectedRecord.creationReceipt ||
        createdRecord.file !== expectedRecord.file ||
        createdRecord.path !== expectedRecord.path
      ) {
        return null
      }
      const creationReceipt = createdRecord.creationReceipt
      return serializeVaultPaths(
        writeState,
        [expectedRecord.path],
        async () => {
          assertAvailable()
          if (!activeCreationReceipts.has(creationReceipt)) return null
          if (expectedRecord.file) {
            if (!isCurrentIndexedSnapshot(app, expectedRecord)) return null
          } else if (!(await isCurrentAdapterSnapshot(app, expectedRecord))) {
            return null
          }
          if (!expectedRecord.file) {
            await app.vault.adapter.write(expectedRecord.path, fallbackContent)
            assertAvailable()
            activeCreationReceipts.delete(creationReceipt)
            return createSnapshot(null, expectedRecord.path, fallbackContent)
          }
          try {
            await app.vault.process(expectedRecord.file, (current) => {
              if (current !== expectedRecord.content) throw processMismatch
              return fallbackContent
            })
          } catch (error) {
            if (error === processMismatch) return null
            throw error
          }
          activeCreationReceipts.delete(creationReceipt)
          if (!isCurrentIndexedSnapshot(app, expectedRecord)) {
            return null
          }
          return createSnapshot(
            expectedRecord.file,
            expectedRecord.path,
            fallbackContent,
          )
        },
      )
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

function getAppVaultWriteState(app: App): AppVaultWriteState {
  let state = appVaultWriteStates.get(app)
  if (!state) {
    state = { active: new Map(), pending: [] }
    appVaultWriteStates.set(app, state)
  }
  return state
}

function serializeVaultPaths<R>(
  state: AppVaultWriteState,
  paths: readonly string[],
  operation: () => Promise<R>,
): Promise<R> {
  const orderedPaths = [...new Set(paths)].sort()
  return new Promise<R>((resolve, reject) => {
    const token = Symbol('module-vault-operation')
    const request: PendingVaultOperation = {
      paths: orderedPaths,
      start: () => {
        state.active.set(token, orderedPaths)
        void Promise.resolve()
          .then(operation)
          .then(resolve, reject)
          .finally(() => {
            state.active.delete(token)
            drainVaultOperations(state)
          })
      },
    }
    state.pending.push(request)
    drainVaultOperations(state)
  })
}

function drainVaultOperations(state: AppVaultWriteState): void {
  let index = 0
  while (index < state.pending.length) {
    const request = state.pending[index]
    const conflictsWithActive = [...state.active.values()].some((paths) =>
      vaultPathSetsConflict(request.paths, paths),
    )
    const conflictsWithEarlier = state.pending
      .slice(0, index)
      .some((earlier) => vaultPathSetsConflict(request.paths, earlier.paths))
    if (conflictsWithActive || conflictsWithEarlier) {
      index += 1
      continue
    }
    state.pending.splice(index, 1)
    request.start()
  }
}

function vaultPathSetsConflict(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.some((leftPath) =>
    right.some((rightPath) => vaultPathsConflict(leftPath, rightPath)),
  )
}

function vaultPathsConflict(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  )
}

async function ensureVaultFolder(
  app: App,
  state: AppVaultWriteState,
  path: string,
  assertAvailable: () => void,
): Promise<void> {
  if (path === '') return
  const segments = path.split('/')
  for (let index = 1; index <= segments.length; index += 1) {
    assertAvailable()
    const currentPath = segments.slice(0, index).join('/')
    await serializeVaultPaths(state, [currentPath], async () => {
      assertAvailable()
      const existing = await app.vault.adapter.stat(currentPath)
      assertAvailable()
      if (existing?.type === 'folder') return
      if (existing) {
        throw new Error(`Module vault path is not a folder: ${currentPath}`)
      }
      if (isHiddenVaultPath(currentPath)) {
        await app.vault.adapter.mkdir(currentPath)
      } else {
        await app.vault.createFolder(currentPath)
      }
    })
  }
}

async function assertParentFolder(app: App, path: string): Promise<void> {
  const separator = path.lastIndexOf('/')
  if (separator < 0) return
  const parentPath = path.slice(0, separator)
  const parent = await app.vault.adapter.stat(parentPath)
  if (parent?.type !== 'folder') {
    throw new Error(`Module vault parent folder not found: ${parentPath}`)
  }
}

function isHiddenVaultPath(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'))
}

async function assertAdapterFile(app: App, path: string): Promise<void> {
  const stat = await app.vault.adapter.stat(path)
  if (stat?.type !== 'file') {
    throw new Error(`Module vault file not found: ${path}`)
  }
}

async function readAdapterTextFile(
  app: App,
  path: string,
  assertAvailable: () => void,
): Promise<string> {
  await assertAdapterFile(app, path)
  const content = await app.vault.adapter.read(path)
  assertAvailable()
  return content
}

async function readAdapterBinaryFile(
  app: App,
  path: string,
  assertAvailable: () => void,
): Promise<ArrayBuffer> {
  await assertAdapterFile(app, path)
  const content = await app.vault.adapter.readBinary(path)
  assertAvailable()
  return content.slice(0)
}

async function freezeAdapterWrittenFile(
  app: App,
  path: string,
): Promise<Readonly<{ path: string; mtime: number }>> {
  const stat = await app.vault.adapter.stat(path)
  if (stat?.type !== 'file') {
    throw new Error(`Module vault file not found after write: ${path}`)
  }
  return Object.freeze({ path, mtime: stat.mtime })
}

function freezeWrittenFile(file: TFile): Readonly<{
  path: string
  mtime: number
}> {
  return Object.freeze({ path: file.path, mtime: file.stat?.mtime ?? 0 })
}

function isCurrentIndexedSnapshot(
  app: App,
  record: VaultSnapshotRecord,
): boolean {
  return Boolean(
    record.file &&
      record.file.path === record.path &&
      app.vault.getAbstractFileByPath(record.path) === record.file,
  )
}

async function isCurrentAdapterSnapshot(
  app: App,
  record: VaultSnapshotRecord,
): Promise<boolean> {
  const stat = await app.vault.adapter.stat(record.path)
  if (stat?.type !== 'file') return false
  return (await app.vault.adapter.read(record.path)) === record.content
}

function describeAdapterEntry(
  path: string,
  stat: Readonly<{
    type: 'file' | 'folder'
    ctime: number
    mtime: number
  }>,
): YoloModuleVaultEntryV1 {
  const name = path.split('/').at(-1) ?? ''
  return stat.type === 'file'
    ? Object.freeze({
        kind: 'file' as const,
        path,
        name,
        ctime: stat.ctime,
        mtime: stat.mtime,
      })
    : Object.freeze({ kind: 'folder' as const, path, name })
}

function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`)
  }
}

function unavailable(): never {
  throw new Error('Module vault is unavailable')
}
