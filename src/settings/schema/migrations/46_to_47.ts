import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const stripAssistantFields = (
  assistant: Record<string, unknown>,
): Record<string, unknown> => {
  const next = { ...assistant }
  delete next.temperature
  delete next.topP
  delete next.maxOutputTokens
  delete next.customParameters
  delete next.maxContextMessages
  return next
}

export const migrateFrom46To47: SettingMigration['migrate'] = (data) => {
  const assistantsRaw = Array.isArray(data.assistants) ? data.assistants : []
  const nextAssistants = assistantsRaw.map((assistant) =>
    isRecord(assistant) ? stripAssistantFields(assistant) : assistant,
  )

  return {
    ...data,
    assistants: nextAssistants,
    version: 47,
  }
}
