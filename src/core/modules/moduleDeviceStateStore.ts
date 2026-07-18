import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
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
import {
  type ModuleTransitionJournal,
  advanceModuleTransitionPhase,
  parseModuleTransitionJournal,
} from './moduleTransitionJournal'
import { isOfficialModuleReleaseUrl } from './officialModuleCatalogClient'

const SCHEMA_VERSION = 2
const LEGACY_SCHEMA_VERSION = 1
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
  activeVersion: string | null
  downloadedCandidate: string | null
  pendingVersion: string | null
  readyVersions: Readonly<Record<string, ModuleArtifactDescriptor>>
  transition: ModuleTransitionJournal | null
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
      if (
        envelope.schemaVersion !== LEGACY_SCHEMA_VERSION &&
        envelope.schemaVersion !== SCHEMA_VERSION
      ) {
        throw new Error(`unsupported schema version ${envelope.schemaVersion}`)
      }
      return parseState(
        envelope.data,
        moduleId,
        envelope.schemaVersion === LEGACY_SCHEMA_VERSION,
      )
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
    const existing = await this.readUnlocked(moduleId)
    assertDurableTransitionProgression(existing, snapshot)
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
    let existing: ModuleDeviceState | null
    try {
      existing = await this.readUnlocked(moduleId)
    } catch (error) {
      if (!(error instanceof ModuleDeviceStateCorruptionError)) throw error
      await this.store.remove(moduleId)
      return
    }
    if (existing?.transition) {
      throw new Error(
        'Device state with an active transition cannot be removed',
      )
    }
    await this.store.remove(moduleId)
  }
}

function parseState(
  value: unknown,
  expectedModuleId?: string,
  legacyV1 = false,
): ModuleDeviceState {
  const state = plainRecord(value, 'Module device state')
  const v1Keys = [
    'moduleId',
    'platform',
    'activeVersion',
    'downloadedCandidate',
    'pendingVersion',
    'readyVersions',
  ] as const
  if (legacyV1) {
    assertExactKeys(state, v1Keys)
  } else {
    assertExactKeys(state, [...v1Keys, 'transition'])
  }
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

  const readyInput = plainRecord(
    dataProperty(state, 'readyVersions'),
    'readyVersions',
  )
  const readyVersions: Record<string, ModuleArtifactDescriptor> = {}
  for (const version of Object.getOwnPropertyNames(readyInput)) {
    assertSafeName(version, 'Ready version')
    assertVersion(version, 'Ready version')
    readyVersions[version] = parseDescriptor(
      dataProperty(readyInput, version),
      moduleId,
      version,
      platform,
    )
  }

  const activeVersion = parsePointer(state, 'activeVersion', readyVersions)
  const downloadedCandidate = parsePointer(
    state,
    'downloadedCandidate',
    readyVersions,
  )
  const pendingVersion = parsePointer(state, 'pendingVersion', readyVersions)
  const transitionValue = legacyV1 ? null : dataProperty(state, 'transition')
  const transition =
    transitionValue === null
      ? null
      : parseModuleTransitionJournal(transitionValue, {
          moduleId,
          platform,
          activeVersion,
          downloadedCandidate,
          pendingVersion,
          readyVersions: Object.keys(readyVersions),
          targetDescriptor:
            typeof transitionValue === 'object' && transitionValue !== null
              ? (readyVersions[readTransitionTargetVersion(transitionValue)] ??
                null)
              : null,
        })
  return Object.freeze({
    moduleId,
    platform,
    activeVersion,
    downloadedCandidate,
    pendingVersion,
    readyVersions: Object.freeze(readyVersions),
    transition,
  })
}

