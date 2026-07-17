import type {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
  ChatSubagentResultMessage,
  ChatTerminalCommandResultMessage,
  ChatToolMessage,
} from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import { buildChatTimelineItems, buildMessageTimelineItems } from './timeline'

const makeAssistantMessage = (id: string): ChatAssistantMessage => ({
  role: 'assistant',
  id,
  content: id,
  metadata: { generationState: 'completed' },
})

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

describe('buildChatTimelineItems', () => {
  it('keeps the logical group id when creating the default render slice', () => {
    const assistant = makeAssistantMessage('assistant-1')

    const items = buildChatTimelineItems({
      groupedChatMessages: [[assistant]],
      compactionDividerAnchorMessageIds: [],
      latestCompaction: null,
    })
    const assistantItem = items.find((item) => item.kind === 'assistant-group')

    expect(assistantItem).toMatchObject({
      groupId: assistant.id,
      renderKey: `${assistant.id}-slice-0`,
      messageIds: [assistant.id],
    })
  })

  it('shares one logical group id across compaction render slices', () => {
    const firstAssistant = makeAssistantMessage('assistant-1')
    const tool = makeToolMessage({
      id: 'tool-1',
      toolCallCount: 1,
      responseText: 'ok',
    })
    const secondAssistant = makeAssistantMessage('assistant-2')

    const items = buildChatTimelineItems({
      groupedChatMessages: [[firstAssistant, tool, secondAssistant]],
      compactionDividerAnchorMessageIds: [tool.id],
      latestCompaction: null,
    })
    const assistantItems = items.filter(
      (item) => item.kind === 'assistant-group',
    )

    expect(assistantItems).toHaveLength(2)
    expect(assistantItems.map((item) => item.groupId)).toEqual([
      firstAssistant.id,
      firstAssistant.id,
    ])
    expect(assistantItems.map((item) => item.renderKey)).toEqual([
      `${firstAssistant.id}-slice-0`,
      `${firstAssistant.id}-slice-1`,
    ])
  })
})
