import type { ChatMessage, ChatToolMessage } from '../../types/chat'
import {
  ToolCallResponse,
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'
import { getLocalFileToolServerName } from '../mcp/localFileTools'
import { getToolName } from '../mcp/tool-name-utils'
import {
  deriveTodosFromMessages,
  findLatestCompletedTodoWriteId,
  findTodoSeriesStartId,
} from './todos-from-messages'

const TODO_WRITE_TOOL_NAME = getToolName(
  getLocalFileToolServerName(),
  'todo_write',
)

const SUCCESS_RESPONSE: ToolCallResponse = {
  status: ToolCallResponseStatus.Success,
  data: { type: 'text', text: 'Todos updated.' },
}

const todoWriteToolMessage = (
  todos: unknown,
  id = 'tool-msg',
  response: ToolCallResponse = SUCCESS_RESPONSE,
): ChatToolMessage => ({
  role: 'tool',
  id,
  toolCalls: [
    {
      request: {
        id: `${id}-call`,
        name: TODO_WRITE_TOOL_NAME,
        arguments: createCompleteToolCallArguments({ value: { todos } }),
      },
      response,
    },
  ],
})

const userMessage = (content: string, id = 'u'): ChatMessage => ({
  role: 'user',
  id,
  content: null,
  promptContent: content,
  mentionables: [],
})

describe('deriveTodosFromMessages', () => {
  it('returns empty when no todo_write tool call exists', () => {
    expect(deriveTodosFromMessages([])).toEqual([])
    expect(deriveTodosFromMessages([userMessage('hi')])).toEqual([])
  })

  it('returns todos from the latest todo_write tool call', () => {
    const messages: ChatMessage[] = [
      userMessage('start'),
      todoWriteToolMessage([{ content: 'A', status: 'pending' }], 'm1'),
      todoWriteToolMessage(
        [
          { content: 'A', status: 'completed' },
          { content: 'B', status: 'in_progress' },
        ],
        'm2',
      ),
    ]
    expect(deriveTodosFromMessages(messages)).toEqual([
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'in_progress' },
    ])
  })

  it('returns empty when the latest todo_write was an empty list (explicit clear)', () => {
    const messages: ChatMessage[] = [
      todoWriteToolMessage([{ content: 'A', status: 'pending' }], 'm1'),
      todoWriteToolMessage([], 'm2'),
    ]
    expect(deriveTodosFromMessages(messages)).toEqual([])
  })

  it('skips invalid todo entries silently', () => {
    const messages: ChatMessage[] = [
      todoWriteToolMessage(
        [
          { content: 'A', status: 'pending' },
          { content: '', status: 'pending' },
          { content: 'B', status: 'unknown' },
          { content: 'C', status: 'completed' },
        ],
        'm1',
      ),
    ]
    expect(deriveTodosFromMessages(messages)).toEqual([
      { content: 'A', status: 'pending' },
      { content: 'C', status: 'completed' },
    ])
  })

  it('returns empty when todos is not an array', () => {
    const messages: ChatMessage[] = [
      todoWriteToolMessage('not-an-array' as unknown as never[], 'm1'),
    ]
    expect(deriveTodosFromMessages(messages)).toEqual([])
  })

  it('ignores non-todo_write tool calls', () => {
    const otherTool: ChatToolMessage = {
      role: 'tool',
      id: 'm1',
      toolCalls: [
        {
          request: {
            id: 'r1',
            name: getToolName(getLocalFileToolServerName(), 'fs_read'),
            arguments: createCompleteToolCallArguments({
              value: { path: 'foo.md' },
            }),
          },
          response: {
            status: ToolCallResponseStatus.Success,
            data: { type: 'text', text: '...' },
          },
        },
      ],
    }
    expect(deriveTodosFromMessages([otherTool])).toEqual([])
  })

  it('skips a failed todo_write and falls back to the previous successful state', () => {
    const messages: ChatMessage[] = [
      todoWriteToolMessage([{ content: 'A', status: 'pending' }], 'm1'),
      todoWriteToolMessage('not-an-array', 'm2', {
        status: ToolCallResponseStatus.Error,
        error: 'todos must be an array.',
      }),
    ]
    expect(deriveTodosFromMessages(messages)).toEqual([
      { content: 'A', status: 'pending' },
    ])
  })

  it('skips a rejected todo_write and falls back to the previous successful state', () => {
    const messages: ChatMessage[] = [
      todoWriteToolMessage([{ content: 'A', status: 'pending' }], 'm1'),
      todoWriteToolMessage([{ content: 'B', status: 'pending' }], 'm2', {
        status: ToolCallResponseStatus.Rejected,
      }),
    ]
    expect(deriveTodosFromMessages(messages)).toEqual([
      { content: 'A', status: 'pending' },
    ])
  })

  it('skips a still-running todo_write so UI never shows un-committed args', () => {
    const messages: ChatMessage[] = [
      todoWriteToolMessage([{ content: 'A', status: 'pending' }], 'm1'),
      todoWriteToolMessage([{ content: 'B', status: 'in_progress' }], 'm2', {
        status: ToolCallResponseStatus.Running,
      }),
    ]
    expect(deriveTodosFromMessages(messages)).toEqual([
      { content: 'A', status: 'pending' },
    ])
  })

  it('skips an aborted todo_write and falls back to the previous successful state', () => {
    const messages: ChatMessage[] = [
      todoWriteToolMessage([{ content: 'A', status: 'pending' }], 'm1'),
      todoWriteToolMessage([{ content: 'B', status: 'pending' }], 'm2', {
        status: ToolCallResponseStatus.Aborted,
      }),
    ]
    expect(deriveTodosFromMessages(messages)).toEqual([
      { content: 'A', status: 'pending' },
    ])
  })

  it('skips a pending-approval todo_write', () => {
    const messages: ChatMessage[] = [
      todoWriteToolMessage([{ content: 'A', status: 'pending' }], 'm1'),
      todoWriteToolMessage([{ content: 'B', status: 'pending' }], 'm2', {
        status: ToolCallResponseStatus.PendingApproval,
      }),
    ]
    expect(deriveTodosFromMessages(messages)).toEqual([
      { content: 'A', status: 'pending' },
    ])
  })

  it('returns empty when the only todo_write call has not succeeded yet', () => {
    const messages: ChatMessage[] = [
      todoWriteToolMessage([{ content: 'A', status: 'pending' }], 'm1', {
        status: ToolCallResponseStatus.Running,
      }),
    ]
    expect(deriveTodosFromMessages(messages)).toEqual([])
  })

  it('strips legacy activeForm field from old persisted tool calls', () => {
    // Old conversations stored todos with an extra `activeForm` field.
    // Derivation must silently drop it and return only { content, status }.
    const messages: ChatMessage[] = [
      todoWriteToolMessage(
        [
          { content: 'A', activeForm: 'Doing A', status: 'pending' },
          { content: 'B', activeForm: 'Doing B', status: 'completed' },
        ],
        'm1',
      ),
    ]
    expect(deriveTodosFromMessages(messages)).toEqual([
      { content: 'A', status: 'pending' },
      { content: 'B', status: 'completed' },
    ])
  })

  it('returns frozen array (callers cannot mutate)', () => {
    const messages: ChatMessage[] = [
      todoWriteToolMessage([{ content: 'A', status: 'pending' }], 'm1'),
    ]
    const result = deriveTodosFromMessages(messages)
    expect(Object.isFrozen(result)).toBe(true)
  })
})

