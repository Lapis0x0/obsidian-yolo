import type { SettingMigration } from '../setting.types'

const DEFAULT_ASSISTANT_ID = '__default_agent__'

const buildDefaultAssistant = (modelId: string) => ({
  id: DEFAULT_ASSISTANT_ID,
  name: 'Default',
  description: 'Default editing agent for sidebar chat.',
  systemPrompt:
    'You are the default editing assistant. Keep answers clear, practical, and aligned with the user intent.',
  modelId,
  persona: 'balanced',
  enableTools: false,
  includeBuiltinTools: false,
  enabledToolNames: [],
  toolPreferences: {},
  enabledSkills: [],
  skillPreferences: {},
  customParameters: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
})

export const migrateFrom31To32: SettingMigration['migrate'] = (data) => {
  const newData = { ...data }
  newData.version = 32

  const assistantsRaw = Array.isArray(newData.assistants)
    ? [...newData.assistants]
    : []

  const chatModelId =
    typeof newData.chatModelId === 'string' && newData.chatModelId
      ? newData.chatModelId
      : 'openai-gpt-4o-mini'

  const defaultAssistantCandidate = assistantsRaw.find(
    (assistant) =>
      typeof assistant === 'object' &&
      assistant !== null &&
      (assistant as { id?: unknown }).id === DEFAULT_ASSISTANT_ID,
  ) as Record<string, unknown> | undefined

  const defaultAssistant = {
    ...buildDefaultAssistant(chatModelId),
    ...(defaultAssistantCandidate ?? {}),
    id: DEFAULT_ASSISTANT_ID,
    modelId:
      typeof defaultAssistantCandidate?.modelId === 'string' &&
      defaultAssistantCandidate.modelId
        ? defaultAssistantCandidate.modelId
        : chatModelId,
    systemPrompt:
      typeof defaultAssistantCandidate?.systemPrompt === 'string' &&
      defaultAssistantCandidate.systemPrompt.trim().length > 0
        ? defaultAssistantCandidate.systemPrompt
        : buildDefaultAssistant(chatModelId).systemPrompt,
    enableTools: false,
    includeBuiltinTools: false,
    enabledToolNames: [],
    updatedAt: Date.now(),
  }

  const nextAssistants = [
    defaultAssistant,
    ...assistantsRaw.filter(
      (assistant) =>
        !(
          typeof assistant === 'object' &&
          assistant !== null &&
          (assistant as { id?: unknown }).id === DEFAULT_ASSISTANT_ID
        ),
    ),
  ]

  newData.assistants = nextAssistants

  if (
    typeof newData.currentAssistantId !== 'string' ||
    newData.currentAssistantId.length === 0
  ) {
    newData.currentAssistantId = DEFAULT_ASSISTANT_ID
  }

  return newData
}
