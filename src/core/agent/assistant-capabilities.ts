import type { YoloSettings } from '../../settings/schema/setting.types'
import type { Assistant } from '../../types/assistant.types'

/**
 * Per-agent focus sync. Falls back to the legacy global toggle when the
 * assistant has no explicit value (e.g. mid-import before migration).
 */
export const resolveAssistantIncludeCurrentFileContent = (
  assistant: Assistant | null | undefined,
  settings: YoloSettings,
): boolean => {
  if (assistant?.includeCurrentFileContent !== undefined) {
    return assistant.includeCurrentFileContent
  }
  return settings.chatOptions.includeCurrentFileContent
}

/**
 * Per-agent time awareness. Falls back to the legacy global toggle when the
 * assistant has no explicit value.
 */
export const resolveAssistantTimeContextEnabled = (
  assistant: Assistant | null | undefined,
  settings: YoloSettings,
): boolean => {
  if (assistant?.timeContextEnabled !== undefined) {
    return assistant.timeContextEnabled
  }
  return settings.timeContextEnabled
}
