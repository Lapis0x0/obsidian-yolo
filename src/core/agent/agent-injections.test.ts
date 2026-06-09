import type { ChatMessage, ChatToolMessage } from '../../types/chat'
import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'
import { getLocalFileToolServerName } from '../mcp/localFileTools'
import { getToolName } from '../mcp/tool-name-utils'
import { composeAgentInjections } from './agent-injections'
import type { TodoItem } from './todos-from-messages'

const TODO_WRITE_TOOL_NAME = getToolName(
  getLocalFileToolServerName(),
  'todo_write',
)

const todoWriteToolMessage = (todos: TodoItem[]): ChatToolMessage => ({
  role: 'tool',
  id: 'tool-msg',
  toolCalls: [
    {
      request: {
        id: 'call',
        name: TODO_WRITE_TOOL_NAME,
        arguments: createCompleteToolCallArguments({ value: { todos } }),
      },
      response: {
        status: ToolCallResponseStatus.Success,
        data: { type: 'text', text: 'Todos updated.' },
      },
    },
  ],
})

const item = (content: string): TodoItem => ({
  content,
  status: 'pending',
})

const baseEditorSnapshot = {
  type: 'editor-snapshot' as const,
  filePath: '/a.md',
  fileTitle: 'A',
  contextText: '',
  cursorMarker: '|',
}

describe('composeAgentInjections', () => {
  it('returns only base injections when no todo_write tool call exists', () => {
    const result = composeAgentInjections({
      baseInjections: [baseEditorSnapshot],
      messages: [],
    })
    expect(result).toEqual([baseEditorSnapshot])
  })

  it('appends todo-list injection after base injections when todos exist', () => {
    const messages: ChatMessage[] = [todoWriteToolMessage([item('Task A')])]
    const result = composeAgentInjections({
      baseInjections: [baseEditorSnapshot],
      messages,
    })
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(baseEditorSnapshot)
    expect(result[1]).toEqual({ type: 'todo-list', todos: [item('Task A')] })
  })

  it('does not append todo-list when latest tool call has empty todos', () => {
    const messages: ChatMessage[] = [todoWriteToolMessage([])]
    const result = composeAgentInjections({
      baseInjections: undefined,
      messages,
    })
    expect(result).toHaveLength(0)
  })

  it('handles undefined baseInjections', () => {
    const messages: ChatMessage[] = [todoWriteToolMessage([item('Task B')])]
    const result = composeAgentInjections({
      baseInjections: undefined,
      messages,
    })
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ type: 'todo-list', todos: [item('Task B')] })
  })
})
