import type { ModuleIntentBackend } from '../modules/moduleIntentStore'
import {
  ModuleSettingsCorruptionError,
  ModuleSettingsStore,
} from '../modules/moduleSettingsStore'

import type { RuntimeComponentId } from './contracts'

export class RuntimeComponentIntentStore {
  constructor(private readonly backend: ModuleIntentBackend) {}

  async isEnabled(id: RuntimeComponentId): Promise<boolean> {
    const envelope = await new ModuleSettingsStore(this.backend.capture()).read(
      id,
    )
    if (envelope === null) return true
    if (
      envelope.schemaVersion !== 1 ||
      !envelope.data ||
      typeof envelope.data !== 'object' ||
      Array.isArray(envelope.data) ||
      Object.keys(envelope.data).length !== 1 ||
      (envelope.data as { state?: unknown }).state !== 'disabled'
    ) {
      throw new ModuleSettingsCorruptionError(
        `Runtime component intent for "${id}" must contain disabled state`,
      )
    }
    return false
  }

  async disable(id: RuntimeComponentId): Promise<void> {
    const store = new ModuleSettingsStore(this.backend.capture())
    const written = await store.write(id, {
      schemaVersion: 1,
      data: { state: 'disabled' },
    })
    if ((written.data as { state?: unknown }).state !== 'disabled') {
      throw new Error(
        `Runtime component "${id}" disabled intent was not persisted`,
      )
    }
  }

  async enable(id: RuntimeComponentId): Promise<void> {
    const store = new ModuleSettingsStore(this.backend.capture())
    const current = await store.read(id)
    if (current === null) return
    if ((current.data as { state?: unknown }).state !== 'disabled') {
      throw new ModuleSettingsCorruptionError(
        `Runtime component intent for "${id}" is invalid`,
      )
    }
    await store.remove(id)
  }

  subscribe(id: RuntimeComponentId, listener: () => void): () => void {
    return this.backend.subscribe(id, listener)
  }
}
