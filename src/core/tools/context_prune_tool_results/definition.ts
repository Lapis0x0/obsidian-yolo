import type { McpTool } from '../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { defineTool } from '../define'
import {
  formatJsonResult,
  getOptionalTextArg,
  getStringArrayArg,
} from '../tool-args'

import { getContextPrunableToolCallIds, getContextPruneMode } from './helpers'

// Schema copied verbatim from the `context_prune_tool_results` entry in
// `getLocalFileTools()` (`src/core/mcp/localFileTools.ts:716`).
const CONTEXT_PRUNE_TOOL_RESULTS_MCP_TOOL: Omit<McpTool, 'name'> = {
  description:
    'Exclude historical tool call results from future model-visible context without deleting chat history. Supports pruning selected calls or all prunable calls at once.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['selected', 'all'],
        description:
          'Prune mode. Use selected to prune specific toolCallIds, or all to prune all historical prunable tool results.',
      },
      toolCallIds: {
        type: 'array',
        items: {
          type: 'string',
        },
        description:
          'Tool call ids to exclude from future prompt context when mode is selected.',
      },
      reason: {
        type: 'string',
        description: 'Optional short reason for pruning.',
      },
    },
  },
}

export const contextPruneToolResultsDefinition = defineTool({
  name: 'context_prune_tool_results',
  getMcpTool: () => CONTEXT_PRUNE_TOOL_RESULTS_MCP_TOOL,
  chatLabel: {
    key: 'settings.agent.builtinContextPruneToolResultsLabel',
    fallback: 'Prune Tool Results',
  },
  // This tool's own result is deliberately excluded from context pruning
  // (see `isContextPrunableToolName` in `utils/chat/tool-context-pruning.ts`)
  // — pruning the pruning record itself would be self-defeating.
  contextPrunable: false,
  // Ported verbatim from the `case 'context_prune_tool_results'` branch of
  // `callLocalFileTool` (`src/core/mcp/localFileTools.ts:2295` pre-migration),
  // minus the abort check / workspace-scope / YOLO-data-root guards and the
  // outer try/catch that normalizes thrown errors to an Error-status result —
  // those are dispatcher responsibilities (master.md §3.4), not tool
  // semantics. A thrown Error here is expected to propagate to
  // `executeBuiltinTool`, which converts it the same way the old outer catch
  // did.
  execute: async (args, ctx) => {
    const mode = getContextPruneMode(args)

    const prunableToolCallIds = getContextPrunableToolCallIds(
      ctx.conversationMessages,
      ctx.toolCallId,
    )
    const toolCallIds =
      mode === 'all'
        ? [...prunableToolCallIds]
        : getStringArrayArg(args, 'toolCallIds')
            .map((value) => value.trim())
            .filter(
              (value, index, arr) =>
                value.length > 0 && arr.indexOf(value) === index,
            )

    if (mode === 'selected' && toolCallIds.length === 0) {
      throw new Error('toolCallIds cannot be empty when mode is selected.')
    }

    const acceptedToolCallIds = toolCallIds.filter((value) =>
      prunableToolCallIds.has(value),
    )
    const ignoredToolCallIds = toolCallIds.filter(
      (value) => !prunableToolCallIds.has(value),
    )

    return {
      status: ToolCallResponseStatus.Success,
      text: formatJsonResult({
        tool: 'context_prune_tool_results',
        toolCallId: ctx.toolCallId ?? null,
        operation: mode === 'all' ? 'prune_all' : 'prune_selected',
        acceptedToolCallIds,
        ignoredToolCallIds,
        reason: getOptionalTextArg(args, 'reason')?.trim() || null,
      }),
    }
  },
})
