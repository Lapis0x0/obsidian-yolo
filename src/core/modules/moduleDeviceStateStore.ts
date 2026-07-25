import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
import { isOfficialModuleReleaseUrl } from './moduleReleaseUrl'
import {
  type DeviceLocalModuleRuntimeStateBackend,
  ModuleRuntimeStateStore,
  ModuleSettingsCorruptionError,
} from './moduleSettingsStore'
import {
  MAX_MODULE_MANIFEST_BYTES,
  assertModuleId,
  isModuleHostApiRange,
} from './moduleStore'

const SCHEMA_VERSION = 1
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const SCHEMA_NAMESPACE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/
const SHA256 = /^[a-fA-F0-9]{64}$/
const DANGEROUS_NAMES = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_DEVICE_STATE_RECORDS = 100
const ENUMERATION_RETRY_LIMIT = 2

export type ModuleDeviceState = Readonly<{
  moduleId: string
  platform: 'desktop' | 'mobile'
  active: ModuleArtifactDescriptor | null
  pending: Readonly<{
    descriptor: ModuleArtifactDescriptor
  }> | null
}>

type ModuleDeviceStateListing = Readonly<{
  files: readonly string[]
  folders: readonly string[]
}>

type ModuleDeviceStateRootStat = Readonly<{
  type: 'file' | 'folder'
}>

export type ModuleDeviceStateStoreBackend =
  DeviceLocalModuleRuntimeStateBackend &
    Readonly<{
      adapter: DeviceLocalModuleRuntimeStateBackend['adapter'] &
        Readonly<{
          list(path: string): Promise<ModuleDeviceStateListing>
          stat(path: string): Promise<ModuleDeviceStateRootStat | null>
        }>
    }>

export type ModuleDeviceStateTransaction = Readonly<{
  read(): Promise<ModuleDeviceState | null>
  write(state: ModuleDeviceState): Promise<ModuleDeviceState>
  remove(): Promise<void>
}>

const EMPTY_STATES = Object.freeze([]) as readonly ModuleDeviceState[]
const transactionQueues = new WeakMap<object, Map<string, Promise<void>>>()

export class ModuleDeviceStateCorruptionError extends Error {
  constructor(moduleId: string, error: unknown) {
    super(
      `Device-local state for module "${moduleId}" is corrupt: ${describeError(error)}`,
    )
    this.name = 'ModuleDeviceStateCorruptionError'
  }
}

export class ModuleDeviceStateStore {
  private readonly store: ModuleRuntimeStateStore
  private readonly backend: ModuleDeviceStateStoreBackend
  private readonly rootPath: string
  private readonly rootIdentity: string

  constructor(backend: ModuleDeviceStateStoreBackend) {
    this.backend = backend
    this.rootPath = backend.rootPath.replace(/\\/g, '/')
    this.rootIdentity = this.rootPath.normalize('NFC').toLowerCase()
    this.store = new ModuleRuntimeStateStore(backend)
  }

  async list(): Promise<readonly ModuleDeviceState[]> {
    return this.listAttempt(ENUMERATION_RETRY_LIMIT)
  }

  private async listAttempt(
    retriesRemaining: number,
  ): Promise<readonly ModuleDeviceState[]> {
    const rootStat = await this.backend.adapter.stat(this.rootPath)
    if (rootStat === null) return EMPTY_STATES
    if (rootStat.type !== 'folder') {
      throw new Error('Module device state root is not a folder')
    }
    const listing = await this.backend.adapter.list(this.rootPath)
    if (listing.folders.length > 0) {
      throw new Error('Module device state root contains unexpected folders')
    }
    if (listing.files.length === 0) return EMPTY_STATES
    if (listing.files.length > MAX_DEVICE_STATE_RECORDS) {
      throw new Error('Module device state root contains too many records')
    }

    const moduleIds: string[] = []
    const seen = new Set<string>()
    for (const path of listing.files) {
      const prefix = `${this.rootPath}/`
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) {
        throw new Error(
          `Module device state root contains unexpected file "${path}"`,
        )
      }
      const fileName = path.slice(prefix.length)
      if (!fileName.endsWith('.json')) {
        throw new Error(
          `Module device state root contains malformed filename "${fileName}"`,
        )
      }
      const moduleId = fileName.slice(0, -'.json'.length)
      try {
        assertModuleId(moduleId, 'Module id')
      } catch (error) {
        throw new Error(
          `Module device state root contains malformed filename "${fileName}": ${describeError(error)}`,
        )
      }
      const canonicalPath = `${this.rootPath}/${moduleId}.json`
      if (path !== canonicalPath || seen.has(moduleId)) {
        throw new Error(
          `Module device state root contains an alias for "${canonicalPath}"`,
        )
      }
      seen.add(moduleId)
      moduleIds.push(moduleId)
    }

