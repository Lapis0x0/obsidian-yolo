import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * v77→v78: persist last CLI chat mode / YOLO preference per CLI runtime.
 */
export const migrateFrom77To78: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 78 }
  const chatOptions = isRecord(next.chatOptions) ? { ...next.chatOptions } : {}

  if (!isRecord(chatOptions.cliChatModeByRuntime)) {
    chatOptions.cliChatModeByRuntime = {}
  }
  if (!isRecord(chatOptions.cliAgentYoloEnabledByRuntime)) {
    chatOptions.cliAgentYoloEnabledByRuntime = {}
  }

  next.chatOptions = chatOptions
  return next
}
