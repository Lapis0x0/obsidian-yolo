import { ToolCallResponseStatus } from '../../../types/tool-call.types'

import {
  parseCodexSessionContent,
  parseCodexSessionTranscript,
} from './history'

const record = (type: string, payload: Record<string, unknown>): string =>
  JSON.stringify({ timestamp: '2026-08-02T00:00:00.000Z', type, payload })

describe('Codex JSONL history', () => {
  it('rebuilds visible messages and raw custom tool calls in transcript order', () => {
    const messages = parseCodexSessionContent(
      [
        record('event_msg', {
          type: 'task_started',
          turn_id: 'turn-1',
        }),
        record('response_item', {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'hidden instructions' }],
        }),
        record('event_msg', {
          type: 'user_message',
          client_id: 'client-user-1',
          message: 'inspect the vault',
        }),
        record('response_item', {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'I should inspect it.' }],
          content: [],
        }),
        record('response_item', {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I will inspect it.' }],
        }),
        record('response_item', {
          type: 'custom_tool_call',
          status: 'completed',
          call_id: 'call-exec',
          name: 'exec',
          input:
            'const result = await tools.exec_command({cmd: "pwd"}); text(result);',
        }),
        record('response_item', {
          type: 'custom_tool_call_output',
          call_id: 'call-exec',
          output: [{ type: 'input_text', text: 'hello' }],
        }),
        record('response_item', {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Done.' }],
        }),
        record('event_msg', { type: 'task_complete', turn_id: 'turn-1' }),
      ].join('\n'),
    )

    expect(messages).toMatchObject([
      {
        role: 'user',
        id: 'codex-user-client-client-user-1',
        promptContent: 'inspect the vault',
      },
      { role: 'assistant', reasoning: 'I should inspect it.' },
      { role: 'assistant', content: 'I will inspect it.' },
      {
        role: 'assistant',
        toolCallRequests: [
          {
            id: 'call-exec',
            name: 'exec_command',
            metadata: {
              cliToolCall: {
                runtimeId: 'codex',
                eventType: 'custom_tool_call',
                name: 'exec_command',
                capability: 'command_execution',
              },
            },
          },
        ],
      },
      {
        role: 'tool',
        toolCalls: [
          {
            response: {
              status: ToolCallResponseStatus.Success,
              data: { type: 'text', text: 'hello' },
            },
          },
        ],
      },
      { role: 'assistant', content: 'Done.' },
    ])
  })

  it('restores JSON function calls and ignores malformed transcript lines', () => {
    const messages = parseCodexSessionContent(
      [
        '{broken',
        record('event_msg', {
          type: 'task_started',
          turn_id: 'turn-2',
        }),
        record('event_msg', {
          type: 'user_message',
          message: 'run it',
        }),
        record('response_item', {
          type: 'function_call',
          call_id: 'call-function',
          name: 'exec_command',
          arguments: '{"cmd":"pwd"}',
        }),
        record('response_item', {
          type: 'function_call_output',
          call_id: 'call-function',
          output: '/vault',
        }),
      ].join('\n'),
    )

    expect(messages).toMatchObject([
      { role: 'user', id: 'codex-user-turn-turn-2' },
      {
        role: 'assistant',
        toolCallRequests: [
          {
            name: 'exec_command',
            arguments: { value: { command: 'pwd' } },
          },
        ],
      },
      {
        role: 'tool',
        toolCalls: [{ response: { data: { text: '/vault' } } }],
      },
    ])
  })

  it('removes Codex control metadata from persisted user text', () => {
    const messages = parseCodexSessionContent(
      record('event_msg', {
        type: 'user_message',
        message:
          '<recommended_plugins>plugins</recommended_plugins>\n# AGENTS.md instructions for /vault\n<INSTRUCTIONS>rules</INSTRUCTIONS>\nactual request',
      }),
    )

    expect(messages).toMatchObject([
      { role: 'user', promptContent: 'actual request' },
    ])
  })

  it('restores every native compaction as an ordered boundary, not a message', () => {
    const transcript = parseCodexSessionTranscript(
      [
        record('event_msg', { type: 'user_message', message: 'First' }),
        record('response_item', {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'First answer' }],
        }),
        record('compacted', { message: 'hidden summary' }),
        record('event_msg', { type: 'context_compacted' }),
        record('event_msg', { type: 'user_message', message: 'Second' }),
        record('response_item', {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Second answer' }],
        }),
        record('event_msg', { type: 'context_compacted' }),
      ].join('\n'),
    )

    expect(transcript.messages).toHaveLength(4)
    expect(transcript.messages).not.toContainEqual(
      expect.objectContaining({ content: '' }),
    )
    expect(transcript.compactionBoundaries).toEqual([
      {
        id: 'codex-compact-history-3',
        afterMessageId: 'codex-history-assistant-1',
      },
      {
        id: 'codex-compact-history-6',
        afterMessageId: 'codex-history-assistant-5',
      },
    ])
  })
})
