import type { RequestTool } from '../../types/llm/request'
import type { McpTool } from '../../types/mcp.types'
import {
  LOCAL_FS_SPLIT_ACTION_TOOL_NAMES,
  LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES,
  getLocalFileToolServerName,
} from '../mcp/localFileTools'
import { McpManager } from '../mcp/mcpManager'
import { parseToolName } from '../mcp/tool-name-utils'

const LOCAL_MEMORY_TOOL_NAMES = new Set([
  'memory_ops',
  'memory_add',
  'memory_update',
  'memory_delete',
])

const isOpenSkillToolName = (toolName: string): boolean => {
  try {
    const parsed = parseToolName(toolName)
    return (
      parsed.serverName === getLocalFileToolServerName() &&
      parsed.toolName === 'open_skill'
    )
  } catch {
    return toolName === 'open_skill'
  }
}

export const expandAllowedToolNames = (
  toolNames?: string[],
): Set<string> | undefined => {
  if (!toolNames) {
    return undefined
  }

  const expanded = new Set<string>(toolNames)
  const localServer = getLocalFileToolServerName()
  const localFileOpsTool = `${localServer}${McpManager.TOOL_NAME_DELIMITER}fs_file_ops`
  const localMemoryOpsTool = `${localServer}${McpManager.TOOL_NAME_DELIMITER}memory_ops`
  const hasFileOpsGroup =
    expanded.has(localFileOpsTool) || expanded.has('fs_file_ops')
  const hasMemoryOpsGroup =
    expanded.has(localMemoryOpsTool) || expanded.has('memory_ops')

  if (hasFileOpsGroup) {
    for (const splitToolName of LOCAL_FS_SPLIT_ACTION_TOOL_NAMES) {
      expanded.add(
        `${localServer}${McpManager.TOOL_NAME_DELIMITER}${splitToolName}`,
      )
      expanded.add(splitToolName)
    }
  }

  if (hasMemoryOpsGroup) {
    for (const splitToolName of LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES) {
      expanded.add(
        `${localServer}${McpManager.TOOL_NAME_DELIMITER}${splitToolName}`,
      )
      expanded.add(splitToolName)
    }
  }

  return expanded
}

export const isMemoryToolAvailable = (toolName: string): boolean => {
  try {
    const parsed = parseToolName(toolName)
    return (
      parsed.serverName === getLocalFileToolServerName() &&
      LOCAL_MEMORY_TOOL_NAMES.has(parsed.toolName)
    )
  } catch {
    return LOCAL_MEMORY_TOOL_NAMES.has(toolName)
  }
}

const isToolAllowed = ({
  toolName,
  allowedToolNames,
  allowedSkillIds,
  allowedSkillNames,
}: {
  toolName: string
  allowedToolNames?: ReadonlySet<string>
  allowedSkillIds?: ReadonlySet<string>
  allowedSkillNames?: ReadonlySet<string>
}): boolean => {
  if (isOpenSkillToolName(toolName)) {
    const hasAllowedSkills =
      (allowedSkillIds?.size ?? 0) > 0 || (allowedSkillNames?.size ?? 0) > 0
    if (!hasAllowedSkills) {
      return false
    }
  }

  if (!allowedToolNames) {
    return true
  }

  return allowedToolNames.has(toolName)
}

export const buildRequestTools = (
  toolDefinitions: McpTool[],
): RequestTool[] | undefined => {
  if (toolDefinitions.length === 0) {
    return undefined
  }

  return toolDefinitions.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        ...tool.inputSchema,
        properties: tool.inputSchema.properties ?? {},
      },
    },
  }))
}

export const selectAllowedTools = ({
  availableTools,
  allowedToolNames,
  allowedSkillIds,
  allowedSkillNames,
}: {
  availableTools: McpTool[]
  allowedToolNames?: string[]
  allowedSkillIds?: string[]
  allowedSkillNames?: string[]
}): {
  filteredTools: McpTool[]
  hasTools: boolean
  hasMemoryTools: boolean
  requestTools: RequestTool[] | undefined
} => {
  const normalizedAllowedToolNames = expandAllowedToolNames(allowedToolNames)
  const normalizedAllowedSkillIds = allowedSkillIds
    ? new Set(allowedSkillIds.map((id) => id.toLowerCase()))
    : undefined
  const normalizedAllowedSkillNames = allowedSkillNames
    ? new Set(allowedSkillNames.map((name) => name.toLowerCase()))
    : undefined

  const filteredTools = availableTools.filter((tool) =>
    isToolAllowed({
      toolName: tool.name,
      allowedToolNames: normalizedAllowedToolNames,
      allowedSkillIds: normalizedAllowedSkillIds,
      allowedSkillNames: normalizedAllowedSkillNames,
    }),
  )

  return {
    filteredTools,
    hasTools: filteredTools.length > 0,
    hasMemoryTools: filteredTools.some((tool) =>
      isMemoryToolAvailable(tool.name),
    ),
    requestTools: buildRequestTools(filteredTools),
  }
}
