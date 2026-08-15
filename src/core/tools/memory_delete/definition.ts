import type { McpTool } from '../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import type { MemoryScope } from '../../memory/memoryManager'
import { memoryDelete } from '../../memory/memoryManager'
import { defineTool } from '../define'
import { invokeMemoryTool } from '../memory-tool-support'
import {
  asErrorMessage,
  formatJsonResult,
  getStringArrayArg,
} from '../tool-args'

// Schema copied verbatim from the `memory_delete` entry in
// `getLocalFileTools()` (`src/core/mcp/localFileTools.ts:959`).
const MEMORY_DELETE_MCP_TOOL: Omit<McpTool, 'name'> = {
  description:
    'Delete memory entries by id from global or assistant memory. Supports single id or batch ids.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Memory id such as Preference_1.',
      },
      ids: {
        type: 'array',
        items: {
          type: 'string',
        },
        description:
          'Batch delete ids. Each id must exist in the selected memory scope.',
      },
      scope: {
        type: 'string',
        enum: ['global', 'assistant'],
        description:
          'Memory scope. Defaults to assistant, and may fallback to global when assistant memory is unavailable.',
      },
    },
  },
}

export const memoryDeleteDefinition = defineTool({
  name: 'memory_delete',
  getMcpTool: () => MEMORY_DELETE_MCP_TOOL,
  chatLabel: {
    key: 'settings.agent.builtinMemoryDeleteLabel',
    fallback: 'Delete Memory',
  },
  contextPrunable: true,
  // Ported verbatim from the `case 'memory_delete'` branch of
  // `callLocalFileTool` (`src/core/mcp/localFileTools.ts:3713`). See
  // memory_add/definition.ts for why there is no outer try/catch here.
  execute: async (args, ctx) => {
    const { app, settings, promptSourceWatcher } = ctx

    if (args.ids !== undefined) {
      const ids = getStringArrayArg(args, 'ids')
      if (ids.length === 0) {
        throw new Error('ids cannot be empty.')
      }

      const results: Array<
        | {
            ok: true
            id: string
            scope: MemoryScope
            filePath: string
          }
        | {
            ok: false
            id: string
            error: string
            scope: MemoryScope
          }
      > = []

      for (const id of ids) {
        try {
          const result = await invokeMemoryTool(promptSourceWatcher, (hooks) =>
            memoryDelete({
              app,
              settings,
              id,
              scope: args.scope,
              assistantId: settings?.currentAssistantId,
              ...hooks,
            }),
          )
          results.push({
            ok: true,
            id: result.id,
            scope: result.scope,
            filePath: result.filePath,
          })
        } catch (error) {
          results.push({
            ok: false,
            id,
            error: asErrorMessage(error),
            scope:
              typeof args.scope === 'string' &&
              args.scope.trim().toLowerCase() === 'global'
                ? 'global'
                : 'assistant',
          })
        }
      }

      return {
        status: ToolCallResponseStatus.Success,
        text: formatJsonResult({
          tool: 'memory_delete',
          mode: 'batch',
          results,
          okCount: results.filter((result) => result.ok).length,
          failCount: results.filter((result) => !result.ok).length,
        }),
      }
    }

    if (args.id === undefined) {
      throw new Error('id or ids is required.')
    }

    const result = await invokeMemoryTool(promptSourceWatcher, (hooks) =>
      memoryDelete({
        app,
        settings,
        id: args.id,
        scope: args.scope,
        assistantId: settings?.currentAssistantId,
        ...hooks,
      }),
    )

    return {
      status: ToolCallResponseStatus.Success,
      text: formatJsonResult({
        tool: 'memory_delete',
        id: result.id,
        scope: result.scope,
        filePath: result.filePath,
      }),
    }
  },
})