describe('findTodoSeriesStartId', () => {
  it('returns null when no successful todo_write exists', () => {
    expect(findTodoSeriesStartId([])).toBeNull()
    expect(findTodoSeriesStartId([userMessage('hi')])).toBeNull()
  })

  it('returns the first call id as the series start', () => {
    const messages: ChatMessage[] = [
      todoWriteToolMessage([{ content: 'A', status: 'pending' }], 'm1'),
    ]
    expect(findTodoSeriesStartId(messages)).toBe('m1-call')
  })

  it('keeps the same series id while previous list still has active items', () => {
    const messages: ChatMessage[] = [
      todoWriteToolMessage(
        [
          { content: 'A', status: 'pending' },
          { content: 'B', status: 'pending' },
        ],
        'm1',
      ),
      todoWriteToolMessage(
        [
          { content: 'A', status: 'completed' },
          { content: 'B', status: 'in_progress' },
        ],
        'm2',
      ),
      todoWriteToolMessage(
        [
          { content: 'A', status: 'completed' },
          { content: 'B', status: 'completed' },
          { content: 'C', status: 'pending' },
        ],
        'm3',
      ),
    ]
    expect(findTodoSeriesStartId(messages)).toBe('m1-call')
  })

  it('starts a new series when the previous list was all completed', () => {
    const messages: ChatMessage[] = [
      todoWriteToolMessage([{ content: 'A', status: 'completed' }], 'm1'),
      todoWriteToolMessage([{ content: 'B', status: 'pending' }], 'm2'),
    ]
    expect(findTodoSeriesStartId(messages)).toBe('m2-call')
  })

  it('starts a new series when the previous list was empty (explicit clear)', () => {
    const messages: ChatMessage[] = [
      todoWriteToolMessage([{ content: 'A', status: 'pending' }], 'm1'),
      todoWriteToolMessage([], 'm2'),
      todoWriteToolMessage([{ content: 'B', status: 'pending' }], 'm3'),
    ]
    expect(findTodoSeriesStartId(messages)).toBe('m3-call')
  })

  it('ignores non-success todo_write calls when computing the series', () => {
    const messages: ChatMessage[] = [
      todoWriteToolMessage([{ content: 'A', status: 'pending' }], 'm1'),
      // Failed write does not affect series detection.
      todoWriteToolMessage('bad', 'm2', {
        status: ToolCallResponseStatus.Error,
        error: 'todos must be an array.',
      }),
      todoWriteToolMessage([{ content: 'A', status: 'completed' }], 'm3'),
    ]
    // m3 follows m1 (m2 ignored); m1 had an active item so m3 is a continuation.
    expect(findTodoSeriesStartId(messages)).toBe('m1-call')
  })

  it('handles multiple series in one message stream', () => {
    const messages: ChatMessage[] = [
      todoWriteToolMessage([{ content: 'A', status: 'pending' }], 'm1'),
      todoWriteToolMessage([{ content: 'A', status: 'completed' }], 'm2'),
      todoWriteToolMessage([{ content: 'B', status: 'pending' }], 'm3'),
      todoWriteToolMessage([{ content: 'B', status: 'in_progress' }], 'm4'),
    ]
    expect(findTodoSeriesStartId(messages)).toBe('m3-call')
  })
})

