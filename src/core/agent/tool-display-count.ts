import type { Assistant } from '../../types/assistant.types'
import type { McpTool } from '../../types/mcp.types'
import {
  LOCAL_FS_EDIT_TOOL_NAMES,
  LOCAL_FS_PATH_OPERATION_TOOL_NAMES,
  LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES,
  getLocalFileToolServerName,
} from '../mcp/localFileTools'
import { parseToolName } from '../mcp/tool-name-utils'

import { WEB_OPS_SPLIT_ACTION_TOOL_NAMES } from './builtinToolUiMeta'
import { getEnabledAssistantToolNames } from './tool-preferences'

const BUILTIN_TOOL_GROUPS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(LOCAL_FS_EDIT_TOOL_NAMES),
  new Set(LOCAL_FS_PATH_OPERATION_TOOL_NAMES),
  new Set(LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES),
  new Set(WEB_OPS_SPLIT_ACTION_TOOL_NAMES),
]

/** Counts enabled tools using the same grouped, currently-visible units as the agent editor. */
export function countEnabledVisibleAssistantTools(
  assistant: Pick<
    Assistant,
    'toolPreferences' | 'enabledToolNames' | 'includeBuiltinTools'
  > | null,
  availableTools: readonly McpTool[],
): number {
  const enabledToolNames = new Set(getEnabledAssistantToolNames(assistant))
  const localServerName = getLocalFileToolServerName()
  const groupedTargets = BUILTIN_TOOL_GROUPS.map(() => [] as string[])
  let count = 0

  for (const tool of availableTools) {
    let serverName = localServerName
    let shortName = tool.name

    try {
      const parsed = parseToolName(tool.name)
      serverName = parsed.serverName
      shortName = parsed.toolName
    } catch {
      // Match the agent editor: malformed names are treated as built-in tools.
    }

    const isBuiltin = serverName === localServerName
    if (isBuiltin && assistant?.includeBuiltinTools === false) {
      continue
    }

    const groupIndex = isBuiltin
      ? BUILTIN_TOOL_GROUPS.findIndex((group) => group.has(shortName))
      : -1
    if (groupIndex >= 0) {
      groupedTargets[groupIndex].push(tool.name)
      continue
    }

    if (enabledToolNames.has(tool.name)) {
      count += 1
    }
  }

  for (const targets of groupedTargets) {
    if (
      targets.length > 0 &&
      targets.every((target) => enabledToolNames.has(target))
    ) {
      count += 1
    }
  }

  return count
}
