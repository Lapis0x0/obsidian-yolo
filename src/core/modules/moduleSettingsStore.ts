import type { DataAdapter } from 'obsidian'

import { assertModuleId, assertModulePathSegment } from './moduleStore'

/**
 * Logical placement contract supplied by the caller. It does not make a path
 * physically synchronized or device-local; the injected adapter/root must do so.
 */
export type ModuleStorageKind =
  | 'synchronized-intent'
  | 'device-local-runtime-state'

export type ModuleStorageBackend<K extends ModuleStorageKind> = Readonly<{
  kind: K
  adapter: DataAdapter
  /** Caller-owned vault-relative root. The store deliberately chooses no path. */
  rootPath: string
}>

export type SynchronizedModuleSettingsBackend =
  ModuleStorageBackend<'synchronized-intent'>
export type DeviceLocalModuleRuntimeStateBackend =
  ModuleStorageBackend<'device-local-runtime-state'>

export type ModuleDataEnvelope<T = unknown> = Readonly<{
  schemaVersion: number
  data: T
}>

/** A migration must synchronously return plain JSON data. */
export type ModuleDataMigration = (data: unknown) => unknown

const queues = new WeakMap<object, Map<string, Promise<void>>>()
const backendKinds = new WeakMap<object, Map<string, ModuleStorageKind>>()
const activeMigrations = new WeakMap<object, Set<string>>()

export class ModuleSettingsCorruptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModuleSettingsCorruptionError'
  }
}

export class ModuleSettingsConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModuleSettingsConflictError'
  }
}

/**
 * Module-namespaced JSON storage over an injected DataAdapter backend.
 *
 * DataAdapter has no compare-and-swap primitive. Writes are serialized only
 * within this process, then read back and verified. A write never attempts to
 * restore an older value because it cannot prove that doing so is safe against
 * an external sync writer.
 */
export class ModuleNamespacedDataStore<K extends ModuleStorageKind> {
  readonly kind: K
  private readonly rootPath: string
  private readonly rootIdentity: string

  constructor(private readonly backend: ModuleStorageBackend<K>) {
    this.kind = backend.kind
    this.rootPath = normalizeStorageRoot(backend.rootPath)
    this.rootIdentity = canonicalStorageIdentity(this.rootPath)
    registerBackendKind(backend.adapter, this.rootIdentity, backend.kind)
  }

  read<T = unknown>(moduleId: string): Promise<ModuleDataEnvelope<T> | null> {
    const paths = this.pathsFor(moduleId)
    return this.enqueue(paths.target, async () => {
      const raw = await this.readRaw(paths.target)
      return raw === null
        ? null
        : (parseEnvelope(raw, moduleId) as ModuleDataEnvelope<T>)
    })
  }

  write<T>(
    moduleId: string,
    envelope: ModuleDataEnvelope<T>,
  ): Promise<ModuleDataEnvelope<T>> {
    const paths = this.pathsFor(moduleId)
    this.assertNotMigrating(paths.target)
    const next = serializeEnvelope(envelope, moduleId)
    return this.enqueue(paths.target, async () => {
      await this.ensureRoot()
      const previous = await this.readRaw(paths.target)
      if (previous !== null) parseEnvelope(previous, moduleId)
      if (previous !== null && canonicalEnvelope(previous, moduleId) === next) {
        return parseEnvelope(next, moduleId) as ModuleDataEnvelope<T>
      }
      return (await this.writeVerified(
        paths.target,
        next,
        moduleId,
      )) as ModuleDataEnvelope<T>
    })
  }

  migrate(
    moduleId: string,
    targetSchemaVersion: number,
    migrations: Readonly<Record<number, ModuleDataMigration>>,
  ): Promise<ModuleDataEnvelope> {
    assertSchemaVersion(targetSchemaVersion, 'Target schema version')
    const paths = this.pathsFor(moduleId)
    this.assertNotMigrating(paths.target)
    return this.enqueue(paths.target, async () => {
      await this.ensureRoot()
      const currentRaw = await this.readRaw(paths.target)
      if (currentRaw === null) {
        throw new Error(`Module "${moduleId}" has no data to migrate`)
      }
      let current = parseEnvelope(currentRaw, moduleId)
      if (current.schemaVersion > targetSchemaVersion) {
        throw new Error(
          `Module "${moduleId}" schema ${current.schemaVersion} is newer than ${targetSchemaVersion}`,
        )
      }

      this.markMigrating(paths.target)
      try {
        while (current.schemaVersion < targetSchemaVersion) {
          const migration = migrations[current.schemaVersion]
          if (!migration) {
            throw new Error(
              `Module "${moduleId}" has no migration from schema ${current.schemaVersion}`,
            )
          }
          const migrated = migration(current.data)
          if (isPromise(migrated)) {
            throw new TypeError(
              `Module "${moduleId}" migration from schema ${current.schemaVersion} must return synchronously`,
            )
          }
          current = parseEnvelope(
            serializeEnvelope(
              {
                schemaVersion: current.schemaVersion + 1,
                data: migrated,
              },
              moduleId,
            ),
            moduleId,
          )
        }
        if (
          canonicalEnvelope(currentRaw, moduleId) ===
          serializeEnvelope(current, moduleId)
        ) {
          return current
        }
        return await this.writeVerified(
          paths.target,
          serializeEnvelope(current, moduleId),
          moduleId,
        )
      } finally {
        this.unmarkMigrating(paths.target)
      }
    })
  }

