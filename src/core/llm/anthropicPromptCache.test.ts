import { applyAnthropicPromptCache } from './anthropicPromptCache'

type Payload = Parameters<typeof applyAnthropicPromptCache>[0] & {
  system?: unknown
  tools?: unknown
}

const EPHEMERAL = { type: 'ephemeral' }

describe('applyAnthropicPromptCache', () => {
  it('wraps string system into a text block with cache_control', () => {
    const out = applyAnthropicPromptCache({
      system: 'hello',
      messages: [],
    } as unknown as Payload) as unknown as {
      system: Array<Record<string, unknown>>
    }
    expect(out.system).toEqual([
      { type: 'text', text: 'hello', cache_control: EPHEMERAL },
    ])
  })

  it('keeps empty string system untouched', () => {
    const out = applyAnthropicPromptCache({
      system: '',
      messages: [],
    } as unknown as Payload) as unknown as { system: string }
    expect(out.system).toBe('')
  })

  it('adds cache_control to last tool only', () => {
    const out = applyAnthropicPromptCache({
      tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      messages: [],
    } as unknown as Payload) as unknown as {
      tools: Array<Record<string, unknown>>
    }
    expect(out.tools[0]).toEqual({ name: 'a' })
    expect(out.tools[1]).toEqual({ name: 'b' })
    expect(out.tools[2]).toEqual({ name: 'c', cache_control: EPHEMERAL })
  })

  it('adds breakpoints to last two messages (string content)', () => {
    const out = applyAnthropicPromptCache({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
        { role: 'user', content: 'third' },
      ],
    } as unknown as Payload) as unknown as {
      messages: Array<{ role: string; content: unknown }>
    }
    expect(out.messages[0].content).toBe('first')
    expect(out.messages[1].content).toEqual([
      { type: 'text', text: 'second', cache_control: EPHEMERAL },
    ])
    expect(out.messages[2].content).toEqual([
      { type: 'text', text: 'third', cache_control: EPHEMERAL },
    ])
  })

  it('adds cache_control to last content block of array-content messages', () => {
    const out = applyAnthropicPromptCache({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'thinking' },
            { type: 'tool_use', id: 't1', name: 'fn', input: {} },
          ],
        },
      ],
    } as unknown as Payload) as unknown as {
      messages: Array<{ content: Array<Record<string, unknown>> }>
    }
    expect(out.messages[0].content[0]).toEqual({ type: 'text', text: 'a' })
    expect(out.messages[0].content[1]).toEqual({
      type: 'text',
      text: 'b',
      cache_control: EPHEMERAL,
    })
    expect(out.messages[1].content[0]).toEqual({
      type: 'text',
      text: 'thinking',
    })
    expect(out.messages[1].content[1]).toEqual({
      type: 'tool_use',
      id: 't1',
      name: 'fn',
      input: {},
      cache_control: EPHEMERAL,
    })
  })

  it('only adds one breakpoint when there is a single message', () => {
    const out = applyAnthropicPromptCache({
      messages: [{ role: 'user', content: 'only' }],
    } as unknown as Payload) as unknown as {
      messages: Array<{ content: unknown }>
    }
    expect(out.messages[0].content).toEqual([
      { type: 'text', text: 'only', cache_control: EPHEMERAL },
    ])
  })

  it('handles empty messages array without throwing', () => {
    const out = applyAnthropicPromptCache({
      messages: [],
    } as unknown as Payload) as unknown as { messages: unknown[] }
    expect(out.messages).toEqual([])
  })

  it('never exceeds 4 cache_control breakpoints in total', () => {
    const payload = {
      system: 'sys',
      tools: [{ name: 'a' }, { name: 'b' }],
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
      ],
    } as unknown as Payload
    const out = applyAnthropicPromptCache(payload)
    const json = JSON.stringify(out)
    const occurrences = (
      json.match(/"cache_control":\{"type":"ephemeral"\}/g) ?? []
    ).length
    expect(occurrences).toBeLessThanOrEqual(4)
    expect(occurrences).toBe(4)
  })

  it('does not mutate input payload', () => {
    const input = {
      system: 'sys',
      tools: [{ name: 'a' }],
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'user', content: 'u2' },
      ],
    } as unknown as Payload
    const snapshot = JSON.parse(JSON.stringify(input))
    applyAnthropicPromptCache(input)
    expect(input).toEqual(snapshot)
  })
})
