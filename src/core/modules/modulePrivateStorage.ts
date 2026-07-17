import type { DataAdapter } from 'obsidian'

import type { ModuleLifecycleScope } from './lifecycleScope'
import { assertModuleId, assertModulePathSegment } from './moduleStore'

export type ModulePrivateStorageBackend = Readonly<{
  adapter: DataAdapter
  /** Returns the current vault-relative storage root. */
  getRootPath(): string
}>

export type ModulePrivateStorageScopeV1 = Readonly<{
  /** Lists blobs recursively below a directory key, or the scope root. */
  list(directoryPrefix?: string): Promise<readonly string[]>
  readText(key: string): Promise<string | null>
  readBinary(key: string): Promise<ArrayBuffer | null>
  readJson<T = unknown>(key: string): Promise<T | null>
  writeText(key: string, value: string): Promise<void>
  writeBinary(key: string, value: ArrayBuffer): Promise<void>
  writeJson(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}>

export type ModulePrivateStorageV1 = Readonly<{
  synchronized: ModulePrivateStorageScopeV1
  deviceLocal: ModulePrivateStorageScopeV1
}>

export type ModulePrivateStorageCapabilityActivationV1 = Readonly<{
  api: ModulePrivateStorageV1
  activate(): void
}>

export type ModulePrivateStorageCapabilityProviderV1 = {
  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): ModulePrivateStorageCapabilityActivationV1
}

export type ModulePrivateStorageCapabilityProviderOptions = Readonly<{
  /** Different adapters are trusted to provide physically separate storage. */
  synchronized: ModulePrivateStorageBackend
  deviceLocal: ModulePrivateStorageBackend
}>

export const MAX_MODULE_PRIVATE_KEY_DEPTH = 16
export const MAX_MODULE_PRIVATE_BLOB_BYTES = 16 * 1024 * 1024
export const MAX_MODULE_PRIVATE_LIST_DEPTH = 16
export const MAX_MODULE_PRIVATE_LIST_ENTRIES = 1024
export const MAX_MODULE_PRIVATE_JSON_DEPTH = 64
export const MAX_MODULE_PRIVATE_JSON_NODES = 10_000

const writeQueues = new WeakMap<DataAdapter, Map<string, Promise<void>>>()

export class ModulePrivateStorageVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModulePrivateStorageVerificationError'
  }
}

/**
 * Provides module-isolated private blobs without a settings envelope.
 * Adapter mutations already in progress cannot be cancelled or rolled back on disposal;
 * their operations reject after the mutation settles and perform no subsequent steps.
 */
export class ModulePrivateStorageCapabilityProvider
  implements ModulePrivateStorageCapabilityProviderV1
{
  constructor(
    private readonly options: ModulePrivateStorageCapabilityProviderOptions,
  ) {
    resolveBackendRoots(options)
  }

  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): ModulePrivateStorageCapabilityActivationV1 {
    assertModuleId(moduleId, 'Module id')
    let active = true
    let activationComplete = false
    lifecycle.add(() => {
      active = false
      activationComplete = false
    })

    const assertActive = (): void => {
      if (!active) throw new Error(`Module "${moduleId}" is no longer active`)
      if (!activationComplete) {
        throw new Error(`Module "${moduleId}" private storage is not active`)
      }
    }
    const resolveRoots = (): ResolvedBackendRoots =>
      resolveBackendRoots(this.options)

    const api = Object.freeze({
      synchronized: createPrivateStorageScope(
        moduleId,
        this.options.synchronized.adapter,
        () => resolveRoots().synchronized,
        assertActive,
      ),
      deviceLocal: createPrivateStorageScope(
        moduleId,
        this.options.deviceLocal.adapter,
        () => resolveRoots().deviceLocal,
        assertActive,
      ),
    })
    return Object.freeze({
      api,
      activate: () => {
        if (!active) throw new Error(`Module "${moduleId}" is no longer active`)
        activationComplete = true
      },
    })
  }
}

