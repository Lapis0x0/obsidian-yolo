import { ChatModel } from '../../types/chat-model.types'
import { BaseLLMProvider } from './base'

// Concrete subclass purely for exercising the protected helper.
class TestProvider extends BaseLLMProvider<never> {
  generateResponse(): any {
    throw new Error('not used')
  }

  streamResponse(): any {
    throw new Error('not used')
  }

  getEmbedding(): any {
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

const provider = new TestProvider(null as never)

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
