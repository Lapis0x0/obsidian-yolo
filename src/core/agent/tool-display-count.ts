import type { Assistant } from '../../types/assistant.types'
import type { McpTool } from '../../types/mcp.types'
import {
  LOCAL_FS_EDIT_TOOL_NAMES,
  LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES,
  getLocalFileToolServerName,
} from '../mcp/localFileTools'
import { parseToolName } from '../mcp/tool-name-utils'
import { getCapability } from '../tools/registry'

import { getEnabledAssistantToolNames } from './tool-preferences'

// `web_access`'s member tool short names, derived from the registry rather
// than hand-listed — matches the other two groups below, which come from
// `localFileTools.ts`'s own multi-tool-capability constants. Previously
// imported from `core/tools/legacy-persistence-keys.ts`
// (`WEB_OPS_SPLIT_ACTION_TOOL_NAMES`), deleted as part of the D9 settings
// migration (docs/plans/2026-08-15-tool-registry/phase2-migration.md D9).
const WEB_ACCESS_TOOL_NAMES: readonly string[] =
  getCapability('web_access')?.tools.map((tool) => tool.name) ?? []

const BUILTIN_TOOL_GROUPS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(LOCAL_FS_EDIT_TOOL_NAMES),
  new Set(LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES),
  new Set(WEB_ACCESS_TOOL_NAMES),
]

/** Counts enabled tools using the same grouped, currently-visible units as the agent editor. */
export function countEnabledVisibleAssistantTools(
  assistant: Pick<
    Assistant,
    | 'toolPreferences'
    | 'enabledToolNames'
    | 'includeBuiltinTools'
    | 'builtinCapabilityPreferences'
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
