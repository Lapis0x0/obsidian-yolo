import {
  resolveCopilotEndpointFromPath,
  resolveCopilotRequestTraits,
} from './copilotRequestTraits'

const traits = (
  endpoint: Parameters<typeof resolveCopilotRequestTraits>[0],
  body: unknown,
) => resolveCopilotRequestTraits(endpoint, JSON.stringify(body))

describe('resolveCopilotEndpointFromPath', () => {
  it.each([
    ['/chat/completions', 'chat'],
    ['/v1/chat/completions', 'chat'],
    ['/responses', 'responses'],
    ['/v1/messages', 'messages'],
    ['/v1/messages/', 'messages'],
    ['/models', null],
  ])('maps %s to %s', (path, endpoint) => {
    expect(resolveCopilotEndpointFromPath(path)).toBe(endpoint)
  })
})

describe('resolveCopilotRequestTraits', () => {
  describe('chat completions', () => {
    it('treats a trailing user message as a user turn', () => {
      expect(
        traits('chat', {
          messages: [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hi' },
          ],
        }),
      ).toEqual({ initiator: 'user', hasImage: false })
    })

    it('treats a trailing tool result as an agent turn', () => {
      expect(
        traits('chat', {
          messages: [
            { role: 'user', content: 'read a.md' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
            { role: 'tool', tool_call_id: 'c1', content: 'file body' },
          ],
        }).initiator,
      ).toBe('agent')
    })

    it('sees an image anywhere in the history', () => {
      expect(
        traits('chat', {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'what is this' },
                { type: 'image_url', image_url: { url: 'data:...' } },
              ],
            },
            { role: 'assistant', content: 'a cat' },
            { role: 'user', content: 'thanks' },
          ],
        }),
      ).toEqual({ initiator: 'user', hasImage: true })
    })
  })

  describe('responses', () => {
    it('treats a string input as a user turn', () => {
      expect(traits('responses', { input: 'hi' })).toEqual({
        initiator: 'user',
        hasImage: false,
      })
    })

    it('treats a trailing user message as a user turn', () => {
      expect(
        traits('responses', {
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'hi' }],
            },
          ],
        }).initiator,
      ).toBe('user')
    })

    it('treats a trailing function_call_output as an agent turn', () => {
      expect(
        traits('responses', {
          input: [
            { type: 'message', role: 'user', content: 'read a.md' },
            { type: 'function_call', call_id: 'c1', name: 'read' },
            { type: 'function_call_output', call_id: 'c1', output: 'body' },
          ],
        }).initiator,
      ).toBe('agent')
    })

    it('sees an input_image in a message', () => {
      expect(
        traits('responses', {
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_image', image_url: 'data:...' }],
            },
          ],
        }).hasImage,
      ).toBe(true)
    })
  })

  describe('anthropic messages', () => {
    it('treats a trailing user text as a user turn', () => {
      expect(
        traits('messages', { messages: [{ role: 'user', content: 'hi' }] }),
      ).toEqual({ initiator: 'user', hasImage: false })
    })

    it('treats a user message of only tool_result blocks as an agent turn', () => {
      expect(
        traits('messages', {
          messages: [
            { role: 'user', content: 'read a.md' },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 't1', name: 'read' }],
            },
            {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 't1', content: 'a' },
                { type: 'tool_result', tool_use_id: 't2', content: 'b' },
              ],
            },
          ],
        }).initiator,
      ).toBe('agent')
    })

    it('treats tool results merged with new user text as a user turn', () => {
      expect(
        traits('messages', {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 't1', content: 'a' },
                { type: 'text', text: 'now do something else' },
              ],
            },
          ],
        }).initiator,
      ).toBe('user')
    })

    it('treats a trailing assistant prefill as an agent turn', () => {
      expect(
        traits('messages', {
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'Sure' },
          ],
        }).initiator,
      ).toBe('agent')
    })

    it('sees an image nested in a tool result', () => {
      expect(
        traits('messages', {
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 't1',
                  content: [{ type: 'image', source: { type: 'base64' } }],
                },
              ],
            },
          ],
        }),
      ).toEqual({ initiator: 'agent', hasImage: true })
    })
  })

  it.each([
    ['an empty body', undefined],
    ['a non-JSON body', 'not json'],
    ['a JSON array', '[]'],
  ])('falls back to a user turn for %s', (_label, body) => {
    expect(resolveCopilotRequestTraits('chat', body)).toEqual({
      initiator: 'user',
      hasImage: false,
    })
  })

  it('falls back to a user turn when messages are missing', () => {
    expect(traits('messages', { model: 'x' }).initiator).toBe('user')
  })
})
