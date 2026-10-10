import { ChatModel } from '../../types/chat-model.types'
import { LLMRequestNonStreaming } from '../../types/llm/request'
import { LLMProvider } from '../../types/provider.types'

import { AnthropicProvider } from './anthropic'
import { BaseLLMProvider } from './base'
import { OpenAICompatibleProvider } from './openaiCompatibleProvider'
import { OpenAIResponsesProvider } from './openaiResponsesProvider'
import { WrapTransportFetch } from './transportClients'

type ProviderFactory = (
  provider: LLMProvider,
  wrapFetch?: WrapTransportFetch,
) => BaseLLMProvider<LLMProvider>

const cases: [string, LLMProvider['apiType'], string, ProviderFactory][] = [
  [
    'OpenAICompatibleProvider',
    'openai-compatible',
    'https://example.com/v1/chat/completions',
    (provider, wrapFetch) =>
      new OpenAICompatibleProvider(provider, { wrapFetch }),
  ],
  [
    'OpenAIResponsesProvider',
    'openai-responses',
    'https://example.com/v1/responses',
    (provider, wrapFetch) =>
      new OpenAIResponsesProvider(provider, { wrapFetch }),
  ],
  [
    'AnthropicProvider',
    'anthropic',
    'https://example.com/v1/messages',
    (provider, wrapFetch) => new AnthropicProvider(provider, { wrapFetch }),
  ],
]

const model: ChatModel = { providerId: 'p', id: 'm', model: 'm' }
const request: LLMRequestNonStreaming = {
  model: 'm',
  stream: false,
  messages: [{ role: 'user', content: 'hi' }],
}

describe.each(cases)('%s wrapFetch', (_name, apiType, url, create) => {
  const originalFetch = globalThis.fetch
  let networkFetch: jest.Mock

  const provider: LLMProvider = {
    id: 'p',
    presetType: 'openai-compatible',
    apiType,
    apiKey: 'sk-test',
    baseUrl: 'https://example.com/v1',
    additionalSettings: { requestTransportMode: 'browser' },
  } as LLMProvider

  beforeEach(() => {
    // The browser transport binds `globalThis.fetch` when it is created, so
    // it must be replaced before the provider is constructed.
    networkFetch = jest.fn(
      async () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    globalThis.fetch = networkFetch as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const send = (instance: BaseLLMProvider<LLMProvider>) =>
    // The empty response body may not parse; only the outgoing call matters.
    instance.generateResponse(model, request).catch(() => undefined)

  it('sends straight through the transport when not given', async () => {
    await send(create(provider))

    expect(networkFetch).toHaveBeenCalledTimes(1)
    const [input, init] = networkFetch.mock.calls[0]
    expect(String(input)).toBe(url)
    expect(new Headers(init?.headers).has('x-wrapped')).toBe(false)
  })

  it('puts the wrapper around every transport fetch', async () => {
    const wrapFetch = jest.fn(
      (transportFetch: typeof fetch): typeof fetch =>
        (input, init) => {
          const headers = new Headers(init?.headers)
          headers.set('x-wrapped', '1')
          return transportFetch(input, { ...init, headers })
        },
    )

    await send(create(provider, wrapFetch))

    // One wrapper per transport: browser, obsidian, node.
    expect(wrapFetch).toHaveBeenCalledTimes(3)
    expect(networkFetch).toHaveBeenCalledTimes(1)
    const [input, init] = networkFetch.mock.calls[0]
    expect(String(input)).toBe(url)
    expect(new Headers(init?.headers).get('x-wrapped')).toBe('1')
  })
})
