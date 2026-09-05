import {
  BASH_TOOL_NAME,
  LOCAL_FS_EDIT_TOOL_NAMES,
  NATIVE_FS_EDIT_TOOL_NAMES,
  TERMINAL_COMMAND_TOOL_NAME,
  getLocalFileToolServerName,
} from '../mcp/localFileTools'
import { getToolName } from '../mcp/tool-name-utils'
import type { BuiltinChatModeId } from '../tools/types'

/**
 * Which built-in mode's capability contract a run presents to the model.
 * Identical to `BuiltinChatModeId` by construction rather than a parallel
 * union: a module chat mode also resolves onto one of these (see
 * `resolveModuleChatModeRuntime`), so there was never a fourth shape to
 * describe. Kept as a named alias because this is where the question is
 * asked — "what do I tell the model it can do" — not "which mode is
 * selected".
 */
export type ToolCapabilityMode = BuiltinChatModeId

const localServerName = getLocalFileToolServerName()

const ACTION_CAPABILITIES = [
  {
    label: 'file editing',
    toolNames: LOCAL_FS_EDIT_TOOL_NAMES.map((name) =>
      getToolName(localServerName, name),
    ),
  },
  {
    // Retired fs_delete/fs_create_dir/fs_move now live inside the bash tool
    // (rm/mkdir/mv), alongside vault search/read — same capability, one tool.
    label: 'path operations',
    toolNames: [getToolName(localServerName, BASH_TOOL_NAME)],
  },
  {
    label: 'terminal commands',
    toolNames: [getToolName(localServerName, TERMINAL_COMMAND_TOOL_NAME)],
  },
] as const

/**
 * The same three questions asked of Max's toolset. Max exposes neither the
 * vault `fs_*` tools nor the virtual `bash` (master.md Q5), so measuring it
 * against `ACTION_CAPABILITIES` would report file editing and path
 * operations as unavailable in the one mode that does them best. Path
 * operations are not a separate entry here because in Max they *are* the
 * shell — `terminal_command` already stands for them.
 */
const MAX_ACTION_CAPABILITIES = [
  {
    label: 'file editing',
    toolNames: NATIVE_FS_EDIT_TOOL_NAMES.map((name) =>
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
  const capabilities: readonly {
    label: string
    toolNames: readonly string[]
  }[] = mode === 'max' ? MAX_ACTION_CAPABILITIES : ACTION_CAPABILITIES
  // A broad capability is unavailable only when none of its underlying tools
  // are exposed. The regular tool policy still governs narrower partial sets.
  const unavailableCapabilities = capabilities
    .filter(
      (capability) =>
        !capability.toolNames.some((toolName) =>
          availableToolNames.has(toolName),
        ),
    )
    .map((capability) => capability.label)

  if (mode === 'ask') {
    return `<runtime_mode>
You are currently in Ask mode. The following built-in action toolsets are unavailable in this mode: ${formatList(unavailableCapabilities)}. If the user requests them, explain that they must switch to Agent mode and that availability there depends on the selected Agent's enabled tools.
</runtime_mode>`
  }

  if (unavailableCapabilities.length === 0) {
    return undefined
  }

  // Max never gets Ask's "switch modes to unlock this" framing: it is the
  // most capable mode there is, so a missing toolset can only mean the user
  // turned that capability off, and there is nowhere further to send them.
  if (mode === 'max') {
    return `<tool_capabilities>
The following built-in action toolsets are unavailable in the current Max configuration: ${formatList(unavailableCapabilities)}. If the user requests them, explain that the corresponding capability is disabled in settings.
</tool_capabilities>`
  }

  return `<tool_capabilities>
The following built-in action toolsets are unavailable in the current Agent configuration: ${formatList(unavailableCapabilities)}. If the user requests them, explain that the corresponding tools are not enabled for this Agent.
</tool_capabilities>`
}
