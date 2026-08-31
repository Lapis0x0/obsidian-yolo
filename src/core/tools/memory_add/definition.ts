import type { McpTool } from '../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import type { MemoryScope } from '../../memory/memoryManager'
import { memoryAdd } from '../../memory/memoryManager'
import { defineTool } from '../define'
import { invokeMemoryTool } from '../memory-tool-support'
import {
  asErrorMessage,
  formatJsonResult,
  getRecordArrayArg,
} from '../tool-args'

// Schema copied verbatim from the `memory_add` entry in
// `getLocalFileTools()` (`src/core/mcp/localFileTools.ts:888`).
const MEMORY_ADD_MCP_TOOL: Omit<McpTool, 'name'> = {
  description:
    'Add memory entries to global or assistant memory. Supports single entry or batch items; category defaults to other and id is auto-assigned.',
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'Memory content text to store.',
      },
      items: {
        type: 'array',
        description:
          'Batch add items. Each item accepts content, optional category, and optional scope.',
        items: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
            },
            category: {
              type: 'string',
            },
            scope: {
              type: 'string',
              enum: ['global', 'assistant'],
            },
          },
          required: ['content'],
        },
      },
      category: {
        type: 'string',
        description:
          'Memory category. Use profile, preferences, or other. Defaults to other.',
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

export const memoryAddDefinition = defineTool({
  name: 'memory_add',
  getMcpTool: () => MEMORY_ADD_MCP_TOOL,
  chatLabel: {
    key: 'settings.agent.builtinMemoryAddLabel',
    fallback: 'Add Memory',
  },
  contextPrunable: true,
  // Ported verbatim from the `case 'memory_add'` branch of
  // `callLocalFileTool` (`src/core/mcp/localFileTools.ts:3593`), minus the
  // abort check / workspace-scope / YOLO-data-root guards and the outer
  // try/catch that normalizes thrown errors to an Error-status result —
  // those are dispatcher responsibilities (master.md §3.4), not tool
  // semantics. A thrown Error here is expected to propagate to
  // `executeBuiltinTool`, which converts it the same way the old outer
  // catch did.
  execute: async (args, ctx) => {
    const { app, settings, promptSourceWatcher } = ctx

    if (args.items !== undefined) {
      const items = getRecordArrayArg(args, 'items')
      if (items.length === 0) {
        throw new Error('items cannot be empty.')
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
            error: string
            scope: MemoryScope
          }
      > = []

      for (const item of items) {
        try {
          const result = await invokeMemoryTool(promptSourceWatcher, (hooks) =>
            memoryAdd({
              app,
              settings,
              content: item.content,
              category: item.category,
              scope: item.scope ?? args.scope,
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
            error: asErrorMessage(error),
            scope:
              typeof (item.scope ?? args.scope) === 'string' &&
              String(item.scope ?? args.scope)
                .trim()
                .toLowerCase() === 'global'
                ? 'global'
                : 'assistant',
          })
        }
      }

      return {
        status: ToolCallResponseStatus.Success,
        text: formatJsonResult({
          tool: 'memory_add',
          mode: 'batch',
          results,
          okCount: results.filter((result) => result.ok).length,
          failCount: results.filter((result) => !result.ok).length,
        }),
      }
    }

    if (args.content === undefined) {
      throw new Error('content or items is required.')
    }

    const result = await invokeMemoryTool(promptSourceWatcher, (hooks) =>
      memoryAdd({
        app,
        settings,
        content: args.content,
        category: args.category,
        scope: args.scope,
        assistantId: settings?.currentAssistantId,
        ...hooks,
      }),
    )

    return {
      status: ToolCallResponseStatus.Success,
      text: formatJsonResult({
        tool: 'memory_add',
        id: result.id,
        scope: result.scope,
        filePath: result.filePath,
      }),
    }
  },
})
