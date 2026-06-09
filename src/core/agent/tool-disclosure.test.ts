import type { ChatMessage } from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { extractLoadedDeferredToolNames } from './tool-disclosure'

describe('tool disclosure state', () => {
  it('extracts loaded tool names from load_tool_schemas results', () => {
    const messages: ChatMessage[] = [
      {
        role: 'tool',
        id: 'tool-1',
        toolCalls: [
          {
            request: {
              id: 'call-1',
              name: 'yolo_local__load_tool_schemas',
            },
            response: {
              status: ToolCallResponseStatus.Success,
              data: {
                type: 'text',
                text: JSON.stringify({
                  tool: 'load_tool_schemas',
                  loadedToolNames: ['server__tool_a'],
                }),
              },
            },
          },
        ],
      },
    ]

    expect([...extractLoadedDeferredToolNames({ messages })]).toEqual([
      'server__tool_a',
    ])
  })

  it('carries loaded tool names from compaction metadata', () => {
    expect([
      ...extractLoadedDeferredToolNames({
        messages: [],
        compaction: {
          anchorMessageId: 'a1',
          summary: 'summary',
          compactedAt: 1,
          loadedDeferredToolNames: ['server__tool_a'],
        },
      }),
    ]).toEqual(['server__tool_a'])
  })
})