function createPrivateStorageScope(
  moduleId: string,
  adapter: DataAdapter,
  getRoot: () => string,
  assertActive: () => void,
): ModulePrivateStorageScopeV1 {
  const resolveOperation = (
    key: string,
  ): Readonly<{ root: string; target: string }> => {
    assertActive()
    const backendRoot = getRoot()
    const root = `${backendRoot}/${moduleId}`
    return { root, target: `${root}/${normalizeKey(key)}` }
  }

  const readText = async (key: string): Promise<string | null> => {
    const { target } = resolveOperation(key)
    const exists = await assertReadableFile(adapter, target, assertActive)
    if (!exists) return null
    const value = await adapter.read(target)
    assertActive()
    assertBlobSize(textByteLength(value))
    return value
  }
  const readBinary = async (key: string): Promise<ArrayBuffer | null> => {
    const { target } = resolveOperation(key)
    const exists = await assertReadableFile(adapter, target, assertActive)
    if (!exists) return null
    const value = await adapter.readBinary(target)
    assertActive()
    assertBlobSize(value.byteLength)
    return copyArrayBuffer(value)
  }

  return Object.freeze({
    list: async (directoryPrefix = '') => {
      assertActive()
      const backendRoot = getRoot()
      const root = `${backendRoot}/${moduleId}`
      const normalizedPrefix = directoryPrefix
        ? normalizeKey(directoryPrefix)
        : ''
      const start = normalizedPrefix ? `${root}/${normalizedPrefix}` : root
      const stat = await adapter.stat(start)
      assertActive()
      if (stat?.type !== 'folder') return Object.freeze([])
      const keys = await listFiles(adapter, root, start, assertActive)
      return Object.freeze(keys.sort())
    },
    readText,
    readBinary,
    readJson: async <T = unknown>(key: string): Promise<T | null> => {
      const raw = await readText(key)
      if (raw === null) return null
      try {
        const value = JSON.parse(raw) as T
        assertPlainJson(value)
        return value
      } catch {
        throw new Error(`Module private JSON blob "${key}" is invalid`)
      }
    },
    writeText: (key, value) => {
      if (typeof value !== 'string') {
        throw new TypeError('Module private text value must be a string')
      }
      assertBlobSize(textByteLength(value))
      const operation = resolveOperation(key)
      return enqueueWrite(adapter, operation.target, async () => {
        assertActive()
        await ensureParentFolders(adapter, operation.target, assertActive)
        assertActive()
        await adapter.write(operation.target, value)
        assertActive()
        const actual = await adapter.read(operation.target)
        assertActive()
        assertBlobSize(textByteLength(actual))
        if (actual !== value) throw verificationError(moduleId, key)
      })
    },
    writeBinary: (key, value) => {
      if (!(value instanceof ArrayBuffer)) {
        throw new TypeError(
          'Module private binary value must be an ArrayBuffer',
        )
      }
      assertBlobSize(value.byteLength)
      const operation = resolveOperation(key)
      const expected = copyArrayBuffer(value)
      return enqueueWrite(adapter, operation.target, async () => {
        assertActive()
        await ensureParentFolders(adapter, operation.target, assertActive)
        assertActive()
        await adapter.writeBinary(operation.target, expected)
        assertActive()
        const actual = await adapter.readBinary(operation.target)
        assertActive()
        assertBlobSize(actual.byteLength)
        if (!arrayBuffersEqual(actual, expected)) {
          throw verificationError(moduleId, key)
        }
      })
    },
    writeJson: (key, value) => {
      const serialized = serializePlainJson(value)
      assertBlobSize(textByteLength(serialized))
      const operation = resolveOperation(key)
      return enqueueWrite(adapter, operation.target, async () => {
        assertActive()
        await ensureParentFolders(adapter, operation.target, assertActive)
        assertActive()
        await adapter.write(operation.target, serialized)
        assertActive()
        const actual = await adapter.read(operation.target)
        assertActive()
        assertBlobSize(textByteLength(actual))
        if (actual !== serialized) throw verificationError(moduleId, key)
      })
    },
    remove: (key) => {
      const operation = resolveOperation(key)
      return enqueueWrite(adapter, operation.target, async () => {
        assertActive()
        const exists = await adapter.exists(operation.target)
        assertActive()
        if (exists) {
          await adapter.remove(operation.target)
          assertActive()
        }
        const remains = await adapter.exists(operation.target)
        assertActive()
        if (remains) {
          throw verificationError(moduleId, key)
        }
      })
    },
  })
}