    moduleIds.sort()
    const states = await Promise.all(
      moduleIds.map(async (moduleId) => {
        const value = await this.read(moduleId)
        if (value === null) {
          if (retriesRemaining > 0) return null
          throw new Error(
            'Module device state changed repeatedly during listing',
          )
        }
        return value
      }),
    )
    const stableStates = states.filter(
      (state): state is ModuleDeviceState => state !== null,
    )
    if (stableStates.length !== states.length) {
      return this.listAttempt(retriesRemaining - 1)
    }
    return Object.freeze(stableStates)
  }

  async read(moduleId: string): Promise<ModuleDeviceState | null> {
    assertModuleId(moduleId, 'Module id')
    return this.readUnlocked(moduleId)
  }

  private async readUnlocked(
    moduleId: string,
  ): Promise<ModuleDeviceState | null> {
    let envelope
    try {
      envelope = await this.store.read(moduleId)
    } catch (error) {
      if (error instanceof ModuleSettingsCorruptionError) {
        throw new ModuleDeviceStateCorruptionError(moduleId, error)
      }
      throw error
    }
    if (envelope === null) return null
    try {
      if (envelope.schemaVersion !== SCHEMA_VERSION) {
        throw new Error(`unsupported schema version ${envelope.schemaVersion}`)
      }
      return parseState(envelope.data, moduleId)
    } catch (error) {
      throw new ModuleDeviceStateCorruptionError(moduleId, error)
    }
  }

  async write(state: ModuleDeviceState): Promise<ModuleDeviceState> {
    const snapshot = parseState(state)
    return this.runExclusive(snapshot.moduleId, (transaction) =>
      transaction.write(snapshot),
    )
  }

  private async writeUnlocked(
    state: ModuleDeviceState,
    moduleId: string,
  ): Promise<ModuleDeviceState> {
    const snapshot = parseState(state, moduleId)
    const envelope = await this.store.write(snapshot.moduleId, {
      schemaVersion: SCHEMA_VERSION,
      data: snapshot,
    })
    return parseState(envelope.data, snapshot.moduleId)
  }

  runExclusive<T>(
    moduleId: string,
    operation: (transaction: ModuleDeviceStateTransaction) => Promise<T>,
  ): Promise<T> {
    assertModuleId(moduleId, 'Module id')
    if (typeof operation !== 'function') {
      throw new TypeError('Module device state operation must be a function')
    }
    let queues = transactionQueues.get(this.backend.adapter)
    if (!queues) {
      queues = new Map()
      transactionQueues.set(this.backend.adapter, queues)
    }
    const key = `${this.rootIdentity}\u0000${moduleId}`
    const previous = queues.get(key) ?? Promise.resolve()
    const transaction: ModuleDeviceStateTransaction = Object.freeze({
      read: () => this.readUnlocked(moduleId),
      write: (state) => this.writeUnlocked(state, moduleId),
      remove: () => this.removeUnlocked(moduleId),
    })
    const result = previous
      .catch(() => undefined)
      .then(() => operation(transaction))
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    queues.set(key, tail)
    void tail.then(() => {
      if (queues?.get(key) === tail) queues.delete(key)
    })
    return result
  }

  remove(moduleId: string): Promise<void> {
    assertModuleId(moduleId, 'Module id')
    return this.runExclusive(moduleId, (transaction) => transaction.remove())
  }

  private async removeUnlocked(moduleId: string): Promise<void> {
    try {
      await this.readUnlocked(moduleId)
    } catch (error) {
      if (!(error instanceof ModuleDeviceStateCorruptionError)) throw error
      await this.store.remove(moduleId)
      return
    }
    await this.store.remove(moduleId)
  }
}

function parseState(
  value: unknown,
  expectedModuleId?: string,
): ModuleDeviceState {
  const state = plainRecord(value, 'Module device state')
  assertExactKeys(state, ['moduleId', 'platform', 'active', 'pending'])
  const moduleId = dataProperty(state, 'moduleId')
  const platform = dataProperty(state, 'platform')
  if (typeof moduleId !== 'string') throw new Error('moduleId is invalid')
  assertModuleId(moduleId, 'Module id')
  if (expectedModuleId !== undefined && moduleId !== expectedModuleId) {
    throw new Error('moduleId does not match its storage namespace')
  }
  if (platform !== 'desktop' && platform !== 'mobile') {
    throw new Error('platform is invalid')
  }

  const activeValue = dataProperty(state, 'active')
  const active =
    activeValue === null
      ? null
      : parseDescriptor(activeValue, moduleId, platform, 'Active descriptor')
  const pendingValue = dataProperty(state, 'pending')
  let pending: ModuleDeviceState['pending'] = null
  if (pendingValue !== null) {
    const pendingRecord = plainRecord(pendingValue, 'Pending module')
    assertExactKeys(pendingRecord, ['descriptor'])
    pending = Object.freeze({
      descriptor: parseDescriptor(
        dataProperty(pendingRecord, 'descriptor'),
        moduleId,
        platform,
        'Pending descriptor',
      ),
    })
  }
  return Object.freeze({
    moduleId,
    platform,
    active,
    pending,
  })
}

