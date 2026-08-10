import { ToolCallResponseStatus } from '../../../types/tool-call.types'

import {
  mapCodexItem,
  mapCodexTurns,
  shouldEmitCodexItemOnStarted,
} from './mapping'
import type { CodexThreadItem } from './protocol'

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
      {
        role: 'user',
        id: 'codex-user-turn-turn-1',
        promptContent: 'hello',
      },
      { role: 'assistant', content: 'hi' },
    ])
  })

  it('prefers the client-provided user id across realtime and hydration maps', () => {
    const item: CodexThreadItem = {
      type: 'userMessage' as const,
      id: 'ephemeral-item-id',
      clientId: 'yolo-message-id',
      content: [{ type: 'text' as const, text: 'hello', text_elements: [] }],
    }

    expect(mapCodexItem(item, undefined, 'turn-live')[0]).toMatchObject({
      id: 'codex-user-client-yolo-message-id',
    })
    expect(
      mapCodexTurns([
        {
          id: 'turn-reloaded',
          status: 'completed',
          error: null,
          items: [{ ...item, id: 'different-item-id' }],
        },
      ])[0],
    ).toMatchObject({ id: 'codex-user-client-yolo-message-id' })
  })

  it('skips empty agent and reasoning shells on item/started', () => {
    expect(
      shouldEmitCodexItemOnStarted({
        type: 'agentMessage',
        id: 'agent-empty',
        text: '',
      }),
    ).toBe(false)
    expect(
      shouldEmitCodexItemOnStarted({
        type: 'agentMessage',
        id: 'agent-ready',
        text: 'hi',
      }),
    ).toBe(true)
    expect(
      shouldEmitCodexItemOnStarted({
        type: 'reasoning',
        id: 'reasoning-empty',
        summary: [],
        content: [],
      }),
    ).toBe(false)
    expect(
      shouldEmitCodexItemOnStarted({
        type: 'reasoning',
        id: 'reasoning-ready',
        summary: ['thinking'],
        content: [],
      }),
    ).toBe(true)
    expect(
      shouldEmitCodexItemOnStarted({
        type: 'commandExecution',
        id: 'command-1',
        command: 'pwd',
        cwd: '/vault',
        status: 'inProgress',
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      }),
    ).toBe(true)
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
      toolCallRequests: [
        {
          id: 'command-1',
          name: 'commandExecution',
          metadata: {
            cliToolCall: {
              runtimeId: 'codex',
              eventType: 'commandExecution',
              name: 'commandExecution',
              capability: 'command_execution',
            },
          },
        },
      ],
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

  it('keeps MCP server and tool identity separate and unwraps text results', () => {
    const messages = mapCodexItem({
      type: 'mcpToolCall',
      id: 'mcp-1',
      server: 'codex',
      tool: 'list_mcp_resources',
      status: 'completed',
      arguments: {},
      result: {
        content: [{ type: 'text', text: '{"resources":[]}' }],
        structuredContent: null,
        _meta: null,
      },
      error: null,
    })

    expect(messages[0]).toMatchObject({
      role: 'assistant',
      toolCallRequests: [
        {
          name: 'list_mcp_resources',
          metadata: {
            cliToolCall: {
              runtimeId: 'codex',
              eventType: 'mcpToolCall',
              namespace: 'codex',
              name: 'list_mcp_resources',
            },
          },
        },
      ],
    })
    expect(messages[1]).toMatchObject({
      role: 'tool',
      toolCalls: [{ response: { data: { text: '{"resources":[]}' } } }],
    })
  })

  it('maps previously unsupported dynamic tools through the generic path', () => {
    const messages = mapCodexItem({
      type: 'dynamicToolCall',
      id: 'dynamic-1',
      namespace: 'workspace',
      tool: 'get_goal',
      arguments: { verbose: false },
      status: 'completed',
      contentItems: [{ type: 'inputText', text: 'No active goal' }],
      success: true,
    })

    expect(messages).toMatchObject([
      {
        role: 'assistant',
        toolCallRequests: [
          {
            name: 'get_goal',
            metadata: {
              cliToolCall: {
                namespace: 'workspace',
                eventType: 'dynamicToolCall',
              },
            },
          },
        ],
      },
      {
        role: 'tool',
        toolCalls: [{ response: { data: { text: 'No active goal' } } }],
      },
    ])
  })

  it('keeps unknown timeline items visible instead of dropping them', () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const messages = mapCodexItem({
      type: 'futureActivity',
      id: 'future-1',
      detail: { value: 1 },
    } as unknown as CodexThreadItem)

    expect(messages).toMatchObject([
      {
        role: 'assistant',
        id: 'codex-activity-future-1',
        content: expect.stringContaining('"type": "futureActivity"'),
      },
    ])
    expect(warning).toHaveBeenCalledWith(
      '[YOLO] Unadapted Codex timeline item: futureActivity',
    )
    warning.mockRestore()
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
