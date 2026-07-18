import type { ModuleLifecycleScope } from './lifecycleScope'

export type YoloModuleModelOptionV1 = Readonly<{
  id: string
  name: string
  providerId: string
}>

export type YoloModuleModelSnapshotV1 = Readonly<{
  defaultModelId: string
  models: readonly YoloModuleModelOptionV1[]
}>

export type YoloModuleSettingFieldV1 = Readonly<{
  key: string
  type: 'toggle' | 'text' | 'model'
  name: string
  description?: string
}>

export type YoloModuleSettingsContributionV1 = Readonly<{
  id: string
  title: string
  fields: readonly YoloModuleSettingFieldV1[]
}>

export type YoloModuleSettingsV1 = Readonly<{
  contribute(contribution: YoloModuleSettingsContributionV1): void
  getModelSnapshot(): YoloModuleModelSnapshotV1
  subscribeModels(listener: () => void): () => void
}>

export type ModuleSettingsContributionSinkV1 = Readonly<{
  add(moduleId: string, contribution: YoloModuleSettingsContributionV1): void
  remove(moduleId: string, contributionId: string): void
}>

export type RegisteredModuleSettingsContributionV1 = Readonly<{
  moduleId: string
  contribution: YoloModuleSettingsContributionV1
}>

export class ModuleSettingsContributionRegistry
  implements ModuleSettingsContributionSinkV1
{
  private readonly contributions = new Map<
    string,
    RegisteredModuleSettingsContributionV1
  >()
  private readonly listeners = new Set<() => void>()

  add(moduleId: string, contribution: YoloModuleSettingsContributionV1): void {
    this.contributions.set(
      contributionKey(moduleId, contribution.id),
      Object.freeze({ moduleId, contribution }),
    )
    this.emit()
  }

  remove(moduleId: string, contributionId: string): void {
    if (!this.contributions.delete(contributionKey(moduleId, contributionId))) {
      return
    }
    this.emit()
  }

  getSnapshot(): readonly RegisteredModuleSettingsContributionV1[] {
    return Object.freeze(
      [...this.contributions.values()].sort(
        (left, right) =>
          left.moduleId.localeCompare(right.moduleId) ||
          left.contribution.id.localeCompare(right.contribution.id),
      ),
    )
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  clear(): void {
    if (this.contributions.size === 0) return
    this.contributions.clear()
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

export type ModuleSettingsCapabilityProviderV1 = Readonly<{
  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): Readonly<{
    api: YoloModuleSettingsV1
    commit(): void
    activate(): void
  }>
}>

export type ModuleSettingsCapabilityProviderOptions = Readonly<{
  sink: ModuleSettingsContributionSinkV1
  getModelSnapshot(): YoloModuleModelSnapshotV1
  subscribeModels(listener: () => void): () => void
}>

export class ModuleSettingsCapabilityProvider
  implements ModuleSettingsCapabilityProviderV1
{
  constructor(
    private readonly options: ModuleSettingsCapabilityProviderOptions,
  ) {}

  create(moduleId: string, lifecycle: ModuleLifecycleScope) {
    const staged = new Map<string, YoloModuleSettingsContributionV1>()
    const published = new Set<string>()
    const subscriptions = new Set<() => void>()
    let active = true
    let activationComplete = false
    let committed = false
    const assertActive = (): void => {
      if (!active)
        throw new Error(`Module "${moduleId}" settings are not active`)
    }
    lifecycle.add(() => {
      active = false
      activationComplete = false
      for (const unsubscribe of subscriptions) unsubscribe()
      subscriptions.clear()
      for (const id of published) this.options.sink.remove(moduleId, id)
      published.clear()
      staged.clear()
    })
    const api: YoloModuleSettingsV1 = Object.freeze({
      contribute: (value) => {
        assertActive()
        if (committed)
          throw new Error('Module settings contributions are already committed')
        const contribution = snapshotContribution(value)
        if (staged.has(contribution.id)) {
          throw new Error(
            `Duplicate module settings contribution "${contribution.id}"`,
          )
        }
        staged.set(contribution.id, contribution)
      },
      getModelSnapshot: () => {
        assertActive()
        if (!activationComplete)
          throw new Error(`Module "${moduleId}" settings are not active`)
        return snapshotModels(this.options.getModelSnapshot())
      },
      subscribeModels: (listener) => {
        assertActive()
        if (!activationComplete)
          throw new Error(`Module "${moduleId}" settings are not active`)
        if (typeof listener !== 'function')
          throw new TypeError('Model listener must be a function')
        let subscribed = true
        const unsubscribeHost = this.options.subscribeModels(() => {
          if (active && activationComplete && subscribed) listener()
        })
        const unsubscribe = () => {
          if (!subscribed) return
          subscribed = false
          subscriptions.delete(unsubscribe)
          unsubscribeHost()
        }
        subscriptions.add(unsubscribe)
        return unsubscribe
      },
    })
    return Object.freeze({
      api,
      activate: () => {
        assertActive()
        activationComplete = true
      },
      commit: () => {
        assertActive()
        committed = true
        for (const contribution of staged.values()) {
          published.add(contribution.id)
          this.options.sink.add(moduleId, contribution)
        }
        staged.clear()
      },
    })
  }
}

export const UNAVAILABLE_MODULE_SETTINGS_CAPABILITY_PROVIDER: ModuleSettingsCapabilityProviderV1 =
  Object.freeze({
    create: () => ({
      api: Object.freeze({
        contribute: () => {
          throw new Error('Module settings capability is unavailable')
        },
        getModelSnapshot: () => {
          throw new Error('Module settings capability is unavailable')
        },
        subscribeModels: () => {
          throw new Error('Module settings capability is unavailable')
        },
      }),
      activate: () => undefined,
      commit: () => undefined,
    }),
  })

function snapshotContribution(
  value: YoloModuleSettingsContributionV1,
): YoloModuleSettingsContributionV1 {
  if (!value || typeof value !== 'object')
    throw new TypeError('Settings contribution must be an object')
  const id = value.id
  const title = value.title
  const declaredFields = value.fields
  requireText(id, 'Settings contribution id')
  requireText(title, 'Settings contribution title')
  if (!Array.isArray(declaredFields))
    throw new TypeError('Settings contribution fields must be an array')
  const keys = new Set<string>()
  const fields = declaredFields.map((field) => {
    if (!field || typeof field !== 'object')
      throw new TypeError('Settings field must be an object')
    const key = field.key
    const name = field.name
    const type = field.type
    const description = field.description
    requireText(key, 'Settings field key')
    requireText(name, 'Settings field name')
    if (keys.has(key)) throw new Error(`Duplicate settings field "${key}"`)
    keys.add(key)
    if (type !== 'toggle' && type !== 'text' && type !== 'model') {
      throw new Error('Settings field type is invalid')
    }
    if (description !== undefined && typeof description !== 'string') {
      throw new TypeError('Settings field description must be a string')
    }
    return Object.freeze({ key, type, name, description })
  })
  return Object.freeze({
    id,
    title,
    fields: Object.freeze(fields),
  })
}

function snapshotModels(
  value: YoloModuleModelSnapshotV1,
): YoloModuleModelSnapshotV1 {
  if (!value || typeof value !== 'object' || !Array.isArray(value.models)) {
    throw new TypeError('Model snapshot is invalid')
  }
  if (typeof value.defaultModelId !== 'string')
    throw new TypeError('Default model id must be a string')
  const models = value.models.map((model) => {
    const id = model.id
    const name = model.name
    const providerId = model.providerId
    requireText(id, 'Model id')
    requireText(name, 'Model name')
    requireText(providerId, 'Model provider id')
    return Object.freeze({ id, name, providerId })
  })
  return Object.freeze({
    defaultModelId: value.defaultModelId,
    models: Object.freeze(models),
  })
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError(`${label} must be a non-empty string`)
}

function contributionKey(moduleId: string, contributionId: string): string {
  requireText(moduleId, 'Module id')
  requireText(contributionId, 'Settings contribution id')
  return JSON.stringify([moduleId, contributionId])
}
