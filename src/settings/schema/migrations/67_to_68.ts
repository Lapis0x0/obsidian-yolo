import type { SettingMigration } from '../setting.types'

/**
 * v67→v68: move focus sync and time awareness from global toggles to per-agent
 * fields. Existing assistants inherit the user's current global values so
 * upgrade behavior stays unchanged.
 */
export const migrateFrom67To68: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 68 }

  const chatOptions =
    next.chatOptions && typeof next.chatOptions === 'object'
      ? (next.chatOptions as Record<string, unknown>)
      : {}
  const includeCurrentFileContent =
    chatOptions.includeCurrentFileContent !== undefined
      ? Boolean(chatOptions.includeCurrentFileContent)
      : true
  const timeContextEnabled =
    next.timeContextEnabled !== undefined
      ? Boolean(next.timeContextEnabled)
      : true

  const assistants = Array.isArray(next.assistants) ? next.assistants : []
  next.assistants = assistants.map((assistant) => {
    if (!assistant || typeof assistant !== 'object') {
      return assistant
    }
    const record = assistant as Record<string, unknown>
    return {
      ...record,
      includeCurrentFileContent:
        record.includeCurrentFileContent ?? includeCurrentFileContent,
      timeContextEnabled: record.timeContextEnabled ?? timeContextEnabled,
    }
  })

  return next
}
