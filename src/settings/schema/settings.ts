import { SETTINGS_SCHEMA_VERSION, SETTING_MIGRATIONS } from './migrations'
import {
  DEFAULT_AGENT_LLM_TOOL_CATEGORIES,
  YoloSettings,
  yoloSettingsSchema,
} from './setting.types'

const MODEL_TASK_SOURCE_TOOL_NAMES = new Set([
  'fs_list',
  'fs_search',
  'fs_read',
  'web_search',
  'web_scrape',
])

export function normalizeYoloSettingsReferences(
  settings: YoloSettings,
): YoloSettings {
  const validProviderIds = new Set(
    settings.providers.map((provider) => provider.id),
  )
  const chatModels = settings.chatModels.filter((model) =>
    validProviderIds.has(model.providerId),
  )
  const seenEmbeddingModelKeys = new Set<string>()
  const embeddingModels = settings.embeddingModels.filter((model) => {
    if (!validProviderIds.has(model.providerId)) {
      return false
    }

    const dedupeKey = `${model.providerId}::${model.model}`
    if (seenEmbeddingModelKeys.has(dedupeKey)) {
      return false
    }

    seenEmbeddingModelKeys.add(dedupeKey)
    return true
  })
  const validChatModelIds = new Set(chatModels.map((model) => model.id))
  const enabledChatModelIds = new Set(
    chatModels.filter((model) => model.enable ?? true).map((model) => model.id),
  )
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
  const categoriesById = new Map<
    string,
    (typeof settings.agentLlmTools.categories)[number]
  >()
  for (const category of settings.agentLlmTools.categories) {
    if (category.id.trim().length > 0 && !categoriesById.has(category.id)) {
      categoriesById.set(category.id, category)
    }
  }
  for (const category of DEFAULT_AGENT_LLM_TOOL_CATEGORIES) {
    if (!categoriesById.has(category.id)) {
      categoriesById.set(category.id, { ...category })
    }
  }
  const agentLlmToolCategories = [...categoriesById.values()]
  const agentLlmToolCategoryIds = new Set(
    agentLlmToolCategories.map((category) => category.id),
  )
  const fallbackAgentLlmToolCategoryId =
    agentLlmToolCategories[0]?.id ?? DEFAULT_AGENT_LLM_TOOL_CATEGORIES[0].id
  const seenAgentLlmModelToolIds = new Set<string>()
  const agentLlmModelTools = settings.agentLlmTools.modelTools.flatMap(
    (modelTool) => {
      // Intentional: a model tool is pruned when its chat model is missing
      // OR merely disabled (covered by settings.test.ts "missing or
      // disabled"). A disabled model must not stay offered as a sub-model
      // task target. Known tradeoff: disabling then re-enabling a model does
      // not restore its pruned model-tool config — it must be re-added.
      if (!enabledChatModelIds.has(modelTool.modelId)) {
        return []
      }
      if (seenAgentLlmModelToolIds.has(modelTool.id)) {
        return []
      }
      seenAgentLlmModelToolIds.add(modelTool.id)
      return [
        {
          ...modelTool,
          categoryId: agentLlmToolCategoryIds.has(modelTool.categoryId)
            ? modelTool.categoryId
            : fallbackAgentLlmToolCategoryId,
        },
      ]
    },
  )
  const validAgentLlmToolModelIds = new Set(
    agentLlmModelTools.map((modelTool) => modelTool.modelId),
  )
  const assistants = settings.assistants.map((assistant) => {
    const modelToolOptions = assistant.modelToolOptions
    const normalizedAllowedModelIds = modelToolOptions?.allowedModelIds?.filter(
      (modelId) => validAgentLlmToolModelIds.has(modelId),
    )
    const normalizedSourceToolNames =
      modelToolOptions?.enabledSourceToolNames?.filter((toolName) =>
        toolName.includes('__')
          ? toolName.trim().length > 0
          : MODEL_TASK_SOURCE_TOOL_NAMES.has(toolName),
      )

    return {
      ...assistant,
      ...(!assistant.modelId || validChatModelIds.has(assistant.modelId)
        ? {}
        : { modelId: undefined }),
      ...(!assistant.modelToolModelId ||
      validAgentLlmToolModelIds.has(assistant.modelToolModelId)
        ? {}
        : { modelToolModelId: undefined }),
      ...(modelToolOptions
        ? {
            modelToolOptions: {
              ...modelToolOptions,
              ...(normalizedAllowedModelIds !== undefined
                ? { allowedModelIds: normalizedAllowedModelIds }
                : {}),
              ...(normalizedSourceToolNames !== undefined
                ? { enabledSourceToolNames: normalizedSourceToolNames }
                : {}),
            },
          }
        : {}),
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
    agentLlmTools: {
      ...settings.agentLlmTools,
      categories: agentLlmToolCategories,
      modelTools: agentLlmModelTools,
    },
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

export function parseYoloSettings(data: unknown): YoloSettings {
  try {
    if (
      !data ||
      (typeof data === 'object' &&
        data !== null &&
        Object.keys(data as Record<string, unknown>).length === 0)
    ) {
      const parsed = yoloSettingsSchema.parse({})
      return { ...parsed, version: SETTINGS_SCHEMA_VERSION }
    }

    const migratedData = migrateSettings(data as Record<string, unknown>)
    const parsed = yoloSettingsSchema.parse(migratedData)
    const normalized = normalizeYoloSettingsReferences(parsed)
    return { ...normalized, version: SETTINGS_SCHEMA_VERSION }
  } catch (error) {
    console.warn('Invalid settings provided, using defaults:', error)
    const defaults = yoloSettingsSchema.parse({})
    return { ...defaults, version: SETTINGS_SCHEMA_VERSION }
  }
}
