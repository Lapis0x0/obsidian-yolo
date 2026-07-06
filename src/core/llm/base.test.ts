import type { ChatModel } from '../../types/chat-model.types'
import type {
  LLMRequestNonStreaming,
  LLMRequestStreaming,
} from '../../types/llm/request'
import type {
  LLMResponseNonStreaming,
  LLMResponseStreaming,
} from '../../types/llm/response'
import type { LLMProvider } from '../../types/provider.types'

import { BaseLLMProvider } from './base'

// Concrete subclass purely for exercising the protected helper.
class TestProvider extends BaseLLMProvider<LLMProvider> {
  generateResponse(
    _model: ChatModel,
    _request: LLMRequestNonStreaming,
  ): Promise<LLMResponseNonStreaming> {
    throw new Error('not used')
  }

  streamResponse(
    _model: ChatModel,
    _request: LLMRequestStreaming,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    throw new Error('not used')
  }

  getEmbedding(): Promise<number[]> {
    throw new Error('not used')
  }

  public exposeApplyCustomModelParameters<T extends Record<string, unknown>>(
    model: ChatModel,
    request: T,
  ): T {
    return this.applyCustomModelParameters(model, request)
  }
}

const makeModel = (
  customParameters: ChatModel['customParameters'],
): ChatModel =>
  ({
    providerId: 'p',
    id: 'm',
    model: 'm',
    customParameters,
  }) as ChatModel

const makeProvider = (
  additionalSettings?: Record<string, unknown>,
): LLMProvider => ({
  id: 'p',
  presetType: 'openai-compatible',
  apiType: 'openai-compatible',
  baseUrl: 'https://example.com/v1',
  additionalSettings,
})

const provider = new TestProvider(makeProvider())

describe('resolveResponseExecutionMode', () => {
  it('passes non-streaming provider mode through even when transport is obsidian', () => {
    const provider = new TestProvider(
      makeProvider({
        requestTransportMode: 'obsidian',
        responseStreamingMode: 'non-streaming',
      }),
    )

    expect(provider.resolveResponseExecutionMode('incremental')).toBe(
      'non-streaming',
    )
  })

  it('keeps auto provider mode on the existing obsidian buffered-streaming path', () => {
    const provider = new TestProvider(
      makeProvider({
        requestTransportMode: 'obsidian',
      }),
    )

    expect(provider.resolveResponseExecutionMode('incremental')).toBe(
      'buffered-streaming',
    )
  })

  it('treats invalid provider streaming mode values as auto', () => {
    const provider = new TestProvider(
      makeProvider({
        requestTransportMode: 'obsidian',
        responseStreamingMode: 'invalid',
      }),
    )

    expect(provider.resolveResponseExecutionMode('incremental')).toBe(
      'buffered-streaming',
    )
  })
})

describe('applyCustomModelParameters', () => {
  it('returns request as-is when no custom parameters configured', () => {
    const request = { model: 'x', temperature: 0.3 }
    const result = provider.exposeApplyCustomModelParameters(
      makeModel(undefined),
      request,
    )
    expect(result).toEqual({ model: 'x', temperature: 0.3 })
  })

  it('overwrites scalar fields like temperature', () => {
    const result = provider.exposeApplyCustomModelParameters(
      makeModel([{ key: 'temperature', value: '0.7', type: 'number' }]),
      { model: 'x', temperature: 0.3 },
    )
    expect(result.temperature).toEqual(0.7)
  })

  it('APPENDS to `tools` array instead of overwriting (the bug fix)', () => {
    const result = provider.exposeApplyCustomModelParameters(
      makeModel([
        {
          key: 'tools',
          value: JSON.stringify([{ type: 'openrouter:web_search' }]),
          type: 'json',
        },
      ]),
      {
        model: 'x',
        tools: [
          { type: 'function', function: { name: 'agent_local__search' } },
        ],
      },
    )
    expect(result.tools).toEqual([
      { type: 'function', function: { name: 'agent_local__search' } },
      { type: 'openrouter:web_search' },
    ])
  })

  it('overwrites `tools` when the existing field is not an array (no agent tools)', () => {
    const result = provider.exposeApplyCustomModelParameters(
      makeModel([
        {
          key: 'tools',
          value: JSON.stringify([{ type: 'openrouter:web_search' }]),
          type: 'json',
        },
      ]),
      { model: 'x' } as Record<string, unknown>,
    )
    expect(result.tools).toEqual([{ type: 'openrouter:web_search' }])
  })

  it('does NOT append arrays for non-whitelisted keys (`messages` stays on overwrite semantics)', () => {
    const result = provider.exposeApplyCustomModelParameters(
      makeModel([
        {
          key: 'messages',
          value: JSON.stringify([{ role: 'user', content: 'injected' }]),
          type: 'json',
        },
      ]),
      {
        model: 'x',
        messages: [{ role: 'system', content: 'original' }],
      },
    )
    expect(result.messages).toEqual([{ role: 'user', content: 'injected' }])
  })

  it('ignores blank keys and blank values', () => {
    const result = provider.exposeApplyCustomModelParameters(
      makeModel([
        { key: '   ', value: 'foo', type: 'text' },
        { key: 'temperature', value: '   ', type: 'text' },
      ]),
      { model: 'x', temperature: 0.3 },
    )
    expect(result.temperature).toEqual(0.3)
  })
})
