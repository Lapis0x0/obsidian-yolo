jest.mock('../auth/copilotOAuthRuntime', () => ({
  getCopilotOAuthService: jest.fn(),
}))
jest.mock('./copilotAutoSession', () => ({
  ...jest.requireActual('./copilotAutoSession'),
  getCopilotAutoSession: jest.fn(),
  findCopilotAutoSessionToken: jest.fn(async () => undefined),
}))
jest.mock('./copilotModelCatalog', () => ({
  ...jest.requireActual('./copilotModelCatalog'),
  getCopilotModelCatalog: jest.fn(),
}))

import { ChatModel } from '../../types/chat-model.types'
import { LLMRequestNonStreaming } from '../../types/llm/request'
import { LLMProvider } from '../../types/provider.types'
import { getCopilotOAuthService } from '../auth/copilotOAuthRuntime'
import { CopilotOAuthError } from '../auth/copilotOAuthService'

import {
  findCopilotAutoSessionToken,
  getCopilotAutoSession,
} from './copilotAutoSession'
import {
  CopilotCatalogModel,
  getCopilotModelCatalog,
} from './copilotModelCatalog'
import { CopilotProvider } from './copilotProvider'
import {
  LLMAPIKeyInvalidException,
  LLMProviderNotConfiguredException,
} from './exception'

const getServiceMock = getCopilotOAuthService as jest.Mock
const getCatalogMock = getCopilotModelCatalog as jest.Mock

const provider: LLMProvider = {
  id: 'copilot',
  presetType: 'github-copilot',
  apiType: 'openai-compatible',
  additionalSettings: { requestTransportMode: 'browser' },
}

const catalogEntry = (
  id: string,
  supportedEndpoints: string[],
): CopilotCatalogModel => ({
  id,
  supportedEndpoints,
  limits: {},
  supports: {},
})

const request = (model: string): LLMRequestNonStreaming => ({
  model,
  stream: false,
  messages: [{ role: 'user', content: 'hi' }],
})

describe('CopilotProvider', () => {
  const originalFetch = globalThis.fetch
  let networkFetch: jest.Mock

  beforeEach(() => {
    networkFetch = jest.fn(
      async () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    globalThis.fetch = networkFetch as unknown as typeof fetch
    getServiceMock.mockReturnValue({
      getUsableCredential: jest.fn(async () => ({
        copilotToken: 'tok-1',
        copilotExpiresAt: Date.now() + 60 * 60 * 1000,
        apiBaseUrl: 'https://api.individual.githubcopilot.com',
      })),
      invalidateCopilotToken: jest.fn(),
    })
    getCatalogMock.mockResolvedValue([
      catalogEntry('claude-opus-5-5', [
        '/chat/completions',
        '/responses',
        '/v1/messages',
      ]),
      catalogEntry('gpt-5', ['/chat/completions', '/responses']),
      catalogEntry('gemini', ['/chat/completions']),
    ])
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const send = async (
    model: ChatModel,
    overrides: Partial<LLMRequestNonStreaming> = {},
  ) => {
    await new CopilotProvider(provider)
      .generateResponse(model, { ...request(model.model), ...overrides })
      // The empty response body may not parse; only the outgoing call matters.
      .catch(() => undefined)
    expect(networkFetch).toHaveBeenCalledTimes(1)
    const [input, init] = networkFetch.mock.calls[0] as [string, RequestInit]
    return {
      url: String(input),
      headers: new Headers(init.headers),
      body: JSON.parse(init.body as string) as Record<string, unknown>,
    }
  }

  it.each([
    ['claude-opus-5-5', '/v1/messages'],
    ['gpt-5', '/responses'],
    ['gemini', '/chat/completions'],
    ['typed-by-hand', '/chat/completions'],
  ])('sends %s to %s on the account origin', async (id, path) => {
    const { url, headers } = await send({
      providerId: 'copilot',
      id,
      model: id,
    })
    expect(url).toBe(`https://api.individual.githubcopilot.com${path}`)
    expect(headers.get('authorization')).toBe('Bearer tok-1')
    expect(headers.has('x-api-key')).toBe(false)
    expect(headers.get('x-initiator')).toBe('user')
  })

  it('keeps thinking.block_binding and its beta off the Messages request', async () => {
    const { headers, body } = await send(
      {
        providerId: 'copilot',
        id: 'claude-opus-5-5',
        model: 'claude-opus-5-5',
        reasoningType: 'anthropic',
      },
      // A small reply size keeps the SDK's non-streaming guard quiet.
      { reasoningLevel: 'high', max_tokens: 1024 },
    )

    expect(body.thinking).toBeDefined()
    expect(
      (body.thinking as Record<string, unknown>).block_binding,
    ).toBeUndefined()
    expect(headers.get('anthropic-beta') ?? '').not.toContain(
      'thinking-binding-controls',
    )
  })

  it.each(['claude-opus-5-5', 'gpt-5', 'gemini'])(
    'words a final 401 from %s as a Copilot login problem',
    async (id) => {
      networkFetch.mockImplementation(
        async () =>
          new Response('{"error":{"message":"unauthorized"}}', {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
      )
      const result = new CopilotProvider(provider).generateResponse(
        { providerId: 'copilot', id, model: id },
        request(id),
      )
      await expect(result).rejects.toBeInstanceOf(LLMAPIKeyInvalidException)
      await expect(result).rejects.toThrow(/GitHub Copilot rejected/)
    },
  )

  it('words a missing subscription as such', async () => {
    getCatalogMock.mockRejectedValue(
      new CopilotOAuthError('no_subscription', 'forbidden'),
    )
    await expect(
      new CopilotProvider(provider).generateResponse(
        { providerId: 'copilot', id: 'gpt-5', model: 'gpt-5' },
        request('gpt-5'),
      ),
    ).rejects.toThrow(/no Copilot access/)
  })

  it('sends Auto as the picked model, on its endpoint, with the session token', async () => {
    getCatalogMock.mockClear()
    ;(getCopilotAutoSession as jest.Mock).mockResolvedValue({
      sessionToken: 'st-1',
      selectedModel: { id: 'gpt-6-luna', supportedEndpoints: ['/responses'] },
      expiresAt: Date.now() + 60 * 60 * 1000,
    })
    ;(findCopilotAutoSessionToken as jest.Mock).mockImplementation(
      async (_providerId: string, modelId: string) =>
        modelId === 'gpt-6-luna' ? 'st-1' : undefined,
    )

    const { url, headers, body } = await send(
      { providerId: 'copilot', id: 'copilot/auto', model: 'auto' },
      { messages: [{ role: 'user', content: 'Plan my week' }] },
    )

    expect(getCopilotAutoSession).toHaveBeenCalledWith(
      'copilot',
      expect.anything(),
      { prompt: 'Plan my week', hasImage: false },
    )
    expect(url).toBe('https://api.individual.githubcopilot.com/responses')
    expect(body.model).toBe('gpt-6-luna')
    expect(headers.get('copilot-session-token')).toBe('st-1')
    expect(getCatalogMock).not.toHaveBeenCalled()
  })

  it('does not support embeddings', async () => {
    await expect(
      new CopilotProvider(provider).getEmbedding('m', 'text'),
    ).rejects.toBeInstanceOf(LLMProviderNotConfiguredException)
  })
})
