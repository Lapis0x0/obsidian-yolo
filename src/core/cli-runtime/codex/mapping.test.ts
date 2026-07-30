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
})
