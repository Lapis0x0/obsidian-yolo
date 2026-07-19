import {
  ModuleSettingsCorruptionError,
  ModuleSettingsStore,
  type SynchronizedModuleSettingsBackend,
} from './moduleSettingsStore'
import { assertModuleId } from './moduleStore'
import type { ModuleDisposer } from './types'

const SCHEMA_VERSION = 1

export type ModuleIntent = 'uninstalled' | 'disabled' | 'enabled'

export type ModuleIntentBackend = Readonly<{
  capture(): SynchronizedModuleSettingsBackend
  listModuleIds(): Promise<readonly string[]>
  subscribe(moduleId: string, listener: () => void): ModuleDisposer
  subscribeAll(listener: (moduleId: string) => void): ModuleDisposer
}>

/** Synchronized installation/enabling intent stored in one file per module. */
export class ModuleIntentStore {
  constructor(private readonly backend: ModuleIntentBackend) {}

  get(moduleId: string): Promise<ModuleIntent | undefined> {
    assertModuleId(moduleId, 'Module id')
    return new ModuleSettingsStore(this.backend.capture())
      .read(moduleId)
      .then((envelope) =>
        envelope === null
          ? undefined
          : parseEnvelope(envelope.schemaVersion, envelope.data),
      )
  }

  set(moduleId: string, next: ModuleIntent): Promise<ModuleIntent> {
    assertModuleId(moduleId, 'Module id')
    assertModuleIntent(next)
    return writeIntent(
      new ModuleSettingsStore(this.backend.capture()),
      moduleId,
      next,
    )
  }

  subscribe(moduleId: string, listener: () => void): ModuleDisposer {
    assertModuleId(moduleId, 'Module id')
    if (typeof listener !== 'function') {
      throw new TypeError('Module intent listener must be a function')
    }
    return this.backend.subscribe(moduleId, listener)
  }

  listModuleIds(): Promise<readonly string[]> {
    return this.backend.listModuleIds()
  }

  subscribeAll(listener: (moduleId: string) => void): ModuleDisposer {
    if (typeof listener !== 'function') {
      throw new TypeError('Module intent listener must be a function')
    }
    return this.backend.subscribeAll(listener)
  }
}

async function writeIntent(
  store: ModuleSettingsStore,
  moduleId: string,
  next: ModuleIntent,
): Promise<ModuleIntent> {
  const current = await store.read(moduleId)
  if (current !== null) {
    parseEnvelope(current.schemaVersion, current.data)
  }
  const written = await store.write(moduleId, {
    schemaVersion: SCHEMA_VERSION,
    data: { state: next },
  })
  return parseEnvelope(written.schemaVersion, written.data)
}

function parseEnvelope(schemaVersion: number, data: unknown): ModuleIntent {
  if (schemaVersion !== SCHEMA_VERSION) {
    throw corruption(
      `schemaVersion must be ${String(SCHEMA_VERSION)}, received ${String(schemaVersion)}`,
    )
  }
  if (
    data === null ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    Object.keys(data).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(data, 'state')
  ) {
    throw corruption('data must contain only a state field')
  }
  const state = (data as { state?: unknown }).state
  if (!isModuleIntent(state)) {
    throw corruption('state must be uninstalled, disabled, or enabled')
  }
  return state
}

function assertModuleIntent(value: unknown): asserts value is ModuleIntent {
  if (!isModuleIntent(value)) {
    throw new TypeError(
      'Module intent must be uninstalled, disabled, or enabled',
    )
  }
}

function isModuleIntent(value: unknown): value is ModuleIntent {
  return value === 'uninstalled' || value === 'disabled' || value === 'enabled'
}

function corruption(message: string): ModuleSettingsCorruptionError {
  return new ModuleSettingsCorruptionError(
    `Module intent file is invalid: ${message}`,
  )
}
