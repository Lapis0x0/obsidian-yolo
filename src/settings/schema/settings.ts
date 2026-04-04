import { SETTINGS_SCHEMA_VERSION, SETTING_MIGRATIONS } from './migrations'
import {
  SmartComposerSettings,
  smartComposerSettingsSchema,
} from './setting.types'

export function normalizeSmartComposerSettingsReferences(
  settings: SmartComposerSettings,
): SmartComposerSettings {
  const validProviderIds = new Set(
    settings.providers.map((provider) => provider.id),
  )
  const chatModels = settings.chatModels.filter((model) =>
    validProviderIds.has(model.providerId),
  )
  const embeddingModels = settings.embeddingModels.filter((model) =>
    validProviderIds.has(model.providerId),
  )
  const validChatModelIds = new Set(chatModels.map((model) => model.id))
  const validEmbeddingModelIds = new Set(
    embeddingModels.map((model) => model.id),
  )
  const fallbackChatModelId =
    chatModels.find((model) => model.enable ?? true)?.id ?? ''
  const fallbackEmbeddingModelId = embeddingModels[0]?.id ?? ''
  const normalizeModelReference = (
    modelId: string | undefined,
    validModelIds: Set<string>,
    fallbackModelId: string,
  ): string | undefined => {
    if (!modelId) {
      return modelId
    }

    if (validModelIds.has(modelId)) {
      return modelId
    }

    return fallbackModelId
  }
  const assistants = settings.assistants.map((assistant) => {
    if (!assistant.modelId || validChatModelIds.has(assistant.modelId)) {
      return assistant
    }

    return {
      ...assistant,
      modelId: undefined,
    }
  })
  const validAssistantIds = new Set(assistants.map((assistant) => assistant.id))

  return {
    ...settings,
    chatModels,
    embeddingModels,
    chatModelId:
      normalizeModelReference(
        settings.chatModelId,
        validChatModelIds,
        fallbackChatModelId,
      ) ?? '',
    chatTitleModelId:
      normalizeModelReference(
        settings.chatTitleModelId,
        validChatModelIds,
        fallbackChatModelId,
      ) ?? '',
    embeddingModelId:
      normalizeModelReference(
        settings.embeddingModelId,
        validEmbeddingModelIds,
        fallbackEmbeddingModelId,
      ) ?? '',
    continuationOptions: {
      ...settings.continuationOptions,
      continuationModelId: normalizeModelReference(
        settings.continuationOptions.continuationModelId,
        validChatModelIds,
        fallbackChatModelId,
      ),
      tabCompletionModelId: normalizeModelReference(
        settings.continuationOptions.tabCompletionModelId,
        validChatModelIds,
        fallbackChatModelId,
      ),
    },
    assistants,
    currentAssistantId:
      settings.currentAssistantId &&
      validAssistantIds.has(settings.currentAssistantId)
        ? settings.currentAssistantId
        : undefined,
    quickAskAssistantId:
      settings.quickAskAssistantId &&
      validAssistantIds.has(settings.quickAskAssistantId)
        ? settings.quickAskAssistantId
        : undefined,
  }
}

function migrateSettings(
  data: Record<string, unknown>,
): Record<string, unknown> {
  let currentData = { ...data }
  let currentVersion = (currentData.version as number) ?? 0

  for (const migration of SETTING_MIGRATIONS) {
    if (
      currentVersion >= migration.fromVersion &&
      currentVersion < migration.toVersion &&
      migration.toVersion <= SETTINGS_SCHEMA_VERSION
    ) {
      console.debug(
        `Migrating settings from ${migration.fromVersion} to ${migration.toVersion}`,
      )
      currentData = migration.migrate(currentData)
      currentVersion = migration.toVersion
    }
  }

  return currentData
}

export function parseSmartComposerSettings(
  data: unknown,
): SmartComposerSettings {
  try {
    if (
      !data ||
      (typeof data === 'object' &&
        data !== null &&
        Object.keys(data as Record<string, unknown>).length === 0)
    ) {
      const parsed = smartComposerSettingsSchema.parse({})
      return { ...parsed, version: SETTINGS_SCHEMA_VERSION }
    }

    const migratedData = migrateSettings(data as Record<string, unknown>)
    const parsed = smartComposerSettingsSchema.parse(migratedData)
    const normalized = normalizeSmartComposerSettingsReferences(parsed)
    return { ...normalized, version: SETTINGS_SCHEMA_VERSION }
  } catch (error) {
    console.warn('Invalid settings provided, using defaults:', error)
    const defaults = smartComposerSettingsSchema.parse({})
    return { ...defaults, version: SETTINGS_SCHEMA_VERSION }
  }
}
