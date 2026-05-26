import {
  BUILTIN_DEFAULT_ENABLED_TOOL_FQNS,
  getDefaultApprovalModeForTool,
  getDefaultDisclosureModeForTool,
} from '../../../core/agent/tool-preferences'
import { getLocalFileToolServerName } from '../../../core/mcp/localFileTools'
import { McpManager } from '../../../core/mcp/mcpManager'
import type { SettingMigration } from '../setting.types'

const LOAD_TOOL_SCHEMAS_FQN = `${getLocalFileToolServerName()}${McpManager.TOOL_NAME_DELIMITER}load_tool_schemas`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * v60→v61: make `toolPreferences` the single source of truth for each
 * assistant's built-in tool state.
 *
 * Prior runtime quietly filled in defaults at read time for built-in tools
 * missing from `toolPreferences`. That caused #356: an agent could show
 * "3 tools" on its card while the detail panel reported "0/55 active",
 * because the panel rendered explicit prefs while the card consulted the
 * filled-in set. The fill-in is gone, so any unmigrated agent would lose
 * tools it previously had. This migration freezes each assistant's
 * effective state into explicit entries:
 *
 *   - For every default-on built-in FQN missing from `toolPreferences`,
 *     write `{ enabled: true, approvalMode, disclosureMode }`. The old
 *     runtime treated missing entries as enabled — explicit-disabled
 *     entries the user had set stay disabled because we only fill *missing*
 *     slots.
 *   - Strip any `yolo_local__load_tool_schemas` entry from both
 *     `toolPreferences` and the legacy `enabledToolNames` array. The loader
 *     is now a protocol-only tool injected by the runtime when on-demand
 *     disclosure is active; it is not user-configurable.
 */
export const migrateFrom60To61: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 61 }

  if (!Array.isArray(next.assistants)) {
    return next
  }

  next.assistants = next.assistants.map((assistant: unknown) => {
    if (!isRecord(assistant)) return assistant

    const existing = isRecord(assistant.toolPreferences)
      ? assistant.toolPreferences
      : {}

    const sanitized: Record<string, unknown> = {}
    for (const [toolName, value] of Object.entries(existing)) {
      if (toolName === LOAD_TOOL_SCHEMAS_FQN) continue
      sanitized[toolName] = value
    }

    for (const fqn of BUILTIN_DEFAULT_ENABLED_TOOL_FQNS) {
      if (Object.prototype.hasOwnProperty.call(sanitized, fqn)) continue
      sanitized[fqn] = {
        enabled: true,
        approvalMode: getDefaultApprovalModeForTool(fqn),
        disclosureMode: getDefaultDisclosureModeForTool(fqn),
      }
    }

    const enabledToolNames = Array.isArray(assistant.enabledToolNames)
      ? assistant.enabledToolNames.filter(
          (name): name is string =>
            typeof name === 'string' && name !== LOAD_TOOL_SCHEMAS_FQN,
        )
      : assistant.enabledToolNames

    return {
      ...assistant,
      enabledToolNames,
      toolPreferences: sanitized,
    }
  })

  return next
}
