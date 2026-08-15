import { getLocalFileToolServerName } from '../../../core/mcp/localFileTools'
import { getToolName, parseToolName } from '../../../core/mcp/tool-name-utils'
import { listBuiltinTools } from '../../../core/tools/registry'
import type { AssistantToolPreference } from '../../../types/assistant.types'
import type { McpTool } from '../../../types/mcp.types'

/**
 * Derived from the built-in tool registry rather than from
 * `getLocalFileTools()`: "is this a tool we recognize?" is a question about
 * the registry, not about what happens to be runnable right now. Reading it
 * off the model-facing catalog meant a capability whose tools were
 * temporarily unavailable (today only `bash`, when the `bash-engine` runtime
 * component is disabled) had its saved per-assistant preference silently
 * pruned on the next save — i.e. runtime availability rewriting user config,
 * which master.md decision 18 forbids.
 */
function getKnownBuiltinToolNames(): Set<string> {
  return new Set(
    listBuiltinTools().map((tool) =>
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
  const entries = Object.entries(toolPreferences ?? {}).filter(
    ([toolName]) =>
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
