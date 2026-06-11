import type {
  AssistantToolMessageGroup,
  ChatSubagentResultMessage,
  ChatTerminalCommandResultMessage,
  ChatToolMessage,
} from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import { buildMessageTimelineItems } from './timeline'

function makeToolMessage({
  id,
  toolCallCount,
  responseText,
}: {
  id: string
  toolCallCount: number
  responseText: string
}): ChatToolMessage {
  return {
    role: 'tool',
    id,
    toolCalls: Array.from({ length: toolCallCount }, (_, index) => ({
      request: {
        id: `${id}-call-${index}`,
        name: 'Bash',
        arguments: {
          kind: 'complete',
          value: { command: `echo ${index}` },
        },
      },
      response: {
        status: ToolCallResponseStatus.Success,
        data: {
          type: 'text',
          text: responseText,
        },
      },
    })),
  }
}

function getAssistantGroupEstimate(group: AssistantToolMessageGroup): number {
  const item = buildMessageTimelineItems({
    groupedChatMessages: [group],
  })[0]

  if (!item || item.kind !== 'assistant-group') {
    throw new Error('Expected assistant-group timeline item')
  }

  return item.estimatedHeight
}

describe('buildMessageTimelineItems', () => {
  it('hides standalone background tool result messages from the visible timeline', () => {
    const source = {
      type: 'llm_tool_call' as const,
      toolCallId: 'tool-call-1',
      assistantMessageId: 'assistant-1',
    }
    const subagentResult: ChatSubagentResultMessage = {
      role: 'subagent_result',
      id: 'subagent-result-1',
      taskId: 'subagent-task-1',
      source,
      title: 'Inspect code',
      status: 'completed',
      content: 'Done',
      durationMs: 1000,
      toolUseCount: 1,
      delegateAssistantMessageId: 'assistant-1',
      delegateToolCallId: 'tool-call-1',
    }
    const terminalCommandResult: ChatTerminalCommandResultMessage = {
      role: 'terminal_command_result',
      id: 'terminal-result-1',
      taskId: 'terminal-task-1',
      source,
      title: 'npm test',
      status: 'completed',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      durationMs: 1000,
      delegateAssistantMessageId: 'assistant-1',
      delegateToolCallId: 'tool-call-1',
    }

    const items = buildMessageTimelineItems({
      groupedChatMessages: [[subagentResult], [terminalCommandResult]],
    })

    expect(items).toEqual([])
  })

  it('estimates collapsed tool cards by count instead of response payload size', () => {
    const smallPayloadEstimate = getAssistantGroupEstimate([
      makeToolMessage({
        id: 'small-tool',
        toolCallCount: 12,
        responseText: 'ok',
      }),
    ])
    const largePayloadEstimate = getAssistantGroupEstimate([
      makeToolMessage({
        id: 'large-tool',
        toolCallCount: 12,
        responseText: 'x'.repeat(80_000),
      }),
    ])

    expect(largePayloadEstimate).toBe(smallPayloadEstimate)
    expect(largePayloadEstimate).toBeLessThan(1000)
  })
})
