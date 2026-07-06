import type {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
  ChatExternalAgentResultMessage,
  ChatToolMessage,
} from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import {
  parseGroupFromEdit,
  serializeGroupForEdit,
} from './assistant-group-edit-parser'

const assistant = (
  id: string,
  content: string,
  toolCallRequestIds: readonly string[] = [],
  reasoning?: string,
): ChatAssistantMessage => ({
  role: 'assistant',
  id,
  content,
  reasoning,
  toolCallRequests: toolCallRequestIds.map((requestId) => ({
    id: requestId,
    name: `tool_${requestId}`,
  })),
})

const tool = (id: string, requestIds: readonly string[]): ChatToolMessage => ({
  role: 'tool',
  id,
  toolCalls: requestIds.map((requestId) => ({
    request: {
      id: requestId,
      name: `tool_${requestId}`,
    },
    response: {
      status: ToolCallResponseStatus.Success,
      data: {
        type: 'text',
        text: `result ${requestId}`,
      },
    },
  })),
})

const externalResult = (id: string): ChatExternalAgentResultMessage => ({
  role: 'external_agent_result',
  id,
  taskId: `task-${id}`,
  source: {
    type: 'llm_tool_call',
    toolCallId: 'call-external',
    assistantMessageId: 'assistant-external',
  },
  provider: 'codex',
  title: 'External task',
  status: 'completed',
  exitCode: 0,
  stdout: '',
  stderr: '',
  durationMs: 1,
  delegateAssistantMessageId: 'assistant-external',
  delegateToolCallId: 'call-external',
})

const toolIds = (message: ChatToolMessage): string[] =>
  message.toolCalls.map((toolCall) => toolCall.request.id)

const assistantRequestIds = (message: ChatAssistantMessage): string[] =>
  message.toolCallRequests?.map((request) => request.id) ?? []

