import type { ChatMessage } from '../../types/chat'
import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'

import {
  collectContextPrunedToolCallIds,
  isContextPrunedToolCall,
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

  it('marks pruned calls, except the context control tools', () => {
    const prunedToolCallIds = new Set(['read-1', 'prune-1', 'compact-1'])
    const isPruned = (id: string, name: string) =>
      isContextPrunedToolCall({ id, name }, prunedToolCallIds)

    expect(isPruned('read-1', 'yolo_local__fs_read')).toBe(true)
    expect(isPruned('read-2', 'yolo_local__fs_read')).toBe(false)
    expect(isPruned('prune-1', 'yolo_local__context_prune_tool_results')).toBe(
      false,
    )
    expect(isPruned('compact-1', 'yolo_local__context_compact')).toBe(false)
  })
})
