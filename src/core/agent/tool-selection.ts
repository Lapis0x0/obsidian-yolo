import type { YoloSettings } from '../../settings/schema/setting.types'
import type {
  AssistantToolPreference,
  AssistantToolServerPreference,
} from '../../types/assistant.types'
import type { RequestTool } from '../../types/llm/request'
import type { McpTool } from '../../types/mcp.types'
import type { LLMProviderApiType } from '../../types/provider.types'
import { type JsSandboxSettings } from '../mcp/jsSandboxSettings'
import { JS_SANDBOX_TOOL_NAME, getJsSandboxTool } from '../mcp/jsSandboxTool'
import {
  BASH_TOOL_NAME,
  LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME,
  getLoadToolSchemasTool,
  getLocalFileToolServerName,
} from '../mcp/localFileTools'
import { McpManager } from '../mcp/mcpManager'
import { parseToolName } from '../mcp/tool-name-utils'
import { buildBashToolDescription } from '../tools/bash/definition'
import {
  INVOKE_TOOL_NAME,
  getInvokeTool,
} from '../tools/internal/invoke_tool/definition'

import {
  formatSubagentModelOption,
  resolveSubagentModelConfig,
} from './subagent/model-config'
import {
  type DeferredToolCatalog,
  buildDeferredToolCatalog,
  describeInProcessToolSets,
  describeMcpToolSets,
} from './tool-catalog'
import { getAssistantToolDisclosureMode } from './tool-preferences'

const LOCAL_MEMORY_TOOL_NAMES = new Set([
  'memory_ops',
  'memory_add',
  'memory_update',
  'memory_delete',
])

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
}: {
  toolName: string
  allowedToolNames?: ReadonlySet<string>
}): boolean => {
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
 * Rewrite tools whose schema depends on global settings: `js_eval` (its
 * description and `timeoutMs` bound name the exact `settings.jsSandbox`
 * values in effect, and `$db.search` lists the knowledge bases), `bash`
 * (`search --kb` lists the knowledge bases) and `delegate_subagent` (model
 * options).
 *
 * The tool list from `listAvailableTools` is cached and settings-agnostic —
 * this is the single bridge that rebuilds the live tool spec. Every consumer
 * that surfaces a tool description/schema to the model OR estimates its
 * token cost must route through here, otherwise the shown/estimated surface
 * drifts from what the request actually sends.
 */
export function applyDynamicToolDescriptions(
  tools: McpTool[],
  ctx: {
    jsSandboxSettings: JsSandboxSettings
    settings?: YoloSettings
  },
): McpTool[] {
  const jsSandboxFqn = `${getLocalFileToolServerName()}${McpManager.TOOL_NAME_DELIMITER}${JS_SANDBOX_TOOL_NAME}`
  const bashFqn = `${getLocalFileToolServerName()}${McpManager.TOOL_NAME_DELIMITER}${BASH_TOOL_NAME}`
  const delegateSubagentFqn = `${getLocalFileToolServerName()}${McpManager.TOOL_NAME_DELIMITER}delegate_subagent`
  return tools.map((tool) => {
    if (tool.name === jsSandboxFqn) {
      const live = getJsSandboxTool(
        ctx.jsSandboxSettings,
        ctx.settings?.knowledgeBases,
      )
      return {
        ...tool,
        description: live.description,
        inputSchema: live.inputSchema,
      }
    }

    if (tool.name === bashFqn && ctx.settings) {
      return {
        ...tool,
        description: buildBashToolDescription(ctx.settings.knowledgeBases),
      }
    }

    if (tool.name === delegateSubagentFqn && ctx.settings) {
      return applySubagentModelSchema(tool, ctx.settings)
    }

    return tool
  })
}

function applySubagentModelSchema(
  tool: McpTool,
  settings: YoloSettings,
): McpTool {
  const config = resolveSubagentModelConfig(settings)
  const allowedLines = config.allowedModelIds
    .map((modelId) => `- ${formatSubagentModelOption(settings, modelId)}`)
    .join('\n')
  const preferredLine = config.preferredModelId
    ? formatSubagentModelOption(settings, config.preferredModelId)
    : 'none'
  const modelDescription =
    config.allowedModelIds.length > 0
      ? `Optional modelId for this sub-agent. Allowed modelIds:\n${allowedLines}\nRecommended default: ${preferredLine}. If the user did not explicitly request a model, omit this field and the host will use the recommended default.`
      : 'Optional modelId for this sub-agent. No registered chat models are currently configured for sub-agents.'

  return {
    ...tool,
    description:
      `${tool.description}\n\nSub-agent model policy: allowed modelIds are configured by the user. ` +
      `Recommended default: ${preferredLine}. If the user explicitly asks for a sub-agent model, set modelId to one of the allowed modelIds; otherwise omit modelId.`,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...(tool.inputSchema.properties ?? {}),
        modelId: {
          type: 'string',
          enum: config.allowedModelIds,
          description: modelDescription,
        },
      },
    },
  }
}

