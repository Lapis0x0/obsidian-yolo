import OpenAI from 'openai'

import { RequestMessage } from '../../types/llm/request'

import { OpenRouterMessageAdapter } from './openRouterMessageAdapter'

class TestOpenRouterMessageAdapter extends OpenRouterMessageAdapter {
  parseRequest(message: RequestMessage) {
    return this.parseRequestMessage(message)
  }

  parseNonStreaming(raw: unknown) {
    return this.parseNonStreamingResponse(raw as never)
  }

  async collectStream(rawChunks: unknown[]) {
    const client = {
      chat: {
        completions: {
          create: () =>
            Promise.resolve(
              (async function* () {
                for (const chunk of rawChunks) {
                  yield chunk as never
                }
              })(),
            ),
        },
      },
    } as unknown as OpenAI

    const stream = await this.streamResponse(client, {
      model: 'deepseek/deepseek-v4-pro',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    })
    const parsed = []
    for await (const chunk of stream) {
      parsed.push(chunk)
    }
    return parsed
  }
}

const chunk = (
  delta: Record<string, unknown>,
  finish_reason: string | null = null,
) => ({
  id: 'gen-1',
  object: 'chat.completion.chunk',
  model: 'deepseek/deepseek-v4-pro',
  choices: [{ index: 0, delta, finish_reason }],
})

describe('OpenRouterMessageAdapter', () => {
  const adapter = new TestOpenRouterMessageAdapter()

  it('joins streamed reasoning fragments per block and hands them over when the reply finishes', async () => {
    const parsed = await adapter.collectStream([
      chunk({
        reasoning_details: [
          {
            type: 'reasoning.text',
            text: 'Let me ',
            format: 'unknown',
            index: 0,
          },
        ],
      }),
      chunk({
        reasoning_details: [
          {
            type: 'reasoning.text',
            text: 'think.',
            signature: 'sig',
            index: 0,
          },
          { type: 'reasoning.encrypted', data: 'opaque', index: 1 },
        ],
      }),
      chunk({ content: 'Done' }),
      chunk({}, 'stop'),
    ])

    expect(
      parsed.slice(0, -1).map((c) => c.choices[0].delta.providerMetadata),
    ).toEqual([undefined, undefined, undefined])
    expect(parsed.at(-1)?.choices[0].delta.providerMetadata).toEqual({
      openrouter: {
        reasoningDetails: [
          {
            type: 'reasoning.text',
            text: 'Let me think.',
            format: 'unknown',
            signature: 'sig',
            index: 0,
          },
          { type: 'reasoning.encrypted', data: 'opaque', index: 1 },
        ],
      },
    })
  })

  it('leaves a reply without reasoning blocks untouched', async () => {
    const parsed = await adapter.collectStream([
      chunk({ content: 'Hi' }),
      chunk({}, 'stop'),
    ])
    expect(parsed.at(-1)?.choices[0].delta.providerMetadata).toBeUndefined()
  })

  it('keeps reasoning blocks of a non-streaming reply', () => {
    const reasoningDetails = [
      { type: 'reasoning.text', text: 'Thinking', index: 0 },
    ]
    const parsed = adapter.parseNonStreaming({
      id: 'gen-1',
      object: 'chat.completion',
      model: 'deepseek/deepseek-v4-pro',
      created: 0,
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'Hi',
            reasoning: 'Thinking',
            reasoning_details: reasoningDetails,
          },
        },
      ],
    })
    expect(parsed.choices[0].message.providerMetadata).toEqual({
      openrouter: { reasoningDetails },
    })
  })

  it('sends the kept reasoning blocks back on the assistant message', () => {
    const reasoningDetails = [
      { type: 'reasoning.text', text: 'Thinking', signature: 'sig', index: 0 },
    ]
    expect(
      adapter.parseRequest({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', name: 'read' }],
        providerMetadata: { openrouter: { reasoningDetails } },
      }),
    ).toMatchObject({ role: 'assistant', reasoning_details: reasoningDetails })
    expect(
      adapter.parseRequest({ role: 'assistant', content: 'Hi' }),
    ).not.toHaveProperty('reasoning_details')
  })
})
