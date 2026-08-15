import type { McpTool } from '../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { memoryUpdate } from '../../memory/memoryManager'
import { defineTool } from '../define'
import { invokeMemoryTool } from '../memory-tool-support'
import { formatJsonResult } from '../tool-args'

// Schema copied verbatim from the `memory_update` entry in
// `getLocalFileTools()` (`src/core/mcp/localFileTools.ts:934`).
const MEMORY_UPDATE_MCP_TOOL: Omit<McpTool, 'name'> = {
  description:
    'Update an existing memory entry by id within global or assistant memory.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Memory id such as Profile_2 or Memory_4.',
      },
      new_content: {
        type: 'string',
        description: 'Replacement content for the target memory id.',
      },
      scope: {
        type: 'string',
        enum: ['global', 'assistant'],
        description:
          'Memory scope. Defaults to assistant, and may fallback to global when assistant memory is unavailable.',
      },
    },
    required: ['id', 'new_content'],
  },
}

export const memoryUpdateDefinition = defineTool({
  name: 'memory_update',
  getMcpTool: () => MEMORY_UPDATE_MCP_TOOL,
  chatLabel: {
    key: 'settings.agent.builtinMemoryUpdateLabel',
    fallback: 'Update Memory',
  },
  contextPrunable: true,
  // Ported verbatim from the `case 'memory_update'` branch of
  // `callLocalFileTool` (`src/core/mcp/localFileTools.ts:3689`). See
  // memory_add/definition.ts for why there is no outer try/catch here.
  execute: async (args, ctx) => {
    const { app, settings, promptSourceWatcher } = ctx

    const result = await invokeMemoryTool(promptSourceWatcher, (hooks) =>
      memoryUpdate({
        app,
        settings,
        id: args.id,
        newContent: args.new_content,
        scope: args.scope,
        assistantId: settings?.currentAssistantId,
        ...hooks,
      }),
    )

    return {
      status: ToolCallResponseStatus.Success,
      text: formatJsonResult({
        tool: 'memory_update',
        id: result.id,
        scope: result.scope,
        filePath: result.filePath,
      }),
    }
  },
})
