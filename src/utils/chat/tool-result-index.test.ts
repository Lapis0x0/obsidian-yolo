import type {
  AssistantToolMessageGroup,
  ChatMessage,
  ChatUserMessage,
} from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import {
  buildSubagentResultMap,
  buildTerminalCommandResultMap,
  collectToolCallIdsFromGroupedMessages,
  reuseShallowEqualMap,
} from './tool-result-index'

describe('tool result indexes', () => {
  it('collects tool call ids from visible assistant tool groups', () => {
    const userMessage: ChatUserMessage = {
      role: 'user',
      id: 'user-1',
      content: null,
      promptContent: null,
      mentionables: [],
    }
    const group: AssistantToolMessageGroup = [
      {
        role: 'tool',
        id: 'tool-message-1',
        toolCalls: [
          {
            request: { id: 'tool-1', name: 'yolo_local__terminal_command' },
            response: { status: ToolCallResponseStatus.Running },
          },
        ],
      },
      {
        role: 'assistant',
        id: 'assistant-2',
        content: '',
      },
      {
        role: 'tool',
        id: 'tool-message-2',
        toolCalls: [
          {
            request: { id: 'tool-2', name: 'yolo_local__delegate_subagent' },
            response: { status: ToolCallResponseStatus.Running },
          },
        ],
      },
    ]

    expect(collectToolCallIdsFromGroupedMessages([userMessage, group])).toEqual(
      new Set(['tool-1', 'tool-2']),
    )
  })

  it('filters terminal and subagent results to visible tool calls', () => {
    const messages: ChatMessage[] = [
      {
        role: 'terminal_command_result',
        id: 'terminal-result-1',
        taskId: 'task-1',
        source: {
          type: 'llm_tool_call',
          assistantMessageId: 'assistant-1',
          toolCallId: 'visible-terminal',
        },
        title: 'npm test',
        status: 'completed',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        durationMs: 100,
        delegateAssistantMessageId: 'assistant-1',
        delegateToolCallId: 'visible-terminal',
      },
      {
        role: 'terminal_command_result',
        id: 'terminal-result-2',
        taskId: 'task-2',
        source: {
          type: 'llm_tool_call',
          assistantMessageId: 'assistant-2',
          toolCallId: 'hidden-terminal',
        },
        title: 'npm run build',
        status: 'completed',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        durationMs: 100,
        delegateAssistantMessageId: 'assistant-2',
        delegateToolCallId: 'hidden-terminal',
      },
      {
        role: 'subagent_result',
        id: 'subagent-result-1',
        taskId: 'task-3',
        source: {
          type: 'llm_tool_call',
          assistantMessageId: 'assistant-3',
          toolCallId: 'visible-subagent',
        },
        title: 'Check files',
        status: 'completed',
        content: 'done',
        durationMs: 100,
        toolUseCount: 1,
        prompt: 'Check files',
        delegateAssistantMessageId: 'assistant-3',
        delegateToolCallId: 'visible-subagent',
      },
    ]
    const visibleToolCallIds = new Set(['visible-terminal', 'visible-subagent'])

    expect([
      ...buildTerminalCommandResultMap(messages, visibleToolCallIds).keys(),
    ]).toEqual(['visible-terminal'])
    expect([
      ...buildSubagentResultMap(messages, visibleToolCallIds).keys(),
    ]).toEqual(['visible-subagent'])
  })

  it('reuses map identity when entries are shallow-equal', () => {
    const value = { id: 'message-1' }
    const previous = new Map([['tool-1', value]])
    const equalNext = new Map([['tool-1', value]])
    const changedNext = new Map([['tool-1', { id: 'message-1' }]])
    const differentKeyNext = new Map([['tool-2', value]])

    expect(reuseShallowEqualMap(previous, equalNext)).toBe(previous)
    expect(reuseShallowEqualMap(previous, changedNext)).toBe(changedNext)
    expect(reuseShallowEqualMap(previous, differentKeyNext)).toBe(
      differentKeyNext,
    )
  })
})