async function listFiles(
  adapter: DataAdapter,
  root: string,
  start: string,
  assertActive: () => void,
): Promise<string[]> {
  const files: string[] = []
  const pending = [{ path: start, depth: 0 }]
  const visited = new Set<string>()
  let entryCount = 0
  while (pending.length > 0) {
    const { path: folder, depth } = pending.pop()!
    const identity = canonicalIdentity(folder)
    if (visited.has(identity)) continue
    visited.add(identity)
    const listed = await adapter.list(folder)
    assertActive()
    entryCount += listed.files.length + listed.folders.length
    if (entryCount > MAX_MODULE_PRIVATE_LIST_ENTRIES) {
      throw new Error('Module private storage list exceeds the entry limit')
    }
    for (const file of listed.files) {
      files.push(relativeListedPath(root, file))
    }
    for (const child of listed.folders) {
      relativeListedPath(root, child)
      if (depth >= MAX_MODULE_PRIVATE_LIST_DEPTH) {
        throw new Error('Module private storage list exceeds the depth limit')
      }
      pending.push({ path: child, depth: depth + 1 })
    }
  }
  return files
}

function relativeListedPath(root: string, path: string): string {
  const prefix = `${root}/`
  if (!path.startsWith(prefix)) {
    throw new Error('Module private storage backend returned an unsafe path')
  }
  const key = normalizeKey(path.slice(prefix.length))
  if (`${root}/${key}` !== path) {
    throw new Error('Module private storage backend returned an unsafe path')
  }
  return key
}

async function ensureParentFolders(
  adapter: DataAdapter,
  target: string,
  assertActive: () => void,
): Promise<void> {
  const segments = target.split('/')
  segments.pop()
  let path = ''
  for (const segment of segments) {
    path = path ? `${path}/${segment}` : segment
    const exists = await adapter.exists(path)
    assertActive()
    if (exists) continue
    try {
      await adapter.mkdir(path)
      assertActive()
    } catch (error) {
      assertActive()
      const created = await adapter.exists(path)
      assertActive()
      if (!created) throw error
    }
  }
}

function enqueueWrite(
  adapter: DataAdapter,
  target: string,
  operation: () => Promise<void>,
): Promise<void> {
  let queues = writeQueues.get(adapter)
  if (!queues) {
    queues = new Map()
    writeQueues.set(adapter, queues)
  }
  const key = canonicalIdentity(target)
  const previous = queues.get(key) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(operation)
  const settled = result.then(
    () => undefined,
    () => undefined,
  )
  queues.set(key, settled)
  void settled.finally(() => {
    if (queues?.get(key) === settled) queues.delete(key)
  })
  return result
}

function normalizeRoot(value: string): string {
  const portable = value.replace(/\\/g, '/')
  const parts = portable.split('/')
  if (
    !portable ||
    portable.startsWith('/') ||
    /^[A-Za-z]:\//.test(portable) ||
    parts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(
      'Module private storage root must be a safe vault-relative path',
    )
  }
  for (const part of parts) {
    assertModulePathSegment(
      part.startsWith('.') ? `root${part}` : part,
      'Module private storage root',
    )
  }
  return parts.join('/')
}

function normalizeKey(value: string): string {
  const portable = value.replace(/\\/g, '/')
  if (!portable || portable.startsWith('/') || /^[A-Za-z]:\//.test(portable)) {
    throw new Error('Module private storage key must be a safe relative path')
  }
  if (
    portable !== value ||
    portable.normalize('NFC') !== portable ||
    portable !== portable.toLowerCase()
  ) {
    throw new Error(
      'Module private storage key must be a canonical lowercase relative path',
    )
  }
  const parts = portable.split('/')
  if (parts.length > MAX_MODULE_PRIVATE_KEY_DEPTH) {
    throw new Error('Module private storage key exceeds the depth limit')
  }
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Module private storage key must be a safe relative path')
  }
  for (const part of parts) {
    assertModulePathSegment(part, 'Module private storage key')
  }
  return parts.join('/')
}

function canonicalIdentity(value: string): string {
  return value.normalize('NFC').toLowerCase()
}

type ResolvedBackendRoots = Readonly<{
  synchronized: string
  deviceLocal: string
}>

function resolveBackendRoots(
  options: ModulePrivateStorageCapabilityProviderOptions,
): ResolvedBackendRoots {
  const synchronized = normalizeRoot(options.synchronized.getRootPath())
  const deviceLocal = normalizeRoot(options.deviceLocal.getRootPath())
  if (
    options.synchronized.adapter === options.deviceLocal.adapter &&
    pathsOverlap(synchronized, deviceLocal)
  ) {
    throw new Error(
      'Module private synchronized and device-local roots must not overlap on the same adapter',
    )
  }
  return { synchronized, deviceLocal }
}

