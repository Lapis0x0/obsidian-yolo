import type { ModuleLifecycleScope } from './lifecycleScope'
import type { ModuleConfigSnapshot } from './moduleConfig'

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

export type YoloModuleSettingFieldLocalizationV1 = Readonly<{
  name: string
  description?: string
}>

export type YoloModuleSettingsLocalizationV1 = Readonly<{
  title: string
  fields: Readonly<Record<string, YoloModuleSettingFieldLocalizationV1>>
}>

export type YoloModuleSettingsContributionV1 = Readonly<{
  id: string
  icon?: string
  title: string
  fields: readonly YoloModuleSettingFieldV1[]
  localizations?: Readonly<Record<string, YoloModuleSettingsLocalizationV1>>
}>

export type YoloModuleSettingsV1 = Readonly<{
  contribute(contribution: YoloModuleSettingsContributionV1): void
  getModelSnapshot(): YoloModuleModelSnapshotV1
  subscribeModels(listener: () => void): () => void
}>

export type ModuleSettingsContributionSinkV1 = Readonly<{
  add(
    moduleId: string,
    contribution: YoloModuleSettingsContributionV1,
    fields?: ModuleSettingsFieldAdapterV1,
  ): void
  remove(moduleId: string, contributionId: string): void
}>

export type ModuleSettingsFieldSnapshotV1 = Readonly<{
  values: Readonly<Record<string, unknown>>
  models: YoloModuleModelSnapshotV1
}>

export type ModuleSettingsFieldAdapterV1 = Readonly<{
  getSnapshot(): Promise<ModuleSettingsFieldSnapshotV1>
  write(
    key: string,
    value: string | boolean,
  ): Promise<ModuleSettingsFieldSnapshotV1>
  subscribe(listener: () => void): () => void
}>

export type ModuleSettingsConfigAdapterV1 = Readonly<{
  read(): Promise<ModuleConfigSnapshot>
  replace(next: ModuleConfigSnapshot): Promise<ModuleConfigSnapshot>
  subscribe(listener: () => void): () => void
}>

export type RegisteredModuleSettingsContributionV1 = Readonly<{
  moduleId: string
  contribution: YoloModuleSettingsContributionV1
  fields: ModuleSettingsFieldAdapterV1
}>

export class ModuleSettingsContributionRegistry
  implements ModuleSettingsContributionSinkV1
{
  private readonly contributions = new Map<
    string,
    RegisteredModuleSettingsContributionV1
  >()
  private readonly listeners = new Set<() => void>()
  private snapshot: readonly RegisteredModuleSettingsContributionV1[] =
    Object.freeze([])

  add(
    moduleId: string,
    contribution: YoloModuleSettingsContributionV1,
    fields = UNAVAILABLE_MODULE_SETTINGS_FIELD_ADAPTER,
  ): void {
    const icon = contribution.icon
    for (const registered of this.contributions.values()) {
      if (
        registered.moduleId === moduleId &&
        registered.contribution.icon !== undefined &&
        icon !== undefined &&
        registered.contribution.icon !== icon
      ) {
        throw new Error(
          `Module "${moduleId}" settings contributions declare conflicting icons`,
        )
      }
    }
    this.contributions.set(
      contributionKey(moduleId, contribution.id),
      Object.freeze({ moduleId, contribution, fields }),
    )
    this.updateSnapshot()
    this.emit()
  }

  remove(moduleId: string, contributionId: string): void {
    if (!this.contributions.delete(contributionKey(moduleId, contributionId))) {
      return
    }
    this.updateSnapshot()
    this.emit()
  }

  getSnapshot = (): readonly RegisteredModuleSettingsContributionV1[] =>
    this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  clear(): void {
    if (this.contributions.size === 0) return
    this.contributions.clear()
    this.updateSnapshot()
    this.emit()
  }

  private updateSnapshot(): void {
    this.snapshot = Object.freeze(
      [...this.contributions.values()].sort(
        (left, right) =>
          left.moduleId.localeCompare(right.moduleId) ||
          left.contribution.id.localeCompare(right.contribution.id),
      ),
    )
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
  createConfigAdapter?: (moduleId: string) => ModuleSettingsConfigAdapterV1
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
    let configAdapter: ModuleSettingsConfigAdapterV1 | undefined
    let writeQueue = Promise.resolve()
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
          configAdapter ??= this.options.createConfigAdapter?.(moduleId)
          this.options.sink.add(
            moduleId,
            contribution,
            configAdapter
              ? createFieldAdapter({
                  moduleId,
                  contribution,
                  config: configAdapter,
                  getModels: () =>
                    snapshotModels(this.options.getModelSnapshot()),
                  subscribeModels: this.options.subscribeModels,
                  isActive: () => active && activationComplete,
                  trackSubscription: (unsubscribe) => {
                    subscriptions.add(unsubscribe)
                    return () => {
                      subscriptions.delete(unsubscribe)
                      unsubscribe()
                    }
                  },
                  enqueueWrite: (operation) => {
                    const result = writeQueue
                      .catch(() => undefined)
                      .then(operation)
                    writeQueue = result.then(
                      () => undefined,
                      () => undefined,
                    )
                    return result
                  },
                })
              : UNAVAILABLE_MODULE_SETTINGS_FIELD_ADAPTER,
          )
        }
        staged.clear()
      },
    })
  }
}

