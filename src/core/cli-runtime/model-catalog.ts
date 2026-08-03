import type { App } from 'obsidian'

import type { YoloSettingsLike } from '../paths/yoloManagedData'

import { VaultCliModelCatalogStore } from './model-catalog-store'
import type { CliRuntimeId, CliRuntimeModel } from './types'

export type CliModelCatalogSnapshot = ReadonlyMap<
  CliRuntimeId,
  readonly CliRuntimeModel[]
>

export type CliModelCatalogStore = {
  read(): Promise<Map<CliRuntimeId, readonly CliRuntimeModel[]>>
  write(
    models: ReadonlyMap<CliRuntimeId, readonly CliRuntimeModel[]>,
  ): Promise<void>
}

const sameModels = (
  left: readonly CliRuntimeModel[],
  right: readonly CliRuntimeModel[],
): boolean => JSON.stringify(left) === JSON.stringify(right)

/** Keeps a provider-reported active model usable even when its picker omits it. */
export const includeActiveCliModel = (
  models: readonly CliRuntimeModel[],
  modelId: string | null | undefined,
  matches: (model: CliRuntimeModel, modelId: string) => boolean = (
    model,
    candidateId,
  ) => model.id === candidateId,
): CliRuntimeModel[] => {
  const copied = models.map((model) => ({
    ...model,
    reasoningEfforts: model.reasoningEfforts.map((effort) => ({ ...effort })),
  }))
  if (!modelId || copied.some((model) => matches(model, modelId))) return copied
  return [...copied, { id: modelId, label: modelId, reasoningEfforts: [] }]
}

export class CliModelCatalogService {
  private readonly models = new Map<CliRuntimeId, readonly CliRuntimeModel[]>()
  private readonly listeners = new Set<() => void>()
  private readonly refreshes = new Map<CliRuntimeId, Promise<void>>()
  private loadPromise: Promise<void> | null = null

  constructor(private readonly store: CliModelCatalogStore) {}

  static create(
    app: App,
    getSettings: () => YoloSettingsLike | null,
  ): CliModelCatalogService {
    return new CliModelCatalogService(
      new VaultCliModelCatalogStore(app, getSettings),
    )
  }

  getSnapshot = (): CliModelCatalogSnapshot => new Map(this.models)

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async load(): Promise<void> {
    this.loadPromise ??= this.loadFromStore()
    return this.loadPromise
  }

  async record(
    runtimeId: CliRuntimeId,
    models: readonly CliRuntimeModel[],
  ): Promise<void> {
    await this.load()
    const normalized = models.map((model) => ({
      ...model,
      reasoningEfforts: model.reasoningEfforts.map((effort) => ({ ...effort })),
    }))
    if (sameModels(this.models.get(runtimeId) ?? [], normalized)) return
    this.models.set(runtimeId, normalized)
    this.notify()
    await this.store.write(this.models)
  }

  refresh(
    runtimeId: CliRuntimeId,
    loader: () => Promise<readonly CliRuntimeModel[]>,
  ): Promise<void> {
    const existing = this.refreshes.get(runtimeId)
    if (existing) return existing
    const refresh = this.load()
      .then(loader)
      .then((models) => this.record(runtimeId, models))
      .finally(() => this.refreshes.delete(runtimeId))
    this.refreshes.set(runtimeId, refresh)
    return refresh
  }

  private async loadFromStore(): Promise<void> {
    const persisted = await this.store.read()
    for (const [runtimeId, models] of persisted) {
      this.models.set(runtimeId, models)
    }
    if (persisted.size > 0) this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
