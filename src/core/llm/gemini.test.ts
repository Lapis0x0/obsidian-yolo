import { GeminiProvider } from './gemini'

describe('GeminiProvider response parsing', () => {
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
  })
})
