import {
  LOCAL_FS_EDIT_TOOL_NAMES,
  LOCAL_FS_PATH_OPERATION_TOOL_NAMES,
  TERMINAL_COMMAND_TOOL_NAME,
  getLocalFileToolServerName,
} from '../mcp/localFileTools'
import { getToolName } from '../mcp/tool-name-utils'

export type ToolCapabilityMode = 'ask' | 'agent'

const localServerName = getLocalFileToolServerName()

const ACTION_CAPABILITIES = [
  {
    label: 'file editing',
    toolNames: LOCAL_FS_EDIT_TOOL_NAMES.map((name) =>
      getToolName(localServerName, name),
    ),
  },
  {
    label: 'path operations',
    toolNames: LOCAL_FS_PATH_OPERATION_TOOL_NAMES.map((name) =>
      getToolName(localServerName, name),
    ),
  },
  {
    label: 'terminal commands',
    toolNames: [getToolName(localServerName, TERMINAL_COMMAND_TOOL_NAME)],
  },
] as const

const formatList = (items: string[]): string => {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`
}

export const buildToolCapabilityPrompt = ({
  mode,
  toolNames,
}: {
  mode: ToolCapabilityMode
  toolNames: readonly string[]
}): string | undefined => {
  const availableToolNames = new Set(toolNames)
  // A broad capability is unavailable only when none of its underlying tools
  // are exposed. The regular tool policy still governs narrower partial sets.
  const unavailableCapabilities = ACTION_CAPABILITIES.filter(
    (capability) =>
      !capability.toolNames.some((toolName) =>
        availableToolNames.has(toolName),
      ),
  ).map((capability) => capability.label)

  if (mode === 'ask') {
    return `<runtime_mode>
You are currently in Ask mode. The following built-in action toolsets are unavailable in this mode: ${formatList(unavailableCapabilities)}. If the user requests them, explain that they must switch to Agent mode and that availability there depends on the selected Agent's enabled tools.
</runtime_mode>`
  }

  if (unavailableCapabilities.length === 0) {
    return undefined
  }

  return `<tool_capabilities>
The following built-in action toolsets are unavailable in the current Agent configuration: ${formatList(unavailableCapabilities)}. If the user requests them, explain that the corresponding tools are not enabled for this Agent.
</tool_capabilities>`
}