function assertDurableTransitionProgression(
  existing: ModuleDeviceState | null,
  next: ModuleDeviceState,
): void {
  if (existing === null) {
    if (next.transition !== null) {
      throw new Error('Transition preparation requires existing device state')
    }
    return
  }
  if (equalJson(existing, next)) return

  const current = existing.transition
  const following = next.transition
  if (current === null) {
    if (following === null) return
    if (following.phase !== 'prepared') {
      throw new Error('A new transition must begin in the prepared phase')
    }
    const expected = {
      ...existing,
      downloadedCandidate: null,
      pendingVersion: following.targetVersion,
      transition: following,
    }
    if (
      existing.pendingVersion !== null ||
      existing.downloadedCandidate !== following.targetVersion ||
      following.previousActiveVersion !== existing.activeVersion ||
      !equalJson(expected, next)
    ) {
      throw new Error('Prepared transition state mutation is invalid')
    }
    return
  }

  if (following === null) {
    if (
      current.phase !== 'prepared' &&
      current.phase !== 'rollback-completed' &&
      current.phase !== 'committed'
    ) {
      throw new Error(
        'Transition settings must be restored before journal cleanup',
      )
    }
    const expected =
      current.phase === 'prepared'
        ? {
            ...existing,
            activeVersion: current.previousActiveVersion,
            downloadedCandidate: current.targetVersion,
            pendingVersion: null,
            transition: null,
          }
        : { ...existing, transition: null }
    if (!equalJson(expected, next)) {
      throw new Error('Transition cleanup or rollback state is invalid')
    }
    return
  }

  if (!equalJournalPayload(current, following)) {
    throw new Error('Transition immutable payload cannot be replaced')
  }
  advanceModuleTransitionPhase(current.phase, following.phase)
  const expected =
    current.phase === 'activation-started' && following.phase === 'committed'
      ? {
          ...existing,
          activeVersion: current.targetVersion,
          pendingVersion: null,
          transition: following,
        }
      : following.phase === 'rollback-completed'
        ? {
            ...existing,
            activeVersion: current.previousActiveVersion,
            downloadedCandidate: current.targetVersion,
            pendingVersion: null,
            transition: following,
          }
        : { ...existing, transition: following }
  if (!equalJson(expected, next)) {
    throw new Error('Transition phase write contains unrelated state mutation')
  }
}

function equalJournalPayload(
  left: ModuleTransitionJournal,
  right: ModuleTransitionJournal,
): boolean {
  return (
    left.moduleId === right.moduleId &&
    left.platform === right.platform &&
    left.previousActiveVersion === right.previousActiveVersion &&
    left.targetVersion === right.targetVersion &&
    left.targetManifestSha256 === right.targetManifestSha256 &&
    equalJson(left.settings, right.settings)
  )
}

function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return false
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => equalJson(value, right[index]))
    )
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        equalJson(leftRecord[key], rightRecord[key]),
    )
  )
}

function readTransitionTargetVersion(value: object): string {
  const transition = plainRecord(value, 'Module transition journal')
  const targetVersion = dataProperty(transition, 'targetVersion')
  return typeof targetVersion === 'string' ? targetVersion : ''
}

function parseDescriptor(
  value: unknown,
  moduleId: string,
  version: string,
  platform: 'desktop' | 'mobile',
): ModuleArtifactDescriptor {
  const descriptor = plainRecord(value, `Descriptor ${version}`)
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
  const descriptorVersion = dataProperty(descriptor, 'version')
  const descriptorPlatform = dataProperty(descriptor, 'platform')
  const hostApi = dataProperty(descriptor, 'hostApi')
  const manifestUrl = dataProperty(descriptor, 'manifestUrl')
  if (
    id !== moduleId ||
    descriptorVersion !== version ||
    descriptorPlatform !== platform
  ) {
    throw new Error('Descriptor identity does not match its enclosing state')
  }
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

function parsePointer(
  state: Record<string, unknown>,
  name: 'activeVersion' | 'downloadedCandidate' | 'pendingVersion',
  readyVersions: Readonly<Record<string, ModuleArtifactDescriptor>>,
): string | null {
  const value = dataProperty(state, name)
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`${name} is invalid`)
  assertVersion(value, name)
  if (!Object.prototype.hasOwnProperty.call(readyVersions, value)) {
    throw new Error(`${name} must refer to a ready version`)
  }
  return value
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