  private pathsFor(moduleId: string): Readonly<{ target: string }> {
    assertModuleId(moduleId, 'Module id')
    return { target: `${this.rootPath}/${moduleId}.json` }
  }

  private async writeVerified(
    target: string,
    next: string,
    moduleId: string,
  ): Promise<ModuleDataEnvelope> {
    await this.backend.adapter.write(target, next)
    const actual = await this.backend.adapter.read(target)
    const actualCanonical = canonicalEnvelope(actual, moduleId)
    if (actualCanonical !== next) {
      throw new ModuleSettingsConflictError(
        `Module "${moduleId}" changed while its write was being verified`,
      )
    }
    return parseEnvelope(actual, moduleId)
  }

  private async ensureRoot(): Promise<void> {
    let path = ''
    for (const segment of this.rootPath.split('/')) {
      path = path ? `${path}/${segment}` : segment
      if (await this.backend.adapter.exists(path)) continue
      try {
        await this.backend.adapter.mkdir(path)
      } catch (error) {
        if (!(await this.backend.adapter.exists(path))) throw error
      }
    }
  }

  private async readRaw(path: string): Promise<string | null> {
    return (await this.backend.adapter.exists(path))
      ? await this.backend.adapter.read(path)
      : null
  }

  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    let adapterQueues = queues.get(this.backend.adapter)
    if (!adapterQueues) {
      adapterQueues = new Map()
      queues.set(this.backend.adapter, adapterQueues)
    }
    const queueKey = this.identityKey(key)
    const previous = adapterQueues.get(queueKey) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    adapterQueues.set(queueKey, settled)
    void settled.finally(() => {
      if (adapterQueues?.get(queueKey) === settled)
        adapterQueues.delete(queueKey)
    })
    return result
  }

  private assertNotMigrating(target: string): void {
    if (
      activeMigrations.get(this.backend.adapter)?.has(this.identityKey(target))
    ) {
      throw new Error(
        'Module storage cannot be written reentrantly from a migration',
      )
    }
  }

  private markMigrating(target: string): void {
    let active = activeMigrations.get(this.backend.adapter)
    if (!active) {
      active = new Set()
      activeMigrations.set(this.backend.adapter, active)
    }
    active.add(this.identityKey(target))
  }

  private unmarkMigrating(target: string): void {
    const active = activeMigrations.get(this.backend.adapter)
    active?.delete(this.identityKey(target))
    if (active?.size === 0) activeMigrations.delete(this.backend.adapter)
  }

  private identityKey(target: string): string {
    return `${this.rootIdentity}\u0000${canonicalStorageIdentity(target)}`
  }
}

export class ModuleSettingsStore extends ModuleNamespacedDataStore<'synchronized-intent'> {
  constructor(backend: SynchronizedModuleSettingsBackend) {
    super(backend)
  }
}

export class ModuleRuntimeStateStore extends ModuleNamespacedDataStore<'device-local-runtime-state'> {
  constructor(backend: DeviceLocalModuleRuntimeStateBackend) {
    super(backend)
  }
}

function parseEnvelope(raw: string, label: string): ModuleDataEnvelope {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new ModuleSettingsCorruptionError(
      `Module storage for "${label}" contains invalid JSON`,
    )
  }
  try {
    const fields = inspectEnvelope(value)
    assertSchemaVersion(fields.schemaVersion, 'Stored schema version')
    assertJsonValue(fields.data, new Set())
    return deepFreeze({
      schemaVersion: fields.schemaVersion,
      data: fields.data,
    })
  } catch (error) {
    throw new ModuleSettingsCorruptionError(
      `Module storage for "${label}" has an invalid envelope: ${describeError(error)}`,
    )
  }
}

