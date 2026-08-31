import type { SDKMessage } from '@yolo/claude-agent-sdk-runtime'

import { ClaudeTurnMapper } from './messageMapping'

const mapper = () => new ClaudeTurnMapper('id', 'sonnet')

const textDelta = (text: string): SDKMessage =>
  ({
    type: 'stream_event',
    parent_tool_use_id: null,
    uuid: 'u',
    session_id: 's',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    },
  }) as unknown as SDKMessage

const assistant = (
  content: unknown[],
  parentToolUseId: string | null = null,
  usage: Record<string, number> = {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 3,
  },
): SDKMessage =>
  ({
    type: 'assistant',
    parent_tool_use_id: parentToolUseId,
    uuid: 'assistant-uuid',
    session_id: 's',
    message: { content, usage },
  }) as unknown as SDKMessage

const toolResult = (
  toolUseId: string,
  content: string,
  isError = false,
): SDKMessage =>
  ({
    type: 'user',
    parent_tool_use_id: null,
    uuid: 'user-uuid',
    session_id: 's',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          is_error: isError,
        },
      ],
    },
  }) as unknown as SDKMessage

const result = (): SDKMessage =>
  ({
    type: 'result',
    subtype: 'success',
    uuid: 'result-uuid',
    session_id: 'session-abc',
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 3,
    },
  }) as unknown as SDKMessage

describe('ClaudeTurnMapper', () => {
  it('streams text deltas as content', () => {
    const m = mapper()
    expect(m.map(textDelta('hel'))?.choices[0].delta.content).toBe('hel')
    expect(m.map(textDelta('lo'))?.choices[0].delta.content).toBe('lo')
  })

  it('drops the complete assistant text once deltas have streamed', () => {
    const m = mapper()
    m.map(textDelta('hello'))
    expect(m.map(assistant([{ type: 'text', text: 'hello' }]))).toBeNull()
  })

  it('keeps the complete assistant text when no deltas arrived', () => {
    const m = mapper()
    expect(
      m.map(assistant([{ type: 'text', text: 'hello' }]))?.choices[0].delta
        .content,
    ).toBe('hello')
  })

  it('ignores subagent streams', () => {
    const m = mapper()
    expect(m.map(assistant([{ type: 'text', text: 'nested' }], 'tool-1'))).toBe(
      null,
    )
  })

  it('reports tool calls as receipts, never as tool_calls', () => {
    const m = mapper()
    const chunk = m.map(
      assistant([
        { type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a.md' } },
      ]),
    )
    expect(chunk?.choices[0].delta.tool_calls).toBeUndefined()
    expect(chunk?.choices[0].delta.providerToolRun).toEqual([
      { id: 't1', name: 'Read', input: { file: 'a.md' }, status: 'running' },
    ])
  })

  it('keeps the text that precedes a run on the chunk that opens it', () => {
    // The split downstream seals the message on this chunk, so text arriving
    // with the run has to land before the cards rather than after them.
    const m = mapper()
    const chunk = m.map(
      assistant([
        { type: 'text', text: 'let me check' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
      ]),
    )
    expect(chunk?.choices[0].delta.content).toBe('let me check')
    expect(chunk?.choices[0].delta.providerToolRun).toHaveLength(1)
  })

  it('opens a separate run per assistant message', () => {
    const m = mapper()
    const first = m.map(
      assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
    )
    const second = m.map(
      assistant([{ type: 'tool_use', id: 't2', name: 'Grep', input: {} }]),
    )
    expect(first?.choices[0].delta.providerToolRun?.map((c) => c.id)).toEqual([
      't1',
    ])
    expect(second?.choices[0].delta.providerToolRun?.map((c) => c.id)).toEqual([
      't2',
    ])
  })

  it('groups parallel calls into one run and completes them in place', () => {
    const m = mapper()
    m.map(
      assistant([
        { type: 'tool_use', id: 't1', name: 'Read', input: {} },
        { type: 'tool_use', id: 't2', name: 'Grep', input: {} },
      ]),
    )
    const chunk = m.map(toolResult('t1', 'file contents'))
    const run = chunk?.choices[0].delta.providerToolRun
    expect(run).toHaveLength(2)
    expect(run?.[0]).toMatchObject({
      id: 't1',
      status: 'success',
      resultText: 'file contents',
    })
    expect(run?.[1]).toMatchObject({ id: 't2', status: 'running' })
  })

  it('completes a call in the run it belongs to, not the latest one', () => {
    const m = mapper()
    m.map(assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]))
    m.map(assistant([{ type: 'tool_use', id: 't2', name: 'Grep', input: {} }]))
    const chunk = m.map(toolResult('t1', 'file contents'))
    expect(chunk?.choices[0].delta.providerToolRun).toEqual([
      {
        id: 't1',
        name: 'Read',
        input: {},
        status: 'success',
        resultText: 'file contents',
      },
    ])
  })

  it('marks a failed tool result as an error', () => {
    const m = mapper()
    m.map(assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]))
    const chunk = m.map(toolResult('t1', 'boom', true))
    expect(chunk?.choices[0].delta.providerToolRun?.[0].status).toBe('error')
  })

  it('records the session, anchor and finish reason from the result', () => {
    const m = mapper()
    const chunk = m.map(result())
    expect(m.observation.sessionId).toBe('session-abc')
    expect(m.observation.lastUuid).toBe('result-uuid')
    expect(m.observation.finishReason).toBe('end_turn')
    expect(chunk?.choices[0].finish_reason).toBe('end_turn')
  })

  it('reports usage per API call, not the run total', () => {
    // The result carries the run's total. Reporting that as the turn's usage
    // would make "context used" read as the sum of every step's input rather
    // than the size of the context the last step actually sent.
    const m = mapper()
    const first = m.map(
      assistant(
        [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
        null,
        {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 0,
        },
      ),
    )
    const second = m.map(
      assistant([{ type: 'text', text: 'done' }], null, {
        input_tokens: 20,
        output_tokens: 7,
        cache_read_input_tokens: 90,
      }),
    )
    expect(first?.usage).toMatchObject({
      prompt_tokens: 100,
      completion_tokens: 10,
    })
    expect(second?.usage).toMatchObject({
      prompt_tokens: 110,
      completion_tokens: 7,
      cache_read_input_tokens: 90,
    })
    expect(m.map(result())?.usage).toBeUndefined()
  })

  it('anchors on the last transcript entry the turn produced', () => {
    const m = mapper()
    m.map(assistant([{ type: 'text', text: 'a' }]))
    expect(m.observation.lastUuid).toBe('assistant-uuid')
  })
})
