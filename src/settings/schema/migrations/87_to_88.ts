import type { SettingMigration } from '../setting.types'

/**
 * v87→v88:
 *
 * - Fold the two update toggles into one update mode (Refs #611).
 *   `pluginUpdateNoticeEnabled` gated the update toast and
 *   `pluginUpdateAutoDownloadEnabled` only chose whether to download ahead of
 *   it. Automatic updating is new and never chosen for the user, so turned-off
 *   notices become `off` and everything else `notify`, which now always
 *   downloads ahead.
 * - Context compaction is now forced by the runtime and keyed only on a share
 *   of the context window, so the threshold mode and absolute token threshold
 *   go away. Users still on the old defaults (off, 80%) never chose them and
 *   move to the new ones (on, 90%); anyone who changed either keeps theirs.
 * - The agent-level `enableTools` / `includeBuiltinTools` master switches go
 *   away; the per-capability and per-tool switches are the only gate. An agent
 *   that had a master switch off keeps the same tool set by having the
 *   switches it covered written off: every built-in capability for either
 *   flag, plus every remote MCP tool for `enableTools`.
 * - The legacy per-agent `enabledSkills` list goes away. Nothing read it any
 *   more: whether a skill is enabled lives in `skillPreferences` alone.
 */
export const migrateFrom87To88: SettingMigration['migrate'] = (data) => {
  const {
    pluginUpdateNoticeEnabled,
    pluginUpdateAutoDownloadEnabled: _autoDownload,
    ...rest
  } = data
  return {
    ...rest,
    version: 88,
    pluginUpdateMode: pluginUpdateNoticeEnabled === false ? 'off' : 'notify',
    ...(isRecord(rest.chatOptions)
      ? { chatOptions: migrateAutoContextCompaction(rest.chatOptions) }
      : {}),
    ...(Array.isArray(rest.assistants)
      ? {
          assistants: rest.assistants.map((assistant) =>
            isRecord(assistant)
              ? migrateAssistantToolMasterSwitches(assistant)
              : assistant,
          ),
        }
      : {}),
  }
}

// Built-in capability ids as of v88. Frozen here rather than read from the
// registry: a capability added later must keep its own default, not inherit
// a switch that no longer exists.
const BUILTIN_CAPABILITY_IDS_V88 = [
  'context_pruning',
  'context_compaction',
  'file_reading',
  'file_editing',
  'js_sandbox',
  'subagent_delegation',
  'todo_list',
  'native_files',
  'vault_search',
  'terminal',
  'user_questions',
  'web_access',
  'vault_shell',
] as const

const disableAll = (
  preferences: unknown,
  ids: readonly string[],
): Record<string, unknown> => {
  const current = isRecord(preferences) ? preferences : {}
  return Object.fromEntries(
    [...new Set([...ids, ...Object.keys(current)])].map((id) => [
      id,
      { ...(isRecord(current[id]) ? current[id] : {}), enabled: false },
    ]),
  )
}

const migrateAssistantToolMasterSwitches = (
  assistant: Record<string, unknown>,
): Record<string, unknown> => {
  const {
    enableTools,
    includeBuiltinTools,
    enabledSkills: _enabledSkills,
    ...rest
  } = assistant
  const toolsOff = enableTools === false
  if (!toolsOff && includeBuiltinTools !== false) {
    return rest
  }
  return {
    ...rest,
    builtinCapabilityPreferences: disableAll(
      rest.builtinCapabilityPreferences,
      BUILTIN_CAPABILITY_IDS_V88,
    ),
    ...(toolsOff
      ? {
          toolPreferences: disableAll(rest.toolPreferences, []),
          enabledToolNames: [],
        }
      : {}),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const migrateAutoContextCompaction = (
  chatOptions: Record<string, unknown>,
): Record<string, unknown> => {
  const {
    autoContextCompactionThresholdMode: _mode,
    autoContextCompactionThresholdTokens: _tokens,
    ...rest
  } = chatOptions
  const onOldDefaults =
    (rest.autoContextCompactionEnabled ?? false) === false &&
    (rest.autoContextCompactionThresholdRatio ?? 0.8) === 0.8
  return onOldDefaults
    ? {
        ...rest,
        autoContextCompactionEnabled: true,
        autoContextCompactionThresholdRatio: 0.9,
      }
    : rest
}
