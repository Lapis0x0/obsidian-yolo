import { YoloSettings } from '../../settings/schema/setting.types'
import { Assistant } from '../../types/assistant.types'

import {
  buildAssistantToolPreferencesFromEnabledToolNames,
  buildDefaultBuiltinCapabilityPreferences,
  getAssistantToolPreferences,
} from './tool-preferences'

export const DEFAULT_ASSISTANT_ID = '__default_agent__'

const DEFAULT_ASSISTANT_NAME = 'Default'
const DEFAULT_ASSISTANT_DESCRIPTION = 'Default editing agent for sidebar chat.'
const DEFAULT_ASSISTANT_SYSTEM_PROMPT = ''

export const isDefaultAssistantId = (assistantId?: string | null): boolean =>
  assistantId === DEFAULT_ASSISTANT_ID

export const createDefaultAssistant = (): Assistant => ({
  id: DEFAULT_ASSISTANT_ID,
  name: DEFAULT_ASSISTANT_NAME,
  description: DEFAULT_ASSISTANT_DESCRIPTION,
  systemPrompt: DEFAULT_ASSISTANT_SYSTEM_PROMPT,
  // Omit modelId so new Default agents follow the global chat model.
  persona: 'balanced',
  enableTools: true,
  includeBuiltinTools: true,
  enabledToolNames: [],
  toolPreferences: {},
  builtinCapabilityPreferences: buildDefaultBuiltinCapabilityPreferences(),
  toolServerPreferences: {},
  enabledSkills: [],
  skillPreferences: {},
  includeCurrentFileContent: true,
  timeContextEnabled: true,
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
    JSON.stringify(current.toolPreferences ?? {}) !==
      JSON.stringify(normalized.toolPreferences ?? {}) ||
    JSON.stringify(current.builtinCapabilityPreferences ?? {}) !==
      JSON.stringify(normalized.builtinCapabilityPreferences ?? {}) ||
    JSON.stringify(current.toolServerPreferences ?? {}) !==
      JSON.stringify(normalized.toolServerPreferences ?? {}) ||
    JSON.stringify(current.enabledSkills ?? []) !==
      JSON.stringify(normalized.enabledSkills ?? []) ||
    JSON.stringify(current.skillPreferences ?? {}) !==
      JSON.stringify(normalized.skillPreferences ?? {}) ||
    (current.includeCurrentFileContent ?? true) !==
      normalized.includeCurrentFileContent ||
    (current.timeContextEnabled ?? true) !== normalized.timeContextEnabled
  )
}

const normalizeDefaultAssistant = (assistant: Assistant): Assistant => {
  const createdAt = assistant.createdAt ?? Date.now()
  const toolPreferences = getAssistantToolPreferences(assistant)
  const normalizedBase: Assistant = {
    ...assistant,
    id: DEFAULT_ASSISTANT_ID,
    name: assistant.name?.trim() || DEFAULT_ASSISTANT_NAME,
    description: assistant.description?.trim() || DEFAULT_ASSISTANT_DESCRIPTION,
    systemPrompt:
      typeof assistant.systemPrompt === 'string'
        ? assistant.systemPrompt
        : DEFAULT_ASSISTANT_SYSTEM_PROMPT,
    // Keep empty/undefined modelId as "follow global default"; never rewrite it.
    modelId: assistant.modelId || undefined,
    enableTools: assistant.enableTools ?? true,
    includeBuiltinTools: assistant.includeBuiltinTools ?? true,
    enabledToolNames: assistant.enabledToolNames ?? [],
    toolPreferences:
      Object.keys(toolPreferences).length > 0
        ? toolPreferences
        : buildAssistantToolPreferencesFromEnabledToolNames(
            assistant.enabledToolNames,
          ),
    builtinCapabilityPreferences: assistant.builtinCapabilityPreferences ?? {},
    toolServerPreferences: assistant.toolServerPreferences ?? {},
    enabledSkills: assistant.enabledSkills ?? [],
    skillPreferences: assistant.skillPreferences ?? {},
    includeCurrentFileContent: assistant.includeCurrentFileContent ?? true,
    timeContextEnabled: assistant.timeContextEnabled ?? true,
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
  settings: YoloSettings,
): YoloSettings => {
  const assistants = settings.assistants || []
  const existingDefault = assistants.find((assistant) =>
    isDefaultAssistantId(assistant.id),
  )
  const normalizedDefault = existingDefault
    ? normalizeDefaultAssistant(existingDefault)
    : createDefaultAssistant()

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
