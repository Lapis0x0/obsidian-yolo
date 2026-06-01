import type { AssistantToolPreference } from '../../types/assistant.types'
import type { RequestTool } from '../../types/llm/request'
import type { McpTool } from '../../types/mcp.types'
import type { LLMProviderApiType } from '../../types/provider.types'
import { type JsSandboxSettings } from '../mcp/jsSandboxSettings'
import { JS_SANDBOX_TOOL_NAME, getJsSandboxTool } from '../mcp/jsSandboxTool'
import {
  LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME,
  LOCAL_FS_SPLIT_ACTION_TOOL_NAMES,
  LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES,
  getLoadToolSchemasTool,
  getLocalFileToolServerName,
} from '../mcp/localFileTools'
import { McpManager } from '../mcp/mcpManager'
import { parseToolName } from '../mcp/tool-name-utils'

import { getAssistantToolDisclosureMode } from './tool-preferences'
import { buildToolStub } from './tool-stub'

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

export const isLoadToolSchemasToolName = (toolName: string): boolean => {
  try {
    const parsed = parseToolName(toolName)
    return (
      parsed.serverName === getLocalFileToolServerName() &&
      parsed.toolName === LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME
    )
  } catch {
    return toolName === LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME
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
  allowedSkillNames,
}: {
  toolName: string
  allowedToolNames?: ReadonlySet<string>
  allowedSkillNames?: ReadonlySet<string>
}): boolean => {
  if (isOpenSkillToolName(toolName)) {
    const hasAllowedSkills = (allowedSkillNames?.size ?? 0) > 0
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

/**
 * Rewrite tools whose schema depends on global settings. Currently only
 * `js_eval`, whose description and `timeoutMs` input bound both name the
 * exact `settings.jsSandbox` values in effect (network / vault read / $db /
 * external scripts + per-call timeout cap).
 *
 * The tool list from `listAvailableTools` is cached and settings-agnostic —
 * this is the single bridge that rebuilds the live tool spec. Every consumer
 * that surfaces a tool description/schema to the model OR estimates its
 * token cost must route through here, otherwise the shown/estimated surface
 * drifts from what the request actually sends.
 */
export function applyDynamicToolDescriptions(
  tools: McpTool[],
  ctx: { jsSandboxSettings: JsSandboxSettings },
): McpTool[] {
  const jsSandboxFqn = `${getLocalFileToolServerName()}${McpManager.TOOL_NAME_DELIMITER}${JS_SANDBOX_TOOL_NAME}`
  return tools.map((tool) => {
    if (tool.name !== jsSandboxFqn) return tool
    const live = getJsSandboxTool(ctx.jsSandboxSettings)
    return {
      ...tool,
      description: live.description,
      inputSchema: live.inputSchema,
    }
  })
}

export const selectAllowedTools = ({
  availableTools,
  allowedToolNames,
  allowedSkillNames,
  toolPreferences,
  apiType,
  enableToolDisclosure = true,
  jsSandboxSettings = {},
}: {
  availableTools: McpTool[]
  allowedToolNames?: string[]
  allowedSkillNames?: string[]
  toolPreferences?: Record<string, AssistantToolPreference>
  apiType?: LLMProviderApiType | null
  enableToolDisclosure?: boolean
  jsSandboxSettings?: JsSandboxSettings
}): {
  filteredTools: McpTool[]
  hasTools: boolean
  hasMemoryTools: boolean
  requestTools: RequestTool[] | undefined
} => {
  const normalizedAllowedToolNames = expandAllowedToolNames(allowedToolNames)
  // Canonical skill names: trim only, case-sensitive (A1).
  const normalizedAllowedSkillNames = allowedSkillNames
    ? new Set(allowedSkillNames.map((name) => name.trim()))
    : undefined

  const baseFiltered = applyDynamicToolDescriptions(
    availableTools.filter((tool) =>
      isToolAllowed({
        toolName: tool.name,
        allowedToolNames: normalizedAllowedToolNames,
        allowedSkillNames: normalizedAllowedSkillNames,
      }),
    ),
    { jsSandboxSettings },
  )
  const assistantLike = {
    toolPreferences,
    enabledToolNames: normalizedAllowedToolNames
      ? [...normalizedAllowedToolNames]
      : undefined,
  }

  // Per-tool disclosure decisions for the filtered (non-loader) tools.
  // Computed up front so the loader injection can ask "does any surviving
  // tool actually need on-demand disclosure?" before adding itself.
  const disclosureModes = new Map<string, 'always' | 'on_demand'>()
  for (const tool of baseFiltered) {
    disclosureModes.set(
      tool.name,
      getAssistantToolDisclosureMode(assistantLike, tool.name, {
        enableToolDisclosure,
      }),
    )
  }

  // Inject the protocol-level loader tool only when the on-demand disclosure
  // mechanism is globally enabled AND at least one surviving tool would be
  // sent as a stub. Without this guard the loader bloats every request prefix
  // even for agents that don't need it; with a stub present but no loader,
  // the model would have no way to reach the real schema (deadlock).
  const loaderFqn = `${getLocalFileToolServerName()}${McpManager.TOOL_NAME_DELIMITER}${LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME}`
  const hasOnDemand = [...disclosureModes.values()].some(
    (mode) => mode === 'on_demand',
  )
  const shouldInjectLoader = enableToolDisclosure && hasOnDemand
  const filteredTools: McpTool[] = shouldInjectLoader
    ? [getLoadToolSchemasToolFqn(), ...baseFiltered]
    : baseFiltered

  // All allowed tools — including on-demand stubs — are registered in the
  // request's `tools` field for the entire conversation so the prompt-cache
  // prefix stays frozen. On-demand tools start as stubs (name + short
  // description + permissive schema) and stay stubs even after their full
  // schema has been disclosed via load_tool_schemas: schemas now ride the messages
  // stream (tool_result + compaction registry) instead of the tools field.
  const requestToolDefinitions: McpTool[] = filteredTools.map((tool) => {
    if (tool.name === loaderFqn) {
      return tool
    }
    const disclosureMode = disclosureModes.get(tool.name) ?? 'always'
    if (disclosureMode === 'on_demand') {
      return buildToolStub(tool, apiType)
    }
    return tool
  })

  return {
    filteredTools,
    hasTools: filteredTools.length > 0,
    hasMemoryTools: filteredTools.some((tool) =>
      isMemoryToolAvailable(tool.name),
    ),
    requestTools: buildRequestTools(requestToolDefinitions),
  }
}

function getLoadToolSchemasToolFqn(): McpTool {
  const tool = getLoadToolSchemasTool()
  return {
    ...tool,
    name: `${getLocalFileToolServerName()}${McpManager.TOOL_NAME_DELIMITER}${tool.name}`,
  }
}
