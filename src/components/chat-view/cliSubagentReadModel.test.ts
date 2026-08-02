import type { ChatMessage } from '../../types/chat'
import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'

import { buildCliSubagentReadModel } from './cliSubagentReadModel'

const assistantRequest = ({
  id,
  runtimeId,
  name,
  eventType,
  args,
}: {
  id: string
  runtimeId: 'claude-code' | 'codex'
  name: string
  eventType: string
  args: Record<string, unknown>
}): ChatMessage => ({
  role: 'assistant',
  id: `assistant-${id}`,
  content: '',
  toolCallRequests: [
    {
      id,
      name,
      arguments: createCompleteToolCallArguments({ value: args }),
      metadata: {
        cliToolCall: { runtimeId, name, eventType },
      },
    },
  ],
  metadata: { generationState: 'completed' },
})

describe('buildCliSubagentReadModel', () => {
  it('turns Claude Agent into a card and removes child activity from the main timeline', () => {
    const request = assistantRequest({
      id: 'agent-call',
      runtimeId: 'claude-code',
      name: 'Agent',
      eventType: 'tool_use',
      args: {
        description: 'Inspect the runtime',
        prompt: 'Trace the runtime path.',
        model: 'sonnet',
      },
    })
    const childAssistant: ChatMessage = {
      role: 'assistant',
      id: 'child-assistant',
      content: 'Found the runtime owner.',
      metadata: {
        generationState: 'completed',
        cliSubagentParentCallId: 'agent-call',
      },
    }
    const result: ChatMessage = {
      role: 'tool',
      id: 'agent-result',
      toolCalls: [
        {
          request:
            request.role === 'assistant'
              ? request.toolCallRequests![0]
              : (null as never),
          response: {
            status: ToolCallResponseStatus.Success,
            data: {
              type: 'text',
              text: 'Done',
              metadata: {
                cliToolResult: {
                  status: 'completed',
                  agentId: 'agent-1',
                  resolvedModel: 'claude-sonnet',
                  totalToolUseCount: 2,
                  totalDurationMs: 1200,
                  totalTokens: 300,
                },
              },
            },
          },
        },
      ],
    }

    const model = buildCliSubagentReadModel(
      [request, childAssistant, result],
      'claude-code',
    )

    expect(model.visibleMessages.map((message) => message.id)).toEqual([
      'assistant-agent-call',
      'agent-result',
    ])
    expect(model.presentationsByToolCallId.get('agent-call')).toMatchObject({
      title: 'Inspect the runtime',
      taskId: 'agent-1',
      modelName: 'claude-sonnet',
      status: 'success',
      transcript: [childAssistant],
      detailStats: {
        durationMs: 1200,
        toolUseCount: 2,
        totalTokens: 300,
      },
    })
  })

  it('keeps Codex wait in the main timeline while its agent state updates spawnAgent', () => {
    const spawn = assistantRequest({
      id: 'spawn-call',
      runtimeId: 'codex',
      name: 'spawnAgent',
      eventType: 'collabAgentToolCall',
      args: {
        receiverThreadIds: ['child-thread'],
        prompt: 'Review the persistence layer.',
        model: 'gpt-5.6-terra',
      },
    })
    const wait = assistantRequest({
      id: 'wait-call',
      runtimeId: 'codex',
      name: 'wait',
      eventType: 'collabAgentToolCall',
      args: { receiverThreadIds: ['child-thread'] },
    })
    const toolMessage = (
      id: string,
      requestMessage: ChatMessage,
      status: string,
      message: string,
    ): ChatMessage => ({
      role: 'tool',
      id: `${id}-result`,
      toolCalls: [
        {
          request:
            requestMessage.role === 'assistant'
              ? requestMessage.toolCallRequests![0]
              : (null as never),
          response: {
            status: ToolCallResponseStatus.Success,
            data: {
              type: 'text',
              text: '',
              metadata: {
                cliToolResult: {
                  agentsStates: {
                    'child-thread': { status, message },
                  },
                },
              },
            },
          },
        },
      ],
    })

    const messages = [
      spawn,
      toolMessage('spawn', spawn, 'running', 'Checking schemas'),
      wait,
      toolMessage('wait', wait, 'completed', 'Review complete'),
    ]
    const model = buildCliSubagentReadModel(messages, 'codex')

    expect(model.visibleMessages).toEqual(messages)
    expect(model.presentationsByToolCallId.has('wait-call')).toBe(false)
    expect(model.presentationsByToolCallId.get('spawn-call')).toMatchObject({
      taskId: 'child-thread',
      status: 'success',
      subtitle: 'Review complete',
    })
  })
})
