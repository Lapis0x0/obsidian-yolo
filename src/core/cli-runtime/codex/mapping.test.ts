import { ToolCallResponseStatus } from '../../../types/tool-call.types'

import { mapCodexItem, mapCodexTurns } from './mapping'

describe('Codex message mapping', () => {
  it('hydrates native user and assistant items into YOLO messages', () => {
    const messages = mapCodexTurns([
      {
        id: 'turn-1',
        status: 'completed',
        error: null,
        items: [
          {
            type: 'userMessage',
            id: 'user-1',
            content: [{ type: 'text', text: 'hello', text_elements: [] }],
          },
          { type: 'agentMessage', id: 'agent-1', text: 'hi' },
        ],
      },
    ])

    expect(messages).toMatchObject([
      { role: 'user', promptContent: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])
  })

  it('maps command execution into a reusable tool request/result pair', () => {
    const messages = mapCodexItem({
      type: 'commandExecution',
      id: 'command-1',
      command: 'pwd',
      cwd: '/vault',
      status: 'completed',
      aggregatedOutput: '/vault',
      exitCode: 0,
      durationMs: 1,
    })

    expect(messages[0]).toMatchObject({
      role: 'assistant',
      toolCallRequests: [{ id: 'command-1', name: 'codex_command_execution' }],
    })
    expect(messages[1]).toMatchObject({
      role: 'tool',
      toolCalls: [
        {
          response: {
            status: ToolCallResponseStatus.Success,
            data: { text: '/vault' },
          },
        },
      ],
    })
  })

  it('maps native file changes into the shared edit summary metadata', () => {
    const messages = mapCodexItem(
      {
        type: 'fileChange',
        id: 'patch-1',
        status: 'completed',
        changes: [
          {
            path: '/vault/src/a.ts',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1 +1,2 @@\n-old\n+new\n+added',
          },
          {
            path: '/vault/src/b.ts',
            kind: { type: 'add' },
            diff: '@@ -0,0 +1 @@\n+created',
          },
        ],
      },
      '/vault',
    )

    expect(messages[1]).toMatchObject({
      role: 'tool',
      toolCalls: [
        {
          response: {
            status: ToolCallResponseStatus.Success,
            data: {
              metadata: {
                editSummary: {
                  totalFiles: 2,
                  totalAddedLines: 3,
                  totalRemovedLines: 1,
                  files: [
                    { path: 'src/a.ts', operation: 'edit' },
                    { path: 'src/b.ts', operation: 'create' },
                  ],
                },
              },
            },
          },
        },
      ],
    })
  })
})