export const selectAllowedTools = async ({
  availableTools,
  allowedToolNames,
  toolPreferences,
  toolServerPreferences,
  apiType,
  jsSandboxSettings = {},
  settings,
}: {
  availableTools: McpTool[]
  allowedToolNames?: string[]
  toolPreferences?: Record<string, AssistantToolPreference>
  toolServerPreferences?: Record<string, AssistantToolServerPreference>
  apiType?: LLMProviderApiType | null
  jsSandboxSettings?: JsSandboxSettings
  settings?: YoloSettings
}): Promise<{
  filteredTools: McpTool[]
  hasTools: boolean
  hasMemoryTools: boolean
  hasOnDemandTools: boolean
  requestTools: RequestTool[] | undefined
  /**
   * Model-facing listing of the deferred tools, for the system prompt. `null`
   * when nothing is deferred.
   */
  deferredToolCatalog: DeferredToolCatalog | null
}> => {
  // Post-D9 (docs/plans/2026-08-15-tool-registry/phase2-migration.md D9),
  // `allowedToolNames` is always a fully-expanded list of real tool FQNs —
  // `getEnabledAssistantToolNames` and `resolveModuleCapabilityProfile`
  // (its only producers) both expand capabilities/tiers into member tool
  // names before this is ever called, so no virtual group name can appear
  // here (decision 12: no virtual tool names anywhere in the system).
  const normalizedAllowedToolNames = allowedToolNames
    ? new Set(allowedToolNames)
    : undefined

  const baseFiltered = applyDynamicToolDescriptions(
    availableTools.filter((tool) =>
      isToolAllowed({
        toolName: tool.name,
        allowedToolNames: normalizedAllowedToolNames,
      }),
    ),
    { jsSandboxSettings, settings },
  )
  const assistantLike = {
    toolPreferences,
    toolServerPreferences,
    enabledToolNames: normalizedAllowedToolNames
      ? [...normalizedAllowedToolNames]
      : undefined,
  }
  const isDeferredAndEnabled = (toolName: string): boolean =>
    isToolAllowed({ toolName, allowedToolNames: normalizedAllowedToolNames }) &&
    getAssistantToolDisclosureMode(assistantLike, toolName) === 'on_demand'

  // The catalog is derived from the *tool sets* the user has configured or a
  // module has registered — not from what happens to be connected right now.
  // That distinction is what makes the prefix stable: a server dropping off
  // must not delete its catalog entries, nor take the protocol tools with it.
  const configuredServers = settings?.mcp.servers ?? []
  const toolSets = [
    ...describeMcpToolSets({
      configuredServers,
      discoveredCatalogs: settings?.mcp.discoveredCatalogs ?? {},
    }),
    ...describeInProcessToolSets({
      availableTools,
      configuredServerIds: new Set(configuredServers.map((s) => s.id)),
    }),
  ]
  const deferredToolCatalog = buildDeferredToolCatalog({
    toolSets,
    isDeferredAndEnabled,
  })

  // Derived from the catalog rather than from `availableTools`: an offline
  // server's tools are absent from the live list, and reading `hasOnDemand`
  // off that list would let a disconnect strip the protocol tools out of the
  // frozen `tools` field.
  const hasOnDemand = deferredToolCatalog !== null

  // The two protocol tools are injected only when something actually defers.
  // Without the guard they bloat every request prefix for agents that never
  // need them; with a deferred tool but no protocol tools, the model would
  // have no way to reach the real schema at all (deadlock).
  const protocolTools: McpTool[] = hasOnDemand
    ? [getLoadToolSchemasToolFqn(), getInvokeToolFqn(apiType)]
    : []
  const filteredTools: McpTool[] = [...protocolTools, ...baseFiltered]

  // Deferred tools are not registered at all — they live in the system-prompt
  // catalog as bare names and are reached through `invoke_tool`. The `tools`
  // field therefore holds only the always-tier plus the two protocol tools.
  const requestToolDefinitions: McpTool[] = filteredTools.filter(
    (tool) =>
      protocolTools.some((protocolTool) => protocolTool.name === tool.name) ||
      getAssistantToolDisclosureMode(assistantLike, tool.name) === 'always',
  )

  return {
    filteredTools,
    hasTools: filteredTools.length > 0,
    hasMemoryTools: filteredTools.some((tool) =>
      isMemoryToolAvailable(tool.name),
    ),
    hasOnDemandTools: hasOnDemand,
    requestTools: buildRequestTools(requestToolDefinitions),
    deferredToolCatalog,
  }
}

function getInvokeToolFqn(apiType?: LLMProviderApiType | null): McpTool {
  const tool = getInvokeTool(apiType)
  return {
    ...tool,
    name: `${getLocalFileToolServerName()}${McpManager.TOOL_NAME_DELIMITER}${tool.name}`,
  }
}

export const isInvokeToolName = (toolName: string): boolean => {
  try {
    const parsed = parseToolName(toolName)
    return (
      parsed.serverName === getLocalFileToolServerName() &&
      parsed.toolName === INVOKE_TOOL_NAME
    )
  } catch {
    return toolName === INVOKE_TOOL_NAME
  }
}

function getLoadToolSchemasToolFqn(): McpTool {
  const tool = getLoadToolSchemasTool()
  return {
    ...tool,
    name: `${getLocalFileToolServerName()}${McpManager.TOOL_NAME_DELIMITER}${tool.name}`,
  }
}
