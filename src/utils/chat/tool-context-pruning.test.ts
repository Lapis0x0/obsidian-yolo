import type { ChatMessage } from '../../types/chat'
import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'

import {
  collectContextPrunedToolCallIds,
  filterContextPrunedAssistantToolCalls,
  filterContextPrunedToolCalls,
} from './tool-context-pruning'

const emptyArgs = createCompleteToolCallArguments({ value: {} })

describe('tool context pruning', () => {
  it('collects pruned tool call ids from successful context prune tool results', () => {
    const messages: ChatMessage[] = [
      {
        role: 'tool',
        id: 'tool-message-1',
        toolCalls: [
          {
            request: {
              id: 'prune-call',
              name: 'yolo_local__context_prune_tool_results',
              arguments: emptyArgs,
            },
            response: {
              status: ToolCallResponseStatus.Success,
              data: {
                type: 'text',
                text: JSON.stringify({
                  acceptedToolCallIds: [' read-1 ', 'read-2', 'read-1'],
                }),
              },
            },
          },
        ],
      },
    ]

    expect([...collectContextPrunedToolCallIds(messages)]).toEqual([
      'read-1',
      'read-2',
    ])
  })

  it('filters only fs_read tool calls from assistant and tool messages', () => {
    const prunedToolCallIds = new Set(['read-1', 'edit-1'])

    expect(
      filterContextPrunedAssistantToolCalls(
        [
          {
            id: 'read-1',
            name: 'yolo_local__fs_read',
            arguments: emptyArgs,
          },
          {
            id: 'edit-1',
            name: 'yolo_local__fs_edit',
            arguments: emptyArgs,
          },
        ],
        prunedToolCallIds,
      ),
    ).toEqual([
      {
        id: 'edit-1',
        name: 'yolo_local__fs_edit',
        arguments: emptyArgs,
      },
    ])

    expect(
      filterContextPrunedToolCalls(
        [
          {
            request: {
              id: 'read-1',
              name: 'yolo_local__fs_read',
              arguments: emptyArgs,
            },
            response: {
              status: ToolCallResponseStatus.Success,
              data: { type: 'text', text: '{}' },
            },
          },
          {
            request: {
              id: 'edit-1',
              name: 'yolo_local__fs_edit',
              arguments: emptyArgs,
            },
            response: {
              status: ToolCallResponseStatus.Success,
              data: { type: 'text', text: '{}' },
            },
          },
        ],
        prunedToolCallIds,
      ),
    ).toHaveLength(1)
  })
})
