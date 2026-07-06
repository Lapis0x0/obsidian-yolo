import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * v72→v73: split the legacy `agent-full` chat mode into two orthogonal
 * dimensions.
 *
 * Previously `chatMode === 'agent-full'` encoded "Agent mode + auto-approve
 * tool calls (YOLO)". YOLO is now an independent boolean (`agentYoloEnabled`)
 * that only takes effect in Agent mode, so the conflated value is rewritten to
 * `chatMode: 'agent'` + `agentYoloEnabled: true`.
 */
export const migrateFrom72To73: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 73 }
  const chatOptions = isRecord(next.chatOptions) ? { ...next.chatOptions } : {}

  if (chatOptions.chatMode === 'agent-full') {
    chatOptions.chatMode = 'agent'
    chatOptions.agentYoloEnabled = true
  }

  next.chatOptions = chatOptions
  return next
}
