import {
  getLocalFileToolServerName,
  getLocalFileTools,
} from '../../../core/mcp/localFileTools'
import { getToolName, parseToolName } from '../../../core/mcp/tool-name-utils'
import type { AssistantToolPreference } from '../../../types/assistant.types'
import type { McpTool } from '../../../types/mcp.types'

function getKnownBuiltinToolNames(): Set<string> {
  return new Set(
    getLocalFileTools().map((tool) =>
      getToolName(getLocalFileToolServerName(), tool.name),
    ),
  )
}

function isKnownOrRemoteToolName(
  toolName: string,
  knownBuiltinToolNames: Set<string>,
): boolean {
  try {
    const { serverName } = parseToolName(toolName)
    if (serverName === getLocalFileToolServerName()) {
      return knownBuiltinToolNames.has(toolName)
    }
    return true
  } catch {
    return knownBuiltinToolNames.has(toolName)
  }
}

export function normalizeToolPreferencesForPersistence(
  toolPreferences: Record<string, AssistantToolPreference> | undefined,
  availableTools: McpTool[],
): Record<string, AssistantToolPreference> {
  const available = new Set(availableTools.map((tool) => tool.name))
  const knownBuiltinToolNames = getKnownBuiltinToolNames()
  const entries = Object.entries(toolPreferences ?? {}).filter(([toolName]) =>
    available.has(toolName) ||
    isKnownOrRemoteToolName(toolName, knownBuiltinToolNames),
  )

  return Object.fromEntries(entries)
}

export function normalizeToolSelectionForPersistence(
  enabledToolNames: string[] | undefined,
  availableTools: McpTool[],
): string[] {
  if (!enabledToolNames || enabledToolNames.length === 0) {
    return []
  }

  const available = new Set(availableTools.map((tool) => tool.name))
  const knownBuiltinToolNames = getKnownBuiltinToolNames()
  return enabledToolNames.filter(
    (toolName) =>
      available.has(toolName) ||
      isKnownOrRemoteToolName(toolName, knownBuiltinToolNames),
  )
}
