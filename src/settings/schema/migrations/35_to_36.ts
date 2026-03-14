import type { SettingMigration } from '../setting.types'

import { getDefaultApprovalModeForTool } from '../../../core/agent/tool-preferences'

export const migrateFrom35To36: SettingMigration['migrate'] = (data) => {
  const newData: Record<string, unknown> = { ...data, version: 36 }

  if (Array.isArray(newData.assistants)) {
    newData.assistants = newData.assistants.map((assistant: unknown) => {
      if (!assistant || typeof assistant !== 'object') {
        return assistant
      }

      const assistantRecord = assistant as Record<string, unknown>
      const enabledToolNames = Array.isArray(assistantRecord.enabledToolNames)
        ? assistantRecord.enabledToolNames.filter(
            (toolName): toolName is string => typeof toolName === 'string',
          )
        : []

      const existingToolPreferences =
        assistantRecord.toolPreferences &&
        typeof assistantRecord.toolPreferences === 'object' &&
        !Array.isArray(assistantRecord.toolPreferences)
          ? (assistantRecord.toolPreferences as Record<string, unknown>)
          : {}

      const nextToolPreferences = { ...existingToolPreferences }
      const toolNamesToReset = new Set<string>([
        ...enabledToolNames,
        ...Object.keys(existingToolPreferences),
      ])

      for (const toolName of toolNamesToReset) {
        const currentPreference =
          nextToolPreferences[toolName] &&
          typeof nextToolPreferences[toolName] === 'object' &&
          !Array.isArray(nextToolPreferences[toolName])
            ? (nextToolPreferences[toolName] as Record<string, unknown>)
            : {}

        nextToolPreferences[toolName] = {
          ...currentPreference,
          enabled:
            typeof currentPreference.enabled === 'boolean'
              ? currentPreference.enabled
              : enabledToolNames.includes(toolName),
          approvalMode: getDefaultApprovalModeForTool(toolName),
        }
      }

      return {
        ...assistantRecord,
        toolPreferences: nextToolPreferences,
      }
    })
  }

  return newData
}