const UNAVAILABLE_MODULE_SETTINGS_FIELD_ADAPTER: ModuleSettingsFieldAdapterV1 =
  Object.freeze({
    getSnapshot: async () => {
      throw new Error('Module settings config adapter is unavailable')
    },
    write: async () => {
      throw new Error('Module settings config adapter is unavailable')
    },
    subscribe: () => () => undefined,
  })

function createFieldAdapter({
  moduleId,
  contribution,
  config,
  getModels,
  subscribeModels,
  isActive,
  trackSubscription,
  enqueueWrite,
}: {
  moduleId: string
  contribution: YoloModuleSettingsContributionV1
  config: ModuleSettingsConfigAdapterV1
  getModels: () => YoloModuleModelSnapshotV1
  subscribeModels: (listener: () => void) => () => void
  isActive: () => boolean
  trackSubscription: (unsubscribe: () => void) => () => void
  enqueueWrite: <T>(operation: () => Promise<T>) => Promise<T>
}): ModuleSettingsFieldAdapterV1 {
  const fields = new Map(contribution.fields.map((field) => [field.key, field]))
  const assertActive = (): void => {
    if (!isActive())
      throw new Error(`Module "${moduleId}" settings are not active`)
  }
  const read = async (): Promise<ModuleSettingsFieldSnapshotV1> => {
    assertActive()
    return fieldSnapshot(await config.read(), fields, getModels())
  }
  return Object.freeze({
    getSnapshot: read,
    write: (key, value) => {
      assertActive()
      const field = fields.get(key)
      if (!field) throw new Error(`Settings field "${key}" is not declared`)
      if (
        field.type === 'toggle'
          ? typeof value !== 'boolean'
          : typeof value !== 'string'
      ) {
        throw new TypeError(`Settings field "${key}" has an invalid value`)
      }
      return enqueueWrite(async () => {
        assertActive()
        const current = await config.read()
        const data = readConfigData(current)
        const persisted = await config.replace({
          schemaVersion: 1,
          data: { ...data, [key]: value },
        })
        assertActive()
        return fieldSnapshot(persisted, fields, getModels())
      })
    },
    subscribe: (listener) => {
      assertActive()
      if (typeof listener !== 'function') {
        throw new TypeError('Settings field listener must be a function')
      }
      const notify = () => {
        if (isActive()) listener()
      }
      const unsubscribeConfig = config.subscribe(notify)
      let unsubscribeModels: () => void
      try {
        unsubscribeModels = subscribeModels(notify)
      } catch (error) {
        unsubscribeConfig()
        throw error
      }
      let subscribed = true
      const unsubscribe = () => {
        if (!subscribed) return
        subscribed = false
        unsubscribeConfig()
        unsubscribeModels()
      }
      return trackSubscription(unsubscribe)
    },
  })
}

function fieldSnapshot(
  snapshot: ModuleConfigSnapshot,
  fields: ReadonlyMap<string, YoloModuleSettingFieldV1>,
  models: YoloModuleModelSnapshotV1,
): ModuleSettingsFieldSnapshotV1 {
  const data = readConfigData(snapshot)
  const values: Record<string, unknown> = {}
  for (const key of fields.keys()) values[key] = data[key]
  return Object.freeze({ values: Object.freeze(values), models })
}