function pathsOverlap(left: string, right: string): boolean {
  const canonicalLeft = canonicalIdentity(left)
  const canonicalRight = canonicalIdentity(right)
  return (
    canonicalLeft === canonicalRight ||
    canonicalLeft.startsWith(`${canonicalRight}/`) ||
    canonicalRight.startsWith(`${canonicalLeft}/`)
  )
}

function assertBlobSize(byteLength: number): void {
  if (byteLength > MAX_MODULE_PRIVATE_BLOB_BYTES) {
    throw new Error('Module private blob exceeds the byte limit')
  }
}

async function assertReadableFile(
  adapter: DataAdapter,
  target: string,
  assertActive: () => void,
): Promise<boolean> {
  const stat = await adapter.stat(target)
  assertActive()
  if (stat === null) return false
  if (stat.type !== 'file') {
    throw new Error('Module private blob path is not a file')
  }
  assertBlobSize(stat.size)
  return true
}

function textByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function assertPlainJson(value: unknown): void {
  serializePlainJson(value)
}

function serializePlainJson(value: unknown): string {
  const ancestors = new WeakSet<object>()
  let nodeCount = 0

  const serialize = (entry: unknown, depth: number): string => {
    nodeCount += 1
    if (nodeCount > MAX_MODULE_PRIVATE_JSON_NODES) {
      throw new TypeError('Module private JSON exceeds the node limit')
    }
    if (depth > MAX_MODULE_PRIVATE_JSON_DEPTH) {
      throw new TypeError('Module private JSON exceeds the depth limit')
    }

    if (entry === null) return 'null'
    if (typeof entry === 'string' || typeof entry === 'boolean') {
      return JSON.stringify(entry)
    }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw plainJsonTypeError()
      return JSON.stringify(entry)
    }
    if (typeof entry !== 'object') throw plainJsonTypeError()
    if (ancestors.has(entry)) throw plainJsonTypeError()

    ancestors.add(entry)
    try {
      if (Array.isArray(entry)) {
        if (Object.getPrototypeOf(entry) !== Array.prototype) {
          throw plainJsonTypeError()
        }
        const keys = Reflect.ownKeys(entry)
        if (
          keys.length !== entry.length + 1 ||
          keys.some(
            (key) =>
              key !== 'length' &&
              (typeof key !== 'string' || !isArrayIndex(key, entry.length)),
          )
        ) {
          throw plainJsonTypeError()
        }
        const values: string[] = []
        for (let index = 0; index < entry.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(
            entry,
            String(index),
          )
          if (!descriptor?.enumerable || !('value' in descriptor)) {
            throw plainJsonTypeError()
          }
          values.push(serialize(descriptor.value, depth + 1))
        }
        return `[${values.join(',')}]`
      }

      const prototype = Object.getPrototypeOf(entry)
      if (prototype !== Object.prototype && prototype !== null) {
        throw plainJsonTypeError()
      }
      const properties: string[] = []
      for (const key of Reflect.ownKeys(entry)) {
        if (typeof key !== 'string') throw plainJsonTypeError()
        const descriptor = Object.getOwnPropertyDescriptor(entry, key)
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw plainJsonTypeError()
        }
        properties.push(
          `${JSON.stringify(key)}:${serialize(descriptor.value, depth + 1)}`,
        )
      }
      return `{${properties.join(',')}}`
    } finally {
      ancestors.delete(entry)
    }
  }

  return serialize(value, 0)
}

function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key)
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  )
}

function plainJsonTypeError(): TypeError {
  return new TypeError('Module private JSON value must be plain JSON data')
}

function copyArrayBuffer(value: ArrayBuffer): ArrayBuffer {
  return new Uint8Array(value).slice().buffer
}

function arrayBuffersEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  const leftBytes = new Uint8Array(left)
  const rightBytes = new Uint8Array(right)
  if (leftBytes.byteLength !== rightBytes.byteLength) return false
  return leftBytes.every((byte, index) => byte === rightBytes[index])
}

function verificationError(
  moduleId: string,
  key: string,
): ModulePrivateStorageVerificationError {
  return new ModulePrivateStorageVerificationError(
    `Module "${moduleId}" private blob "${key}" changed while its write was being verified`,
  )
}
