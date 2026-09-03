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

  it('counts a tool as disclosed only while its schema survives in the compaction registry', () => {
    const compaction = {
      anchorMessageId: 'a1',
      summary: 'summary',
      compactedAt: 1,
    }
    expect([
      ...extractLoadedDeferredToolNames({
        messages: [],
        compaction: {
          ...compaction,
          loadedDeferredToolSchemas: [
            {
              name: 'server__tool_a',
              description: '',
              parameters: { type: 'object' },
            },
          ],
        },
      }),
    ]).toEqual(['server__tool_a'])

    // Oversized schemas are dropped by compaction; the tool must be
    // re-disclosed rather than counted as still loaded.
    expect([
      ...extractLoadedDeferredToolNames({ messages: [], compaction }),
    ]).toEqual([])
  })
})
