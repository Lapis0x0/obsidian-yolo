import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * v76→v77: enable multiple Tab completion candidates by default and converge
 * MCP disclosure policy from per-tool records to the server-level model shown
 * by the settings UI. For inconsistent legacy values, `on_demand` wins: it is
 * the conservative choice and matches the old effective behavior for every
 * tool that explicitly requested deferred disclosure.
 */
export const migrateFrom76To77: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 77 }
  const continuationOptions = isRecord(next.continuationOptions)
    ? { ...next.continuationOptions }
    : {}
  const tabCompletionOptions = isRecord(
    continuationOptions.tabCompletionOptions,
  )
    ? { ...continuationOptions.tabCompletionOptions }
    : {}

  if (typeof tabCompletionOptions.multipleCandidatesEnabled !== 'boolean') {
    tabCompletionOptions.multipleCandidatesEnabled = true
  }
  continuationOptions.tabCompletionOptions = tabCompletionOptions
  next.continuationOptions = continuationOptions

  if (Array.isArray(next.assistants)) {
    next.assistants = next.assistants.map((assistant: unknown) => {
      if (!isRecord(assistant)) return assistant

      const toolServerPreferences = isRecord(assistant.toolServerPreferences)
        ? Object.fromEntries(
            Object.entries(assistant.toolServerPreferences).map(
              ([serverName, preference]) => [
                serverName,
                isRecord(preference) ? { ...preference } : {},
              ],
            ),
          )
        : {}
      const preexistingDisclosureServers = new Set(
        Object.entries(toolServerPreferences)
          .filter(([, preference]) => {
            if (!isRecord(preference)) return false
            return (
              preference.disclosureMode === 'always' ||
              preference.disclosureMode === 'on_demand'
            )
          })
          .map(([serverName]) => serverName),
      )
      const toolPreferences = isRecord(assistant.toolPreferences)
        ? Object.fromEntries(
            Object.entries(assistant.toolPreferences).map(
              ([toolName, preference]) => {
                if (!isRecord(preference)) return [toolName, preference]
                const { disclosureMode, ...remaining } = preference
                const delimiterIndex = toolName.indexOf('__')
                const serverName =
                  delimiterIndex > 0 ? toolName.slice(0, delimiterIndex) : null
                if (
                  serverName &&
                  serverName !== 'yolo_local' &&
                  !preexistingDisclosureServers.has(serverName) &&
                  (disclosureMode === 'always' ||
                    disclosureMode === 'on_demand')
                ) {
                  const current = toolServerPreferences[serverName]
                  const currentMode = isRecord(current)
                    ? current.disclosureMode
                    : undefined
                  if (currentMode !== 'always' && currentMode !== 'on_demand') {
                    toolServerPreferences[serverName] = {
                      ...(isRecord(current) ? current : {}),
                      disclosureMode,
                    }
                  } else if (
                    currentMode === 'always' &&
                    disclosureMode === 'on_demand'
                  ) {
                    toolServerPreferences[serverName] = {
                      ...current,
                      disclosureMode: 'on_demand',
                    }
                  }
                }
                return [toolName, remaining]
              },
            ),
          )
        : assistant.toolPreferences

      return {
        ...assistant,
        toolPreferences,
        toolServerPreferences,
      }
    })
  }
  return next
}
