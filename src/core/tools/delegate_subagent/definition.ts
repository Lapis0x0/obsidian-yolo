import type { McpTool } from '../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { resolveSubagentModelConfig } from '../../agent/subagent/model-config'
import { defineTool } from '../define'
import { getOptionalTextArg, getTextArg } from '../tool-args'

// Schema copied verbatim from the `delegate_subagent` entry in
// `getLocalFileTools()` (`src/core/mcp/localFileTools.ts:1102`). Deliberately
// does NOT include `modelId` — that field is injected dynamically by
// `applyDynamicToolDescriptions()` (`src/core/agent/tool-selection.ts:165`),
// which still operates on `getLocalFileTools()`'s output and is untouched
// this phase (D6). Adding `modelId` here ahead of that migration would be a
// silent schema fork between the live path and this inert one.
const DELEGATE_SUBAGENT_MCP_TOOL: Omit<McpTool, 'name'> = {
  description:
    'Dispatch an isolated temporary sub-agent to work on a self-contained task asynchronously. ' +
    'The sub-agent does not see the parent conversation; the prompt must include all necessary context. ' +
    'Returns immediately with a taskId while the child runs in the background. ' +
    'When complete, a follow-up background message starting with ' +
    '[subagent_result taskId=...] will arrive for you to summarize or continue. ' +
    'The child inherits your current model and allowed tools (except recursive delegation and user-interaction tools). ' +
    'The tool result is returned to you, but it does not automatically become a user-facing answer; to show the user the result, send a concise text summary of the relevant output.',
  inputSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description:
          'Short title for this dispatch (shown in the UI and tool summary).',
      },
      prompt: {
        type: 'string',
        description: 'Complete task instructions for the temporary sub-agent.',
      },
    },
    required: ['description', 'prompt'],
  },
}

export const delegateSubagentDefinition = defineTool({
  name: 'delegate_subagent',
  getMcpTool: () => DELEGATE_SUBAGENT_MCP_TOOL,
  chatLabel: {
    key: 'settings.agent.builtinDelegateSubagentLabel',
    fallback: 'Delegate Subagent',
  },
  contextPrunable: true,
  // Ported verbatim from the `case 'delegate_subagent'` branch of
  // `callLocalFileTool` (`src/core/mcp/localFileTools.ts:3818`), minus the
  // abort check / workspace-scope / YOLO-data-root guards and the outer
  // try/catch that normalizes thrown errors to an Error-status result —
  // those are dispatcher responsibilities (master.md §3.4), not tool
  // semantics. A thrown Error here is expected to propagate to
  // `executeBuiltinTool`, which converts it the same way the old outer
  // catch did.
  //
  // Approval note (D3 question 2): this tool's OWN pending-approval flow is
  // the ordinary one (`AgentService.approveToolCall` -> the gateway ->
  // this `execute`), same as every other tool. `approveSubagentToolCall`
  // (`src/core/agent/service.ts:1760`) is a different concern entirely: it
  // routes approval for tool calls made *by* an already-running subagent's
  // own runtime (e.g. that subagent calling `fs_edit`) back into the
  // subagent's loop instead of the parent conversation's. It never runs
  // `delegate_subagent` itself (subagents are blocked from recursive
  // delegation — see `subagent/constants.ts`'s
  // `SUBAGENT_BLOCKED_TOOL_SHORT_NAMES`), and this `execute` never calls
  // into `service.ts` or any other host singleton — only `ToolContext`
  // injections and the one dynamic import below (mirroring the original).
  execute: async (args, ctx) => {
    const {
      subagentParentContext,
      runSubagent,
      conversationId,
      settings,
      conversationMessages,
      toolCallId,
      signal,
    } = ctx

    if (!subagentParentContext || !runSubagent) {
      throw new Error(
        'delegate_subagent is only available during an active parent agent run.',
      )
    }
    if (!conversationId) {
      throw new Error('conversationId is required for delegate_subagent.')
    }

    const description = getTextArg(args, 'description').trim()
    const taskPrompt = getTextArg(args, 'prompt').trim()
    if (!settings) {
      throw new Error('settings are required for delegate_subagent.')
    }
    const requestedModelId = getOptionalTextArg(args, 'modelId')?.trim() ?? ''
    const subagentModelConfig = resolveSubagentModelConfig(settings)
    if (subagentModelConfig.allowedModelIds.length === 0) {
      throw new Error(
        'No registered chat models are configured for delegate_subagent.',
      )
    }
    if (
      requestedModelId &&
      !subagentModelConfig.allowedModelIds.includes(requestedModelId)
    ) {
      throw new Error(
        `Model "${requestedModelId}" is not allowed for delegate_subagent.`,
      )
    }
    const selectedModelId =
      requestedModelId || subagentModelConfig.preferredModelId
    if (!selectedModelId) {
      throw new Error(
        'No preferred chat model is configured for delegate_subagent.',
      )
    }
    const { getChatModelClient } = await import('../../llm/manager')
    const selectedModelClient = getChatModelClient({
      settings,
      modelId: selectedModelId,
    })
    const selectedProvider = settings.providers.find(
      (provider) => provider.id === selectedModelClient.model.providerId,
    )

    let assistantMessageId = ''
    if (conversationMessages) {
      for (let i = conversationMessages.length - 1; i >= 0; i--) {
        const m = conversationMessages[i]
        if (m.role === 'assistant') {
          assistantMessageId = m.id
          break
        }
      }
    }

    const accepted = await runSubagent({
      description,
      prompt: taskPrompt,
      conversationId,
      source: {
        type: 'llm_tool_call',
        toolCallId: toolCallId ?? '',
        assistantMessageId,
      },
      // Passed through unexamined — both `ctx.subagentParentContext` and this
      // `parent` parameter are opaque at this file's boundary (see
      // `OpaqueSubagentParentContext` and `ToolContext['runSubagent']` in
      // `core/tools/types.ts`). The real `SubagentParentContext` shape is
      // only recovered once, where `mcpManager.ts` injects the concrete
      // `runSubagent` implementation into `ToolContext`.
      parent: subagentParentContext,
      childModel: {
        providerClient: selectedModelClient.providerClient,
        model: selectedModelClient.model,
        apiType: selectedProvider?.apiType ?? null,
      },
      signal,
    })

    return {
      status: ToolCallResponseStatus.Success,
      text: JSON.stringify(accepted),
    }
  },
})
