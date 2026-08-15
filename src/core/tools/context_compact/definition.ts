import type { McpTool } from '../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { defineTool } from '../define'
import { formatJsonResult, getOptionalTextArg } from '../tool-args'

// Schema copied verbatim from the `context_compact` entry in
// `getLocalFileTools()` (`src/core/mcp/localFileTools.ts:744`).
const CONTEXT_COMPACT_MCP_TOOL: Omit<McpTool, 'name'> = {
  description:
    'Compact earlier conversation history into a summary and continue in a fresh context window while preserving visible chat history.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Optional short reason for compacting.',
      },
      instruction: {
        type: 'string',
        description: 'Optional focus hint for the summary.',
      },
    },
  },
}

export const contextCompactDefinition = defineTool({
  name: 'context_compact',
  getMcpTool: () => CONTEXT_COMPACT_MCP_TOOL,
  chatLabel: {
    key: 'settings.agent.builtinContextCompactLabel',
    fallback: 'Compact Context',
  },
  // Excluded from context pruning for the same reason
  // `context_prune_tool_results` is (see `isContextPrunableToolName`).
  contextPrunable: false,
  // Ported verbatim from the `case 'context_compact'` branch of
  // `callLocalFileTool` (`src/core/mcp/localFileTools.ts:2337`
  // pre-migration), minus the abort check / workspace-scope / YOLO-data-root
  // guards and the outer try/catch that normalizes thrown errors to an
  // Error-status result — those are dispatcher responsibilities (master.md
  // §3.4), not tool semantics.
  execute: async (args, ctx) => {
    return {
      status: ToolCallResponseStatus.Success,
      text: formatJsonResult({
        tool: 'context_compact',
        toolCallId: ctx.toolCallId ?? null,
        operation: 'compact_restart',
        reason: getOptionalTextArg(args, 'reason')?.trim() || null,
        instruction: getOptionalTextArg(args, 'instruction')?.trim() || null,
      }),
    }
  },
})
