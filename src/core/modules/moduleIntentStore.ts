import {
  type ModuleDataEnvelope,
  ModuleSettingsCorruptionError,
  ModuleSettingsStore,
  type SynchronizedModuleSettingsBackend,
} from './moduleSettingsStore'
import { assertModuleId } from './moduleStore'
import type { ModuleDisposer } from './types'

const SCHEMA_VERSION = 1
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export type ModuleIntent = Readonly<{
  desiredInstalled: boolean
  enabled: boolean
}>

export type ModuleIntentBackend = Readonly<{
  capture(): SynchronizedModuleSettingsBackend
  subscribe(moduleId: string, listener: () => void): ModuleDisposer
}>

type IntentData = Record<string, unknown> & ModuleIntent

const intentQueues = new WeakMap<object, Map<string, Promise<void>>>()

export class ModuleIntentWriteUncertainError extends Error {
  readonly originalError: unknown
  readonly readbackError: unknown

  constructor(
    moduleId: string,
    originalError: unknown,
    readbackError: unknown,
  ) {
    super(
      `Module intent write for "${moduleId}" failed and its committed state could not be read back`,
    )
    this.name = 'ModuleIntentWriteUncertainError'
    this.originalError = originalError
    this.readbackError = readbackError
  }
}

/** Synchronized installation/enabling intent stored in one file per module. */
export class ModuleIntentStore {
  constructor(private readonly backend: ModuleIntentBackend) {}

  get(moduleId: string): Promise<ModuleIntent | undefined> {
    assertModuleId(moduleId, 'Module id')
    const captured = this.backend.capture()
    return enqueue(captured, moduleId, async () => {
      const envelope = await new ModuleSettingsStore(captured).read(moduleId)
      return envelope === null
        ? undefined
        : intentFromData(parseEnvelope(envelope))
    })
  }

  set(moduleId: string, next: ModuleIntent): Promise<ModuleIntent> {
    assertModuleId(moduleId, 'Module id')
    const parsedNext = parseInputIntent(next)
    const captured = this.backend.capture()
    return enqueue(captured, moduleId, async () => {
      const store = new ModuleSettingsStore(captured)
      const current = await store.read(moduleId)
      const currentData = current === null ? {} : parseEnvelope(current)
      const intended: ModuleDataEnvelope<IntentData> = {
        schemaVersion: SCHEMA_VERSION,
        data: {
          ...currentData,
          desiredInstalled: parsedNext.desiredInstalled,
          enabled: parsedNext.enabled,
        } as IntentData,
      }

      try {
        const written = await store.write(moduleId, intended)
        return intentFromData(parseEnvelope(written))
      } catch (writeError) {
        let readback: ModuleDataEnvelope | null
        try {
          readback = await store.read(moduleId)
        } catch (readbackError) {
          throw new ModuleIntentWriteUncertainError(
            moduleId,
            writeError,
            readbackError,
          )
        }
        if (
          readback !== null &&
          semanticallyEqualEnvelope(readback, intended)
        ) {
          return intentFromData(parseEnvelope(readback))
        }
        throw writeError
      }
    })
  }

  subscribe(moduleId: string, listener: () => void): ModuleDisposer {
    assertModuleId(moduleId, 'Module id')
    if (typeof listener !== 'function') {
      throw new TypeError('Module intent listener must be a function')
    }
    return this.backend.subscribe(moduleId, listener)
  }
}

function parseEnvelope(envelope: ModuleDataEnvelope): IntentData {
  if (envelope.schemaVersion !== SCHEMA_VERSION) {
    throw corruption(
      `schemaVersion must be ${String(SCHEMA_VERSION)}, received ${String(envelope.schemaVersion)}`,
    )
  }
  assertNoDangerousKeys(envelope.data, new Set())
  const data = requirePlainObject(envelope.data, 'data')
  if (
    typeof data.desiredInstalled !== 'boolean' ||
    typeof data.enabled !== 'boolean'
  ) {
    throw corruption(
      'data must contain boolean desiredInstalled and enabled fields',
    )
  }
  return data as IntentData
}

function intentFromData(data: IntentData): ModuleIntent {
  return Object.freeze({
    desiredInstalled: data.desiredInstalled,
    enabled: data.enabled,
  })
}

function parseInputIntent(value: ModuleIntent): ModuleIntent {
  const record = requirePlainObject(value, 'Module intent', TypeError)
  const names = Object.keys(record)
  if (
    names.length !== 2 ||
    !names.includes('desiredInstalled') ||
    !names.includes('enabled') ||
    typeof record.desiredInstalled !== 'boolean' ||
    typeof record.enabled !== 'boolean'
  ) {
    throw new TypeError(
      'Module intent must contain only boolean desiredInstalled and enabled fields',
    )
  }
  return intentFromData(record as IntentData)
}

function requirePlainObject(
  value: unknown,
  label: string,
  ErrorType: new (message: string) => Error = ModuleSettingsCorruptionError,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new ErrorType(`${label} must be a plain object`)
  }
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new ErrorType(
        `${label}.${name} must be an enumerable data property`,
      )
    }
  }
  return value as Record<string, unknown>
}

function assertNoDangerousKeys(value: unknown, active: Set<object>): void {
  if (value === null || typeof value !== 'object') return
  if (active.has(value)) throw corruption('data must not contain cycles')
  active.add(value)
  try {
    for (const key of Object.getOwnPropertyNames(value)) {
      if (Array.isArray(value) && key === 'length') continue
      if (DANGEROUS_KEYS.has(key)) {
        throw corruption(`dangerous JSON key "${key}" is not allowed`)
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) {
        throw corruption(`JSON property "${key}" must be a data property`)
      }
      assertNoDangerousKeys(descriptor.value, active)
    }
  } finally {
    active.delete(value)
  }
}

function corruption(message: string): ModuleSettingsCorruptionError {
  return new ModuleSettingsCorruptionError(
    `Module intent file is invalid: ${message}`,
  )
}

function semanticallyEqualEnvelope(
  actual: ModuleDataEnvelope,
  intended: ModuleDataEnvelope,
): boolean {
  try {
    const actualData = parseEnvelope(actual)
    const intendedData = parseEnvelope(intended)
    return canonicalJson(actualData) === canonicalJson(intendedData)
  } catch {
    return false
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

function enqueue<T>(
  backend: SynchronizedModuleSettingsBackend,
  moduleId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let queues = intentQueues.get(backend.adapter)
  if (!queues) {
    queues = new Map()
    intentQueues.set(backend.adapter, queues)
  }
  const key = `${canonicalRoot(backend.rootPath)}\u0000${moduleId}`
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

function canonicalRoot(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .normalize('NFC')
    .toLowerCase()
}