describe('assistant group edit parser', () => {
  it('serializes and parses a plain assistant group without tool calls', () => {
    const messages: AssistantToolMessageGroup = [assistant('a1', 'hello')]

    expect(serializeGroupForEdit(messages)).toBe('hello')

    const result = parseGroupFromEdit('updated', messages)

    expect(result.removedMessageIds).toEqual([])
    expect(result.retainedMessages).toEqual([
      {
        ...messages[0],
        content: 'updated',
        toolCallRequests: [],
      },
    ])
  })

  it('serializes one tool call placeholder per toolCall', () => {
    const messages: AssistantToolMessageGroup = [
      assistant('a1', 'before', ['call-1', 'call-2']),
      tool('t1', ['call-1', 'call-2']),
      assistant('a2', 'after'),
    ]

    expect(serializeGroupForEdit(messages)).toBe(
      'before\n\n⟨🔧 tool_call-1 | call-1⟩\n\n⟨🔧 tool_call-2 | call-2⟩\n\nafter',
    )

    const result = parseGroupFromEdit(serializeGroupForEdit(messages), messages)

    expect(result.removedMessageIds).toEqual([])
    expect(result.retainedMessages).toHaveLength(3)
    expect(
      (result.retainedMessages[1] as ChatToolMessage).toolCalls,
    ).toHaveLength(2)
  })

  it('removes one deleted tool call placeholder from assistant requests and toolCalls', () => {
    const messages: AssistantToolMessageGroup = [
      assistant('a1', 'before', ['call-1', 'call-2']),
      tool('t1', ['call-1', 'call-2']),
      assistant('a2', 'after'),
    ]
    const text = serializeGroupForEdit(messages).replace(
      '⟨🔧 tool_call-1 | call-1⟩\n\n',
      '',
    )

    const result = parseGroupFromEdit(text, messages)

    expect(result.removedMessageIds).toEqual([])
    expect(result.retainedMessages.map((message) => message.id)).toEqual([
      'a1',
      't1',
      'a2',
    ])
    expect(
      assistantRequestIds(result.retainedMessages[0] as ChatAssistantMessage),
    ).toEqual(['call-2'])
    expect(toolIds(result.retainedMessages[1] as ChatToolMessage)).toEqual([
      'call-2',
    ])
    expect((result.retainedMessages[0] as ChatAssistantMessage).content).toBe(
      'before',
    )
    expect((result.retainedMessages[2] as ChatAssistantMessage).content).toBe(
      'after',
    )
  })

  it('deletes a tool message when all of its toolCall placeholders are removed', () => {
    const messages: AssistantToolMessageGroup = [
      assistant('a1', 'before', ['call-1']),
      tool('t1', ['call-1']),
      assistant('a2', 'after'),
    ]

    const result = parseGroupFromEdit('beforeafter', messages)

    expect(result.removedMessageIds).toEqual(['a1', 't1'])
    expect(result.retainedMessages.map((message) => message.id)).toEqual(['a2'])
    expect((result.retainedMessages[0] as ChatAssistantMessage).content).toBe(
      'beforeafter',
    )
  })

  it('deletes multiple tool calls distributed across different tool messages', () => {
    const messages: AssistantToolMessageGroup = [
      assistant('a1', 'one', ['call-1']),
      tool('t1', ['call-1']),
      assistant('a2', 'two', ['call-2']),
      tool('t2', ['call-2']),
      assistant('a3', 'three'),
    ]
    const text = '\n\n⟨🔧 tool_call-1 | call-1⟩\n\none-two-three'

    const result = parseGroupFromEdit(text, messages)

    expect(result.removedMessageIds).toEqual(['a2', 't2'])
    expect(result.retainedMessages.map((message) => message.id)).toEqual([
      'a1',
      't1',
      'a3',
    ])
    expect((result.retainedMessages[2] as ChatAssistantMessage).content).toBe(
      'one-two-three',
    )
  })

  it('treats copied placeholders as normal text after the first occurrence', () => {
    const messages: AssistantToolMessageGroup = [
      assistant('a1', 'before', ['call-1']),
      tool('t1', ['call-1']),
      assistant('a2', 'after'),
    ]
    const text = `${serializeGroupForEdit(messages)} copied ⟨🔧 tool_call-1 | call-1⟩`

    const result = parseGroupFromEdit(text, messages)

    expect(result.removedMessageIds).toEqual([])
    expect((result.retainedMessages[2] as ChatAssistantMessage).content).toBe(
      'after copied ⟨🔧 tool_call-1 | call-1⟩',
    )
  })

  it('treats tampered placeholder ids as normal text', () => {
    const messages: AssistantToolMessageGroup = [
      assistant('a1', 'before', ['call-1']),
      tool('t1', ['call-1']),
      assistant('a2', 'after'),
    ]
    const text = serializeGroupForEdit(messages).replace(
      '| call-1⟩',
      '| missing⟩',
    )

    const result = parseGroupFromEdit(text, messages)

    expect(result.removedMessageIds).toEqual(['a1', 't1'])
    expect(result.retainedMessages.map((message) => message.id)).toEqual(['a2'])
    expect(
      (result.retainedMessages[0] as ChatAssistantMessage).content,
    ).toContain('⟨🔧 tool_call-1 | missing⟩')
  })

  it('only recognizes reordered placeholders while their original position stays monotonic', () => {
    const messages: AssistantToolMessageGroup = [
      assistant('a1', 'before', ['call-1']),
      tool('t1', ['call-1']),
      assistant('a2', 'middle', ['call-2']),
      tool('t2', ['call-2']),
      assistant('a3', 'after'),
    ]
    const text =
      'before\n\n⟨🔧 tool_call-2 | call-2⟩\n\nmiddle\n\n⟨🔧 tool_call-1 | call-1⟩\n\nafter'

    const result = parseGroupFromEdit(text, messages)

    expect(result.removedMessageIds).toEqual(['a1', 't1'])
    expect(result.retainedMessages.map((message) => message.id)).toEqual([
      'a2',
      't2',
      'a3',
    ])
    expect((result.retainedMessages[2] as ChatAssistantMessage).content).toBe(
      'middle\n\n⟨🔧 tool_call-1 | call-1⟩\n\nafter',
    )
  })

  it('cleans assistant empty shells after slice assignment', () => {
    const messages: AssistantToolMessageGroup = [
      assistant('a1', '', ['call-1']),
      tool('t1', ['call-1']),
      assistant('a2', ''),
    ]

    const result = parseGroupFromEdit('', messages)

    expect(result.retainedMessages).toEqual([])
    expect(result.removedMessageIds).toEqual(['a1', 't1', 'a2'])
  })

  it('consumes generated placeholder boundary blank lines but preserves extra user blank lines', () => {
    const messages: AssistantToolMessageGroup = [
      assistant('a1', 'before', ['call-1']),
      tool('t1', ['call-1']),
      assistant('a2', 'after'),
    ]
    const text = 'before\n\n\n⟨🔧 tool_call-1 | call-1⟩\n\n\nafter'

    const result = parseGroupFromEdit(text, messages)

    expect((result.retainedMessages[0] as ChatAssistantMessage).content).toBe(
      'before\n',
    )
    expect((result.retainedMessages[2] as ChatAssistantMessage).content).toBe(
      '\nafter',
    )
  })

  it('preserves async result messages defensively without placeholder handling', () => {
    const messages: AssistantToolMessageGroup = [
      assistant('a1', 'before', ['call-1']),
      tool('t1', ['call-1']),
      externalResult('e1'),
      assistant('a2', 'after'),
    ]

    expect(serializeGroupForEdit(messages)).not.toContain('External task')

    const result = parseGroupFromEdit('beforeafter', messages)

    expect(result.retainedMessages.map((message) => message.id)).toEqual([
      'e1',
      'a2',
    ])
    expect(result.retainedMessages[0]).toBe(messages[2])
  })

  it('does not emit a reasoning placeholder when reasoning is empty', () => {
    const messages: AssistantToolMessageGroup = [assistant('a1', 'hello')]

    expect(serializeGroupForEdit(messages)).toBe('hello')
    expect(serializeGroupForEdit(messages)).not.toContain('💭')
  })

  it('emits and round-trips a reasoning placeholder when reasoning is present', () => {
    const messages: AssistantToolMessageGroup = [
      assistant('a1', 'hello', [], 'thinking thoughts'),
    ]

    expect(serializeGroupForEdit(messages)).toBe('⟨💭 reasoning | a1⟩\n\nhello')

    const result = parseGroupFromEdit(serializeGroupForEdit(messages), messages)

    expect(result.removedMessageIds).toEqual([])
    expect(result.retainedMessages).toHaveLength(1)
    const retained = result.retainedMessages[0] as ChatAssistantMessage
    expect(retained.reasoning).toBe('thinking thoughts')
    expect(retained.content).toBe('hello')
  })

  it('drops reasoning when its placeholder is removed but keeps content', () => {
    const messages: AssistantToolMessageGroup = [
      assistant('a1', 'hello', [], 'thinking thoughts'),
    ]

    const result = parseGroupFromEdit('hello', messages)

    expect(result.removedMessageIds).toEqual([])
    expect(result.retainedMessages).toHaveLength(1)
    const retained = result.retainedMessages[0] as ChatAssistantMessage
    expect(retained.reasoning).toBeUndefined()
    expect(retained.content).toBe('hello')
  })

  it('removes the whole assistant shell when content, reasoning and tool calls are all gone', () => {
    const messages: AssistantToolMessageGroup = [
      assistant('a1', 'hello', ['call-1'], 'thinking thoughts'),
      tool('t1', ['call-1']),
    ]

    const result = parseGroupFromEdit('', messages)

    expect(result.removedMessageIds).toEqual(['a1', 't1'])
    expect(result.retainedMessages).toEqual([])
  })

  it('routes slices correctly when reasoning and tool placeholders coexist', () => {
    const messages: AssistantToolMessageGroup = [
      assistant('a1', 'first', ['call-1'], 'thinking thoughts'),
      tool('t1', ['call-1']),
      assistant('a2', 'final'),
    ]

    expect(serializeGroupForEdit(messages)).toBe(
      '⟨💭 reasoning | a1⟩\n\nfirst\n\n⟨🔧 tool_call-1 | call-1⟩\n\nfinal',
    )

    const result = parseGroupFromEdit(serializeGroupForEdit(messages), messages)

    const a1 = result.retainedMessages[0] as ChatAssistantMessage
    const a2 = result.retainedMessages[2] as ChatAssistantMessage
    expect(a1.reasoning).toBe('thinking thoughts')
    expect(a1.content).toBe('first')
    expect(a2.content).toBe('final')
  })

  it('keeps adjacent placeholders separated by a single blank line', () => {
    const messages: AssistantToolMessageGroup = [
      assistant('a1', '', ['call-1']),
      tool('t1', ['call-1']),
      assistant('a2', 'hello', [], 'thinking thoughts'),
    ]

    expect(serializeGroupForEdit(messages)).toBe(
      '⟨🔧 tool_call-1 | call-1⟩\n\n⟨💭 reasoning | a2⟩\n\nhello',
    )
  })

  it('does not collide when reasoning anchor id equals a tool call id by accident', () => {
    const messages: AssistantToolMessageGroup = [
      assistant('shared-id', 'hello', ['shared-id'], 'thinking thoughts'),
      tool('t1', ['shared-id']),
    ]

    expect(serializeGroupForEdit(messages)).toBe(
      '⟨💭 reasoning | shared-id⟩\n\nhello\n\n⟨🔧 tool_shared-id | shared-id⟩',
    )

    const result = parseGroupFromEdit(serializeGroupForEdit(messages), messages)

    const a1 = result.retainedMessages[0] as ChatAssistantMessage
    const t1 = result.retainedMessages[1] as ChatToolMessage
    expect(a1.reasoning).toBe('thinking thoughts')
    expect(toolIds(t1)).toEqual(['shared-id'])
  })
})
