import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'
import type { ChatMessage } from '../../types/chat'

import { getCompactionSummarySourceMessages } from './compaction'

describe('compaction summary source selection', () => {
  it('keeps the full visible history for manual compaction summaries', () => {
    const emptyArgs = createCompleteToolCallArguments({ value: {} })
    const messages: ChatMessage[] = [
      {
        role: 'user' as const,
        id: 'user-1',
        content: null,
        promptContent: 'old prompt',
        mentionables: [],
      },
      {
        role: 'assistant' as const,
        id: 'assistant-tools',
        content: 'checking files',
        toolCallRequests: [
          {
            id: 'compact-1',
            name: 'yolo_local__context_compact',
            arguments: emptyArgs,
          },
        ],
      },
      {
        role: 'tool' as const,
        id: 'tool-compact',
        toolCalls: [
          {
            request: {
              id: 'compact-1',
              name: 'yolo_local__context_compact',
              arguments: emptyArgs,
            },
            response: {
              status: ToolCallResponseStatus.Success,
              data: {
                type: 'text' as const,
                text: JSON.stringify({
                  tool: 'context_compact',
                  toolCallId: 'compact-1',
                  operation: 'compact_restart',
                }),
              },
            },
          },
        ],
      },
      {
        role: 'assistant' as const,
        id: 'assistant-after',
        content: 'recent answer after compact',
      },
    ]

    expect(
      getCompactionSummarySourceMessages(messages, {
        retainLatestToolBoundary: false,
      }),
    ).toEqual(messages)
  })
})