function parseDescriptor(
  value: unknown,
  moduleId: string,
  platform: 'desktop' | 'mobile',
  label: string,
): ModuleArtifactDescriptor {
  const descriptor = plainRecord(value, label)
  assertExactKeys(descriptor, [
    'id',
    'version',
    'hostApi',
    'dataSchemas',
    'platform',
    'manifestUrl',
    'manifest',
  ])
  const id = dataProperty(descriptor, 'id')
  const version = dataProperty(descriptor, 'version')
  const descriptorPlatform = dataProperty(descriptor, 'platform')
  const hostApi = dataProperty(descriptor, 'hostApi')
  const manifestUrl = dataProperty(descriptor, 'manifestUrl')
  if (
    id !== moduleId ||
    typeof version !== 'string' ||
    descriptorPlatform !== platform
  ) {
    throw new Error('Descriptor identity does not match its enclosing state')
  }
  assertVersion(version, 'Descriptor version')
  if (!isModuleHostApiRange(hostApi)) throw new Error('hostApi is invalid')
  if (!isOfficialModuleReleaseUrl(manifestUrl)) {
    throw new Error('manifestUrl is invalid')
  }

  const manifest = plainRecord(dataProperty(descriptor, 'manifest'), 'manifest')
  assertExactKeys(manifest, ['byteSize', 'sha256'])
  const byteSize = dataProperty(manifest, 'byteSize')
  const sha256 = dataProperty(manifest, 'sha256')
  if (
    !Number.isSafeInteger(byteSize) ||
    (byteSize as number) <= 0 ||
    (byteSize as number) > MAX_MODULE_MANIFEST_BYTES ||
    typeof sha256 !== 'string' ||
    !SHA256.test(sha256)
  ) {
    throw new Error('manifest metadata is invalid')
  }
  return Object.freeze({
    id: moduleId,
    version,
    hostApi,
    dataSchemas: parseDataSchemas(dataProperty(descriptor, 'dataSchemas')),
    platform,
    manifestUrl,
    manifest: Object.freeze({
      byteSize: byteSize as number,
      sha256: sha256.toLowerCase(),
    }),
  })
}

function parseDataSchemas(
  value: unknown,
): ModuleArtifactDescriptor['dataSchemas'] {
  const input = plainRecord(value, 'dataSchemas')
  const names = Object.getOwnPropertyNames(input)
  if (names.length > 32) throw new Error('dataSchemas is invalid')
  const result: Record<
    string,
    Readonly<{ readMin: number; readMax: number; write: number }>
  > = {}
  for (const name of names) {
    assertSafeName(name, 'Data schema namespace')
    if (!SCHEMA_NAMESPACE.test(name)) throw new Error('dataSchemas is invalid')
    const schema = plainRecord(dataProperty(input, name), `Data schema ${name}`)
    assertExactKeys(schema, ['readMin', 'readMax', 'write'])
    const readMin = dataProperty(schema, 'readMin')
    const readMax = dataProperty(schema, 'readMax')
    const write = dataProperty(schema, 'write')
    if (
      !isSchemaVersion(readMin) ||
      !isSchemaVersion(readMax) ||
      !isSchemaVersion(write) ||
      readMin > readMax ||
      write < readMin ||
      write > readMax
    ) {
      throw new Error(`Data schema "${name}" is invalid`)
    }
    result[name] = Object.freeze({ readMin, readMax, write })
  }
  return Object.freeze(result)
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new TypeError(`${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const names = Object.getOwnPropertyNames(value)
  for (const name of names) assertSafeName(name, 'Property')
  if (
    names.length !== expected.length ||
    expected.some((name) => !names.includes(name))
  ) {
    throw new Error(`Object must contain only ${expected.join(', ')}`)
  }
  for (const name of names) dataProperty(value, name)
}

function dataProperty(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
    throw new TypeError(
      `Property "${name}" must be an enumerable data property`,
    )
  }
  return descriptor.value
}

function assertSafeName(value: string, label: string): void {
  if (DANGEROUS_NAMES.has(value)) throw new Error(`${label} is forbidden`)
}

function assertVersion(value: string, label: string): void {
  assertSafeName(value, label)
  if (!SEMVER.test(value)) throw new Error(`${label} must be semantic`)
}

function isSchemaVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
