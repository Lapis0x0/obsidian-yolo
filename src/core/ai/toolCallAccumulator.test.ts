import { getToolCallArgumentsObject } from '../../types/tool-call.types'

import {
  ToolCallAccumulator,
  createCanonicalToolEventsFromDeltas,
} from './toolCallAccumulator'

describe('ToolCallAccumulator', () => {
  it('keeps nested object openings when later chunks begin with "{\\"', () => {
    const accumulator = new ToolCallAccumulator('turn-1')

    accumulator.applyAll(
      createCanonicalToolEventsFromDeltas({
        turnKey: 'turn-1',
        provider: 'openai-chat',
        receivedAt: 1,
        deltas: [
          {
            index: 0,
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'yolo_local__fs_read',
              arguments: '{"paths":["foo.md"],"operation":',
            },
          },
        ],
      }),
    )

    expect(accumulator.getSnapshots()[0]?.function?.arguments).toMatchObject({
      kind: 'partial',
      rawText: '{"paths":["foo.md"],"operation":',
    })

    accumulator.applyAll(
      createCanonicalToolEventsFromDeltas({
        turnKey: 'turn-1',
        provider: 'openai-chat',
        receivedAt: 2,
        deltas: [
          {
            index: 0,
            function: {
              arguments: '{"type":"lines","startLine":1,"endLine":80}}',
            },
          },
        ],
      }),
    )

    accumulator.sealOpenCalls('stream_end', 3)
    accumulator.handoff('stream_end', 4)

    const snapshot = accumulator.getSnapshots()[0]

    expect(snapshot?.parseState).toBe('valid')
    expect(snapshot?.handoffReady).toBe(true)
    expect(getToolCallArgumentsObject(snapshot?.function?.arguments)).toEqual({
      paths: ['foo.md'],
      operation: {
        type: 'lines',
        startLine: 1,
        endLine: 80,
      },
    })
  })

  it('does not expose authoritative complete arguments before seal', () => {
    const accumulator = new ToolCallAccumulator('turn-2')

    accumulator.applyAll(
      createCanonicalToolEventsFromDeltas({
        turnKey: 'turn-2',
        provider: 'openai-chat',
        receivedAt: 1,
        deltas: [
          {
            index: 0,
            function: {
              name: 'tool',
              arguments: '{"path":"a.md"}',
            },
          },
        ],
      }),
    )

    const snapshot = accumulator.getSnapshots()[0]

    expect(snapshot?.parseState).toBe('not_attempted')
    expect(snapshot?.handoffReady).toBe(false)
    expect(snapshot?.function?.arguments).toMatchObject({
      kind: 'partial',
      rawText: '{"path":"a.md"}',
    })
  })
})
