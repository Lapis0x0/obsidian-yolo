import type { YoloSettings } from '../../../settings/schema/setting.types'
import type { ChatModel } from '../../../types/chat-model.types'

// Capability id as of the `80_to_81` settings migration (D9,
// docs/plans/2026-08-15-tool-registry/phase2-migration.md D9) — was the
// short tool name `delegate_subagent` before that migration landed.
const SUBAGENT_DELEGATION_CAPABILITY_ID = 'subagent_delegation'

export type ResolvedSubagentModelConfig = {
  allowedModelIds: string[]
  preferredModelId: string
}

export function getRegisteredChatModels(settings: YoloSettings): ChatModel[] {
  return settings.chatModels
}

export function resolveSubagentModelConfig(
  settings: YoloSettings,
): ResolvedSubagentModelConfig {
  const registeredModels = getRegisteredChatModels(settings)
  const registeredIds = new Set(registeredModels.map((model) => model.id))
  const options =
    settings.mcp.builtinCapabilityOptions[SUBAGENT_DELEGATION_CAPABILITY_ID]
  const savedAllowedIds = options?.allowedModelIds
  const allowedModelIds = Array.isArray(savedAllowedIds)
    ? savedAllowedIds.filter((modelId, index, list) => {
        return registeredIds.has(modelId) && list.indexOf(modelId) === index
      })
    : getDefaultAllowedModelIds(settings, registeredModels)

  const fallbackPreferred =
    allowedModelIds.find((modelId) => modelId === settings.chatModelId) ??
    allowedModelIds[0] ??
    ''
  const preferredModelId =
    options?.preferredModelId &&
    allowedModelIds.includes(options.preferredModelId)
      ? options.preferredModelId
      : fallbackPreferred

  return {
    allowedModelIds,
    preferredModelId,
  }
}

export function normalizeSubagentModelOptions(
  settings: YoloSettings,
): YoloSettings {
  const resolved = resolveSubagentModelConfig(settings)
  const current =
    settings.mcp.builtinCapabilityOptions[SUBAGENT_DELEGATION_CAPABILITY_ID]

  if (
    current?.allowedModelIds &&
    arraysEqual(current.allowedModelIds, resolved.allowedModelIds) &&
    current.preferredModelId === resolved.preferredModelId
  ) {
    return settings
  }

  return {
    ...settings,
    mcp: {
      ...settings.mcp,
      builtinCapabilityOptions: {
        ...settings.mcp.builtinCapabilityOptions,
        [SUBAGENT_DELEGATION_CAPABILITY_ID]: {
          ...current,
          allowedModelIds: resolved.allowedModelIds,
          preferredModelId: resolved.preferredModelId,
        },
      },
    },
  }
}

export function formatSubagentModelOption(
  settings: YoloSettings,
  modelId: string,
): string {
  const model = settings.chatModels.find(
    (candidate) => candidate.id === modelId,
  )
  if (!model) return modelId
  const displayName = model.name?.trim() || model.model || model.id
  return `${modelId} (${displayName})`
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

function getDefaultAllowedModelIds(
  settings: YoloSettings,
  registeredModels: ChatModel[],
): string[] {
  const defaultModel = registeredModels.find(
    (model) => model.id === settings.chatModelId,
  )
  if (defaultModel) return [defaultModel.id]
  return registeredModels[0] ? [registeredModels[0].id] : []
}
