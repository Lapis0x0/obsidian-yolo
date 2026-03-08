import { SmartComposerSettings } from '../../settings/schema/setting.types'
import { Assistant } from '../../types/assistant.types'

export const DEFAULT_ASSISTANT_ID = '__default_agent__'

const DEFAULT_ASSISTANT_NAME = 'Default'
const DEFAULT_ASSISTANT_DESCRIPTION = 'Default editing agent for sidebar chat.'
const DEFAULT_ASSISTANT_SYSTEM_PROMPT = ''

export const isDefaultAssistantId = (assistantId?: string | null): boolean =>
  assistantId === DEFAULT_ASSISTANT_ID

export const createDefaultAssistant = (fallbackModelId: string): Assistant => ({
  id: DEFAULT_ASSISTANT_ID,
  name: DEFAULT_ASSISTANT_NAME,
  description: DEFAULT_ASSISTANT_DESCRIPTION,
  systemPrompt: DEFAULT_ASSISTANT_SYSTEM_PROMPT,
  modelId: fallbackModelId,
  persona: 'balanced',
  enableTools: true,
  includeBuiltinTools: true,
  enabledToolNames: [],
  enabledSkills: [],
  skillPreferences: {},
  customParameters: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
})

const hasDefaultAssistantChanged = (
  current: Assistant,
  normalized: Assistant,
): boolean => {
  return (
    current.id !== normalized.id ||
    current.name !== normalized.name ||
    current.description !== normalized.description ||
    current.systemPrompt !== normalized.systemPrompt ||
    current.modelId !== normalized.modelId ||
    current.persona !== normalized.persona ||
    current.enableTools !== normalized.enableTools ||
    current.includeBuiltinTools !== normalized.includeBuiltinTools ||
    JSON.stringify(current.enabledToolNames ?? []) !==
      JSON.stringify(normalized.enabledToolNames ?? []) ||
    JSON.stringify(current.enabledSkills ?? []) !==
      JSON.stringify(normalized.enabledSkills ?? []) ||
    JSON.stringify(current.skillPreferences ?? {}) !==
      JSON.stringify(normalized.skillPreferences ?? {}) ||
    JSON.stringify(current.customParameters ?? []) !==
      JSON.stringify(normalized.customParameters ?? [])
  )
}

const normalizeDefaultAssistant = (
  assistant: Assistant,
  fallbackModelId: string,
): Assistant => {
  const createdAt = assistant.createdAt ?? Date.now()
  const normalizedBase: Assistant = {
    ...assistant,
    id: DEFAULT_ASSISTANT_ID,
    name: assistant.name?.trim() || DEFAULT_ASSISTANT_NAME,
    description: assistant.description?.trim() || DEFAULT_ASSISTANT_DESCRIPTION,
    systemPrompt:
      typeof assistant.systemPrompt === 'string'
        ? assistant.systemPrompt
        : DEFAULT_ASSISTANT_SYSTEM_PROMPT,
    modelId: assistant.modelId || fallbackModelId,
    enableTools: assistant.enableTools ?? true,
    includeBuiltinTools: assistant.includeBuiltinTools ?? true,
    enabledToolNames: assistant.enabledToolNames ?? [],
    enabledSkills: assistant.enabledSkills ?? [],
    skillPreferences: assistant.skillPreferences ?? {},
    customParameters: assistant.customParameters ?? [],
    createdAt,
    updatedAt: assistant.updatedAt ?? createdAt,
  }

  if (!hasDefaultAssistantChanged(assistant, normalizedBase)) {
    return normalizedBase
  }

  return {
    ...normalizedBase,
    updatedAt: Date.now(),
  }
}

export const ensureDefaultAssistantInSettings = (
  settings: SmartComposerSettings,
): SmartComposerSettings => {
  const assistants = settings.assistants || []
  const fallbackModelId = settings.chatModelId
  const existingDefault = assistants.find((assistant) =>
    isDefaultAssistantId(assistant.id),
  )
  const normalizedDefault = existingDefault
    ? normalizeDefaultAssistant(existingDefault, fallbackModelId)
    : createDefaultAssistant(fallbackModelId)

  const nextAssistants: Assistant[] = [
    normalizedDefault,
    ...assistants.filter((assistant) => !isDefaultAssistantId(assistant.id)),
  ]

  return {
    ...settings,
    assistants: nextAssistants,
    currentAssistantId:
      settings.currentAssistantId &&
      nextAssistants.some(
        (assistant) => assistant.id === settings.currentAssistantId,
      )
        ? settings.currentAssistantId
        : DEFAULT_ASSISTANT_ID,
  }
}
