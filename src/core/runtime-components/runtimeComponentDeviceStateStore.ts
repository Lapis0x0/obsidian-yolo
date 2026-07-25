import {
  type DeviceLocalModuleRuntimeStateBackend,
  ModuleRuntimeStateStore,
  ModuleSettingsCorruptionError,
} from '../modules/moduleSettingsStore'

import type { RuntimeComponentId } from './contracts'
import type {
  RuntimeComponentDescriptor,
  RuntimeComponentPlatform,
} from './runtimeComponentManifest'

export type RuntimeComponentDeviceState = Readonly<{
  componentId: RuntimeComponentId
  platform: RuntimeComponentPlatform
  activeHash: string | null
  pending: RuntimeComponentDescriptor | null
  error: string | null
}>

export class RuntimeComponentDeviceStateStore {
  private readonly store: ModuleRuntimeStateStore

  constructor(backend: DeviceLocalModuleRuntimeStateBackend) {
    this.store = new ModuleRuntimeStateStore(backend)
  }

  async read(
    id: RuntimeComponentId,
  ): Promise<RuntimeComponentDeviceState | null> {
    const envelope = await this.store.read(id)
    if (envelope === null) return null
    if (envelope.schemaVersion !== 1) {
      throw new ModuleSettingsCorruptionError(
        `Runtime component device state for "${id}" has unsupported schema`,
      )
    }
    return parseState(envelope.data, id)
  }

  async write(
    state: RuntimeComponentDeviceState,
  ): Promise<RuntimeComponentDeviceState> {
    const parsed = parseState(state, state.componentId)
    const written = await this.store.write(parsed.componentId, {
      schemaVersion: 1,
      data: parsed,
    })
    return parseState(written.data, parsed.componentId)
  }
}

function parseState(
  value: unknown,
  id: RuntimeComponentId,
): RuntimeComponentDeviceState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ModuleSettingsCorruptionError(
      'Runtime component state is invalid',
    )
  }
  const state = value as Record<string, unknown>
  const pending = state.pending
  if (
    Object.keys(state).some(
      (key) =>
        !['componentId', 'platform', 'activeHash', 'pending', 'error'].includes(
          key,
        ),
    ) ||
    Object.keys(state).length !== 5 ||
    state.componentId !== id ||
    (state.platform !== 'desktop' && state.platform !== 'mobile') ||
    (state.activeHash !== null &&
      (typeof state.activeHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(state.activeHash))) ||
    (state.error !== null && typeof state.error !== 'string') ||
    (pending !== null && !isDescriptor(pending, id))
  ) {
    throw new ModuleSettingsCorruptionError(
      'Runtime component state is invalid',
    )
  }
  return Object.freeze({
    componentId: id,
    platform: state.platform,
    activeHash: state.activeHash,
    pending,
    error: state.error,
  }) as RuntimeComponentDeviceState
}

function isDescriptor(
  value: unknown,
  id: RuntimeComponentId,
): value is RuntimeComponentDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const descriptor = value as Record<string, unknown>
  return (
    descriptor.id === id &&
    Array.isArray(descriptor.platforms) &&
    descriptor.platforms.length > 0 &&
    descriptor.platforms.every(
      (platform) => platform === 'desktop' || platform === 'mobile',
    ) &&
    typeof descriptor.nameKey === 'string' &&
    typeof descriptor.descriptionKey === 'string' &&
    typeof descriptor.impactKey === 'string' &&
    descriptor.entry === `runtime-components/${id}/dist/entry.js` &&
    Number.isSafeInteger(descriptor.byteSize) &&
    (descriptor.byteSize as number) > 0 &&
    typeof descriptor.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(descriptor.sha256)
  )
}