function serializeEnvelope(
  envelope: ModuleDataEnvelope,
  label: string,
): string {
  let fields: EnvelopeFields
  try {
    fields = inspectEnvelope(envelope)
  } catch (error) {
    throw new TypeError(
      `Module storage for "${label}" requires a plain data envelope: ${describeError(error)}`,
    )
  }
  assertSchemaVersion(fields.schemaVersion, 'Schema version')
  assertJsonValue(fields.data, new Set())
  return `{"schemaVersion":${String(fields.schemaVersion)},"data":${serializeJsonValue(fields.data)}}`
}

type EnvelopeFields = Readonly<{ schemaVersion: unknown; data: unknown }>

function inspectEnvelope(value: unknown): EnvelopeFields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Envelope must be an object')
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('Envelope must have the ordinary object prototype')
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('Envelope must not have symbol properties')
  }
  const names = Object.getOwnPropertyNames(value)
  if (
    names.length !== 2 ||
    !names.includes('schemaVersion') ||
    !names.includes('data')
  ) {
    throw new TypeError('Envelope must contain only schemaVersion and data')
  }
  const schemaVersion = getPlainDataProperty(value, 'schemaVersion')
  const data = getPlainDataProperty(value, 'data')
  return { schemaVersion, data }
}

function canonicalEnvelope(raw: string, label: string): string {
  return serializeEnvelope(parseEnvelope(raw, label), label)
}

function serializeJsonValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeJsonValue(item)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .map((key) => `${JSON.stringify(key)}:${serializeJsonValue(record[key])}`)
    .join(',')}}`
}

function assertSchemaVersion(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer`)
  }
}

function assertJsonValue(value: unknown, active: Set<object>): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('JSON numbers must be finite')
    return
  }
  if (typeof value !== 'object')
    throw new TypeError('Data must contain only JSON values')
  if (active.has(value)) throw new TypeError('Data must not contain cycles')
  active.add(value)
  try {
    if (Array.isArray(value)) {
      assertPlainJsonArray(value, active)
      return
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError(
        'JSON objects must have the ordinary object prototype',
      )
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError('JSON objects must not have symbol properties')
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      assertJsonValue(getPlainDataProperty(value, key), active)
    }
  } finally {
    active.delete(value)
  }
}

function assertPlainJsonArray(value: unknown[], active: Set<object>): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError('JSON arrays must have the ordinary array prototype')
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('JSON arrays must not have symbol properties')
  }
  const names = Object.getOwnPropertyNames(value)
  if (names.length !== value.length + 1 || !names.includes('length')) {
    throw new TypeError(
      'JSON arrays must not be sparse or have custom properties',
    )
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!names.includes(String(index))) {
      throw new TypeError(
        'JSON arrays must not be sparse or have custom properties',
      )
    }
    assertJsonValue(getPlainDataProperty(value, String(index)), active)
  }
}

function getPlainDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
    throw new TypeError(
      `JSON property "${key}" must be an enumerable data property`,
    )
  }
  return descriptor.value
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.getOwnPropertyNames(value)) {
      if (Array.isArray(value) && key === 'length') continue
      deepFreeze(getPlainDataProperty(value, key))
    }
    Object.freeze(value)
  }
  return value
}

function isPromise(value: unknown): value is Promise<unknown> {
  // Avoid reading a user-controlled `then` accessor. Foreign thenables still
  // fail the plain-JSON validator immediately after this check.
  return value instanceof Promise
}

function registerBackendKind(
  adapter: object,
  rootPath: string,
  kind: ModuleStorageKind,
): void {
  let registrations = backendKinds.get(adapter)
  if (!registrations) {
    registrations = new Map()
    backendKinds.set(adapter, registrations)
  }
  const existing = registrations.get(rootPath)
  if (existing && existing !== kind) {
    throw new Error(
      `Module storage root "${rootPath}" is already registered as ${existing}; ${kind} requires a distinct backend root`,
    )
  }
  registrations.set(rootPath, kind)
}

function canonicalStorageIdentity(path: string): string {
  return path.normalize('NFC').toLowerCase()
}

function normalizeStorageRoot(value: string): string {
  const portable = value.replace(/\\/g, '/')
  const parts = portable.split('/')
  if (
    !portable ||
    portable.startsWith('/') ||
    /^[A-Za-z]:\//.test(portable) ||
    parts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Module storage root must be a safe vault-relative path')
  }
  for (const part of parts) {
    assertModulePathSegment(
      part.startsWith('.') ? `root${part}` : part,
      'Module storage root',
    )
  }
  return parts.join('/')
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
