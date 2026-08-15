import type { McpTool } from '../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import type { TodoItem } from '../../agent/todos-from-messages'
import { defineTool } from '../define'
import type { LocalToolCallResult } from '../types'

// Schema copied verbatim from the `todo_write` entry in `getLocalFileTools()`
// (`src/core/mcp/localFileTools.ts:1220`).
const TODO_WRITE_MCP_TOOL: Omit<McpTool, 'name'> = {
  description:
    'Update the todo list for the current agent run. Use proactively for multi-step tasks (≥3 steps) or when the user has multiple requests. Each call replaces the entire list; pass `[]` to clear. Keep at most one item in_progress (and exactly one while work is ongoing). Mark items completed immediately as you finish them.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description:
          'Complete replacement list of todo items. Pass [] to clear all todos.',
        items: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description:
                'The work to do, as an action phrase. Examples: "Run tests", "Refactor the parser".',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'Current status of the task.',
            },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
}

// Ported verbatim from `executeTodoWrite` (`src/core/mcp/localFileTools.ts`,
// formerly the standalone helper backing `case 'todo_write'`) — moved here
// rather than left as a shared import because it has exactly one caller
// (master.md §7 / phase2-migration.md D6 "注意": helpers with a single
// consumer follow that tool). Unlike every other ported `execute`, this one
// returns Error-status results directly instead of throwing — that is
// `executeTodoWrite`'s original, pre-existing behavior (not a change made
// during this port) and is preserved verbatim so `executeBuiltinTool`'s
// error-normalizing catch sees exactly the same result shape it always did
// for this tool.
const executeTodoWrite = (
  args: Record<string, unknown>,
): LocalToolCallResult => {
  const rawTodos = args.todos
  if (!Array.isArray(rawTodos)) {
    return {
      status: ToolCallResponseStatus.Error,
      error: 'todos must be an array.',
    }
  }

  const todos: TodoItem[] = []
  for (let i = 0; i < rawTodos.length; i++) {
    const item = rawTodos[i]
    if (typeof item !== 'object' || item === null) {
      return {
        status: ToolCallResponseStatus.Error,
        error: `todos[${i}] must be an object.`,
      }
    }
    const { content, status } = item as Record<string, unknown>
    if (typeof content !== 'string' || content.trim() === '') {
      return {
        status: ToolCallResponseStatus.Error,
        error: `todos[${i}].content must be a non-empty string.`,
      }
    }
    if (
      status !== 'pending' &&
      status !== 'in_progress' &&
      status !== 'completed'
    ) {
      return {
        status: ToolCallResponseStatus.Error,
        error: `todos[${i}].status must be "pending", "in_progress", or "completed".`,
      }
    }
    todos.push({ content, status })
  }

  const inProgressCount = todos.filter((t) => t.status === 'in_progress').length
  if (inProgressCount > 1) {
    return {
      status: ToolCallResponseStatus.Error,
      error: `At most one todo may be in_progress at a time, but ${inProgressCount} were provided.`,
    }
  }

  return {
    status: ToolCallResponseStatus.Success,
    text: 'Todos updated. Continue tracking your progress with the todo list.',
  }
}

export const todoWriteDefinition = defineTool({
  name: 'todo_write',
  getMcpTool: () => TODO_WRITE_MCP_TOOL,
  chatLabel: {
    key: 'settings.agent.builtinTodoWriteLabel',
    fallback: 'Task List',
  },
  contextPrunable: true,
  execute: async (args) => executeTodoWrite(args),
})
