import { createCompleteToolCallArguments } from '../../types/tool-call.types'

import { GeminiProvider } from './gemini'

const args = (value: Record<string, unknown>, rawText?: string) =>
  createCompleteToolCallArguments({ value, rawText })

describe('GeminiProvider response parsing', () => {
  it('replays preserved Gemini parts without flattening them', () => {
    const contents = GeminiProvider.buildRequestContents([
      {
        role: 'assistant',
        content: '这段内容应被忽略',
        providerMetadata: {
          gemini: {
            parts: [
              {
                type: 'text',
                text: '',
                thought: true,
                thoughtSignature: 'sig-think',
              },
              {
                type: 'functionCall',
                id: 'call-native-1',
                name: 'yolo_local__fs_edit',
                args: {
                  path: 'note.md',
                  operation: { type: 'append', content: 'hello' },
                },
              },
            ],
          },
        },
        tool_calls: [
          {
            id: 'call-ignored',
            name: 'yolo_local__fs_read',
            arguments: args({ path: 'ignored.md' }),
          },
        ],
      },
    ])

    expect(contents).toEqual([
      {
        role: 'model',
        parts: [
          {
            text: '',
            thought: true,
            thoughtSignature: 'sig-think',
          },
          {
            functionCall: {
              id: 'call-native-1',
              name: 'yolo_local__fs_edit',
              args: {
                path: 'note.md',
                operation: { type: 'append', content: 'hello' },
              },
            },
          },
        ],
      },
    ])
  })

  it('drops empty Gemini text parts during replay', () => {
    const contents = GeminiProvider.buildRequestContents([
      {
        role: 'assistant',
        content: '',
        providerMetadata: {
          gemini: {
            parts: [
              {
                type: 'text',
                text: '',
              },
              {
                type: 'functionCall',
                id: 'call-native-2',
                name: 'yolo_local__fs_read',
                args: { path: 'note.md' },
              },
            ],
          },
        },
      },
    ])

    expect(contents).toEqual([
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call-native-2',
              name: 'yolo_local__fs_read',
              args: { path: 'note.md' },
            },
          },
        ],
      },
    ])
  })

  it('replays assistant tool calls and tool responses as Gemini turns', () => {
    const contents = GeminiProvider.buildRequestContents([
      { role: 'user', content: '帮我读一下 README' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-1',
            name: 'yolo_local__fs_read',
            arguments: args({ path: 'README.md' }),
            metadata: {
              thoughtSignature: 'sig-1',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call: {
          id: 'call-1',
          name: 'yolo_local__fs_read',
          arguments: args({ path: 'README.md' }),
        },
        content: '# README',
      },
    ])

    expect(contents).toEqual([
      {
        role: 'user',
        parts: [{ text: '帮我读一下 README' }],
      },
      {
        role: 'model',
        parts: [
          {
            thoughtSignature: 'sig-1',
            functionCall: {
              id: 'call-1',
              name: 'yolo_local__fs_read',
              args: { path: 'README.md' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-1',
              name: 'yolo_local__fs_read',
              response: { result: '# README' },
            },
          },
        ],
      },
    ])
  })

  it('keeps multiple tool calls in one model turn before grouped responses', () => {
    const contents = GeminiProvider.buildRequestContents([
      {
        role: 'assistant',
        content: '我先检查两个文件',
        tool_calls: [
          {
            id: 'call-1',
            name: 'yolo_local__fs_read',
            arguments: args({ path: 'a.md' }),
            metadata: {
              thoughtSignature: 'sig-a',
            },
          },
          {
            id: 'call-2',
            name: 'yolo_local__fs_read',
            arguments: args({ path: 'b.md' }),
            metadata: {
              thoughtSignature: 'sig-b',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call: {
          id: 'call-1',
          name: 'yolo_local__fs_read',
          arguments: args({ path: 'a.md' }),
        },
        content: 'A',
      },
      {
        role: 'tool',
        tool_call: {
          id: 'call-2',
          name: 'yolo_local__fs_read',
          arguments: args({ path: 'b.md' }),
        },
        content: 'B',
      },
    ])

    expect(contents).toEqual([
      {
        role: 'model',
        parts: [
          { text: '我先检查两个文件' },
          {
            thoughtSignature: 'sig-a',
            functionCall: {
              id: 'call-1',
              name: 'yolo_local__fs_read',
              args: { path: 'a.md' },
            },
          },
          {
            thoughtSignature: 'sig-b',
            functionCall: {
              id: 'call-2',
              name: 'yolo_local__fs_read',
              args: { path: 'b.md' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-1',
              name: 'yolo_local__fs_read',
              response: { result: 'A' },
            },
          },
          {
            functionResponse: {
              id: 'call-2',
              name: 'yolo_local__fs_read',
              response: { result: 'B' },
            },
          },
        ],
      },
    ])
  })

  it('preserves assistant tool-only turns without dropping function calls', () => {
    const contents = GeminiProvider.buildRequestContents([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-3',
            name: 'yolo_local__fs_list',
            arguments: args({ path: '/' }),
            metadata: {
              thoughtSignature: 'sig-tool-only',
            },
          },
        ],
      },
    ])

    expect(contents).toEqual([
      {
        role: 'model',
        parts: [
          {
            thoughtSignature: 'sig-tool-only',
            functionCall: {
              id: 'call-3',
              name: 'yolo_local__fs_list',
              args: { path: '/' },
            },
          },
        ],
      },
    ])
  })

  it('keeps tool calls when finish reason is STOP in non-stream response', () => {
    const parsed = GeminiProvider.parseNonStreamingResponse(
      {
        text: '',
        functionCalls: [
          {
            id: 'fc-1',
            name: 'yolo_local__fs_read',
            args: { path: 'note.md' },
          },
        ],
        candidates: [
          {
            finishReason: 'STOP',
            content: { parts: [] },
          },
        ],
      } as never,
      'gemini-2.5-flash',
      'msg-1',
    )

    expect(parsed.choices[0]?.finish_reason).toBe('STOP')
    expect(parsed.choices[0]?.message.tool_calls?.length).toBe(1)
    expect(parsed.choices[0]?.message.tool_calls?.[0]?.function.name).toBe(
      'yolo_local__fs_read',
    )
    expect(parsed.choices[0]?.message.providerMetadata).toEqual({
      gemini: {
        parts: [
          {
            type: 'functionCall',
            id: 'fc-1',
            name: 'yolo_local__fs_read',
            args: { path: 'note.md' },
          },
        ],
      },
    })
  })

  it('extracts stream tool calls from parts fallback when functionCalls is absent', () => {
    const parsed = GeminiProvider.parseStreamingResponseChunk(
      {
        text: '',
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                {
                  thoughtSignature: 'sig-stream-1',
                  functionCall: {
                    id: 'fc-2',
                    name: 'yolo_local__fs_search',
                    args: { query: 'TODO' },
                  },
                },
              ],
            },
          },
        ],
      } as never,
      'gemini-2.5-flash',
      'msg-2',
    )

    expect(parsed.choices[0]?.delta.tool_calls?.length).toBe(1)
    expect(parsed.choices[0]?.delta.tool_calls?.[0]?.function?.name).toBe(
      'yolo_local__fs_search',
    )
    expect(
      parsed.choices[0]?.delta.tool_calls?.[0]?.metadata?.thoughtSignature,
    ).toBe('sig-stream-1')
  })

  it('attaches thought signature metadata when top-level functionCalls exist', () => {
    const parsed = GeminiProvider.parseNonStreamingResponse(
      {
        text: '',
        functionCalls: [
          {
            id: 'fc-3',
            name: 'yolo_local__fs_list',
            args: { path: '/' },
          },
        ],
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                {
                  thoughtSignature: 'sig-nonstream-1',
                  functionCall: {
                    id: 'fc-3',
                    name: 'yolo_local__fs_list',
                    args: { path: '/' },
                  },
                },
              ],
            },
          },
        ],
      } as never,
      'gemini-2.5-flash',
      'msg-3',
    )

    expect(
      parsed.choices[0]?.message.tool_calls?.[0]?.metadata?.thoughtSignature,
    ).toBe('sig-nonstream-1')
  })

  it('does not access response.text when non-text parts exist in non-stream response', () => {
    const response = {
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              { text: 'done' },
              {
                thoughtSignature: 'sig-nontext',
                functionCall: {
                  id: 'fc-4',
                  name: 'yolo_local__fs_read',
                  args: { path: 'note.md' },
                },
              },
            ],
          },
        },
      ],
    } as never

    Object.defineProperty(response, 'text', {
      get() {
        throw new Error('response.text should not be accessed')
      },
    })

    const parsed = GeminiProvider.parseNonStreamingResponse(
      response,
      'gemini-2.5-flash',
      'msg-4',
    )

    expect(parsed.choices[0]?.message.content).toBe('done')
  })

  it('does not access chunk.text when non-text parts exist in stream response', () => {
    const chunk = {
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              { text: 'partial' },
              {
                thoughtSignature: 'sig-stream-nontext',
                functionCall: {
                  id: 'fc-5',
                  name: 'yolo_local__fs_search',
                  args: { query: 'TODO' },
                },
              },
            ],
          },
        },
      ],
    } as never

    Object.defineProperty(chunk, 'text', {
      get() {
        throw new Error('chunk.text should not be accessed')
      },
    })

    const parsed = GeminiProvider.parseStreamingResponseChunk(
      chunk,
      'gemini-2.5-flash',
      'msg-5',
    )

    expect(parsed.choices[0]?.delta.content).toBe('partial')
  })
})