function readConfigData(
  snapshot: ModuleConfigSnapshot,
): Record<string, unknown> {
  const data = snapshot.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
  return { ...(data as Record<string, unknown>) }
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

export function resolveSettingsContribution(
  contribution: YoloModuleSettingsContributionV1,
  locale: string,
): Readonly<{
  title: string
  fields: readonly YoloModuleSettingFieldV1[]
}> {
  const normalized = locale.toLowerCase()
  const localization =
    contribution.localizations?.[normalized] ??
    contribution.localizations?.[normalized.split('-')[0] ?? ''] ??
    contribution.localizations?.en
  if (!localization) {
    return Object.freeze({
      title: contribution.title,
      fields: contribution.fields,
    })
  }
  return Object.freeze({
    title: localization.title,
    fields: Object.freeze(
      contribution.fields.map((field) => {
        const translated = localization.fields[field.key]
        return Object.freeze({
          ...field,
          name: translated?.name ?? field.name,
          description: translated?.description ?? field.description,
        })
      }),
    ),
  })
}

export function snapshotContribution(
  value: YoloModuleSettingsContributionV1,
): YoloModuleSettingsContributionV1 {
  if (!value || typeof value !== 'object')
    throw new TypeError('Settings contribution must be an object')
  const id = value.id
  const title = value.title
  const icon = value.icon
  const declaredFields = value.fields
  requireText(id, 'Settings contribution id')
  requireText(title, 'Settings contribution title')
  if (icon !== undefined) requireText(icon, 'Settings contribution icon')
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
    if (description !== undefined)
      requireText(description, 'Settings field description')
    return Object.freeze({ key, type, name, description })
  })
  const localizations = snapshotLocalizations(value.localizations, fields)
  return Object.freeze({
    id,
    ...(icon !== undefined ? { icon } : {}),
    title,
    fields: Object.freeze(fields),
    ...(localizations !== undefined ? { localizations } : {}),
  })
}

function snapshotLocalizations(
  value: YoloModuleSettingsContributionV1['localizations'],
  fields: readonly YoloModuleSettingFieldV1[],
): YoloModuleSettingsContributionV1['localizations'] {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Settings localizations must be a locale map')
  }
  const locales = Object.entries(value)
  if (locales.length === 0) throw new Error('Settings localizations are empty')
  const fieldKeys = new Set(fields.map((field) => field.key))
  const localizations: Record<string, YoloModuleSettingsLocalizationV1> = {}
  for (const [locale, localization] of locales) {
    requireText(locale, 'Settings localization locale')
    if (!localization || typeof localization !== 'object') {
      throw new TypeError(`Settings localization "${locale}" must be an object`)
    }
    requireText(localization.title, `Settings localization "${locale}" title`)
    if (
      !localization.fields ||
      typeof localization.fields !== 'object' ||
      Array.isArray(localization.fields)
    ) {
      throw new TypeError(
        `Settings localization "${locale}" fields must be a map`,
      )
    }
    for (const key of Object.keys(localization.fields)) {
      if (!fieldKeys.has(key)) {
        throw new Error(
          `Settings localization "${locale}" contains unknown field "${key}"`,
        )
      }
    }
    const localizedFields: Record<
      string,
      YoloModuleSettingFieldLocalizationV1
    > = {}
    for (const field of fields) {
      const translated = localization.fields[field.key]
      if (!translated || typeof translated !== 'object') {
        throw new Error(
          `Settings localization "${locale}" is missing field "${field.key}"`,
        )
      }
      requireText(
        translated.name,
        `Settings localization "${locale}" field "${field.key}" name`,
      )
      if (field.description !== undefined) {
        requireText(
          translated.description,
          `Settings localization "${locale}" field "${field.key}" description`,
        )
      } else if (translated.description !== undefined) {
        requireText(
          translated.description,
          `Settings localization "${locale}" field "${field.key}" description`,
        )
      }
      localizedFields[field.key] = Object.freeze({
        name: translated.name,
        ...(translated.description !== undefined
          ? { description: translated.description }
          : {}),
      })
    }
    localizations[locale.toLowerCase()] = Object.freeze({
      title: localization.title,
      fields: Object.freeze(localizedFields),
    })
  }
  if (!localizations.en) {
    throw new Error('Settings localizations must include an English fallback')
  }
  return Object.freeze(localizations)
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
