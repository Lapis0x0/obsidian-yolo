/**
 * UI-only sentinel for "follow the global default chat model".
 * Persistence uses an empty/undefined assistant.modelId for the same meaning.
 */
export const ASSISTANT_FOLLOW_DEFAULT_MODEL_OPTION_VALUE =
  '__follow_default_model__'

export const followsDefaultChatModel = (
  modelId?: string | null,
): modelId is null | undefined | '' => !modelId

export const resolveAssistantModelId = (
  assistantModelId: string | undefined | null,
  chatModelId: string,
): string => assistantModelId || chatModelId

export const getAssistantModelSelectValue = (
  modelId?: string | null,
): string =>
  followsDefaultChatModel(modelId)
    ? ASSISTANT_FOLLOW_DEFAULT_MODEL_OPTION_VALUE
    : modelId

export const modelIdFromAssistantModelSelectValue = (
  value: string,
): string | undefined =>
  value === ASSISTANT_FOLLOW_DEFAULT_MODEL_OPTION_VALUE ? undefined : value

export const getAssistantModelDisplayLabel = (
  modelId: string | undefined | null,
  followDefaultLabel: string,
): string => (followsDefaultChatModel(modelId) ? followDefaultLabel : modelId)