describe('findLatestCompletedTodoWriteId', () => {
  it('returns null when no successful todo_write exists', () => {
    expect(findLatestCompletedTodoWriteId([])).toBeNull()
    expect(findLatestCompletedTodoWriteId([userMessage('hi')])).toBeNull()
  })

  it('returns null when latest list still has pending or in_progress items', () => {
    const messages: ChatMessage[] = [
      todoWriteToolMessage(
        [
          { content: 'A', status: 'completed' },
          { content: 'B', status: 'pending' },
        ],
        'm1',
      ),
    ]
    expect(findLatestCompletedTodoWriteId(messages)).toBeNull()
  })

  it('returns null when latest list is an explicit empty (no completion to mark)', () => {
    const messages: ChatMessage[] = [
      todoWriteToolMessage([{ content: 'A', status: 'completed' }], 'm1'),
      todoWriteToolMessage([], 'm2'),
    ]
    expect(findLatestCompletedTodoWriteId(messages)).toBeNull()
  })

  it('returns the request id when latest list is non-empty and all completed', () => {
    const messages: ChatMessage[] = [
      todoWriteToolMessage(
        [
          { content: 'A', status: 'completed' },
          { content: 'B', status: 'completed' },
        ],
        'm1',
      ),
    ]
    expect(findLatestCompletedTodoWriteId(messages)).toBe('m1-call')
  })

  it('returns the latest matching write, not an older one', () => {
    const messages: ChatMessage[] = [
      todoWriteToolMessage([{ content: 'A', status: 'completed' }], 'm1'),
      todoWriteToolMessage(
        [
          { content: 'A', status: 'completed' },
          { content: 'B', status: 'completed' },
        ],
        'm2',
      ),
    ]
    expect(findLatestCompletedTodoWriteId(messages)).toBe('m2-call')
  })

  it('skips non-success todo_write calls', () => {
    const messages: ChatMessage[] = [
      todoWriteToolMessage([{ content: 'A', status: 'completed' }], 'm1'),
      // Failed write does not change the "completed write" identity.
      todoWriteToolMessage('bad', 'm2', {
        status: ToolCallResponseStatus.Error,
        error: 'todos must be an array.',
      }),
    ]
    expect(findLatestCompletedTodoWriteId(messages)).toBe('m1-call')
  })
})
