import type Anthropic from '@anthropic-ai/sdk'

import { RequestMessage } from '../../types/llm/request'
import { LLMProvider } from '../../types/provider.types'

import { AnthropicProvider } from './anthropic'

const provider: LLMProvider = {
  id: 'anthropic',
  presetType: 'anthropic',
  apiType: 'anthropic',
  apiKey: 'sk-test',
}

type Internals = {
  streamResponseGenerator: (
    stream: unknown,
    requestModel: string,
  ) => AsyncIterable<{ choices?: { delta?: Record<string, any> }[] }>
  parseRequestMessage: (message: RequestMessage) => unknown
}
const internals = () => new AnthropicProvider(provider) as unknown as Internals

const toolTurnEvents = [
  {
    type: 'message_start',
    message: {
      id: 'msg_1',
      model: 'claude-opus-5-5',
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'thinking', thinking: '', signature: '' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'Look it ' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'up.' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'signature_delta', signature: 'sig-1' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'text', text: '' },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'text_delta', text: 'Reading.' },
  },
  { type: 'content_block_stop', index: 1 },
  {
    type: 'content_block_start',
    index: 2,
    content_block: { type: 'tool_use', id: 'call_1', name: 'read', input: {} },
  },
  {
    type: 'content_block_delta',
    index: 2,
    delta: { type: 'input_json_delta', partial_json: '{"path":' },
  },
  {
    type: 'content_block_delta',
    index: 2,
    delta: { type: 'input_json_delta', partial_json: '"a.md"}' },
  },
  { type: 'content_block_stop', index: 2 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 5 },
  },
  { type: 'message_stop' },
]

const nativeReply = [
  { type: 'thinking', thinking: 'Look it up.', signature: 'sig-1' },
  { type: 'text', text: 'Reading.' },
  { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.md' } },
]

const streamOf = async (events: unknown[], requestModel: string) => {
  const stream = (async function* () {
    for (const event of events) yield event
  })()
  const chunks = []
  for await (const chunk of internals().streamResponseGenerator(
    stream,
    requestModel,
  )) {
    chunks.push(chunk)
  }
  return chunks
    .map((c) => c.choices?.[0]?.delta?.providerMetadata)
    .filter(Boolean)
}

describe('AnthropicProvider Claude reply replay', () => {
  it('assembles the streamed reply with its thinking signature', async () => {
    expect(await streamOf(toolTurnEvents, 'claude-opus-5-5')).toEqual([
      { anthropic: { content: nativeReply } },
    ])
  })

  it('keeps nothing from a stream that never finished', async () => {
    expect(
      await streamOf(toolTurnEvents.slice(0, -1), 'claude-opus-5-5'),
    ).toEqual([])
  })

  it('keeps nothing for a model that is not Claude', async () => {
    expect(await streamOf(toolTurnEvents, 'kimi-k2.5')).toEqual([])
  })

  it('captures a non-streamed reply', () => {
    const response = {
      id: 'msg_1',
      model: 'claude-opus-5-5',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: 'Look it up.', signature: 'sig-1' },
        { type: 'text', text: 'Reading.', citations: null },
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'read',
          input: { path: 'a.md' },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    } as unknown as Anthropic.Message

    expect(
      AnthropicProvider.parseNonStreamingResponse(response, 'claude-opus-5-5')
        .choices[0].message.providerMetadata,
    ).toEqual({ anthropic: { content: nativeReply } })
  })

  it('sends the reply back as it was generated', () => {
    expect(
      internals().parseRequestMessage({
        role: 'assistant',
        content: 'Reading.',
        providerMetadata: { anthropic: { content: nativeReply } },
        tool_calls: [
          { id: 'call_1', name: 'read', arguments: '{"path":"a.md"}' } as never,
        ],
      }),
    ).toEqual({ role: 'assistant', content: nativeReply })
  })

  it('leaves out a tool call the request no longer answers', () => {
    expect(
      internals().parseRequestMessage({
        role: 'assistant',
        content: 'Reading.',
        providerMetadata: { anthropic: { content: nativeReply } },
      }),
    ).toEqual({ role: 'assistant', content: nativeReply.slice(0, 2) })
  })
})

describe('AnthropicProvider thinking block binding', () => {
  const buildReasoningFields = (
    AnthropicProvider as unknown as {
      buildReasoningFields: (
        modelId: string,
        level: string,
        maxTokens: number | undefined,
      ) => { thinking?: Record<string, unknown> }
    }
  ).buildReasoningFields
  const buildRequestHeaders = (
    customHeaders: LLMProvider['customHeaders'],
    payload: Record<string, unknown>,
  ) =>
    (
      new AnthropicProvider({ ...provider, customHeaders }) as unknown as {
        buildRequestHeaders: (
          payload: Record<string, unknown>,
        ) => Record<string, string> | undefined
      }
    ).buildRequestHeaders(payload)

  it('asks a binding model to drop stale thinking blocks', () => {
    const { thinking } = buildReasoningFields(
      'claude-opus-5-5',
      'high',
      undefined,
    )
    expect(thinking?.block_binding).toEqual({
      prefix_mismatch_behavior: 'drop_block',
    })
    expect(buildRequestHeaders(undefined, { thinking })).toEqual({
      'anthropic-beta': 'thinking-binding-controls-2026-08-01',
    })
  })

  it('leaves models without the prefix check alone', () => {
    const { thinking } = buildReasoningFields(
      'claude-opus-5',
      'high',
      undefined,
    )
    expect(thinking?.block_binding).toBeUndefined()
    expect(buildRequestHeaders(undefined, { thinking })).toBeUndefined()
  })

  it('keeps a beta the user set as a custom header', () => {
    expect(
      buildRequestHeaders([{ key: 'anthropic-beta', value: 'custom-beta' }], {
        thinking: { block_binding: {} },
      }),
    ).toEqual({
      'anthropic-beta': 'custom-beta,thinking-binding-controls-2026-08-01',
    })
  })
})
