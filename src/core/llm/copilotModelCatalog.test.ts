jest.mock('obsidian', () => ({
  requestUrl: jest.fn(),
}))

import { requestUrl } from 'obsidian'

import type { CopilotUsableCredential } from '../auth/copilotOAuthService'

import type { CopilotCredentialSource } from './copilotFetch'
import {
  clearCopilotModelCatalog,
  getCopilotModelCatalog,
  parseCopilotModelCatalog,
  selectCopilotEndpoint,
} from './copilotModelCatalog'

const requestUrlMock = requestUrl as jest.MockedFunction<typeof requestUrl>

const credential: CopilotUsableCredential = {
  copilotToken: 'tok-1',
  copilotExpiresAt: Date.now() + 60 * 60 * 1000,
  apiBaseUrl: 'https://api.individual.githubcopilot.com',
}

const source = (): CopilotCredentialSource & {
  invalidateCopilotToken: jest.Mock
} => ({
  getUsableCredential: jest.fn(async () => credential),
  invalidateCopilotToken: jest.fn(),
})

const chatModel = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  model_picker_enabled: true,
  capabilities: { type: 'chat' },
  ...extra,
})

describe('parseCopilotModelCatalog', () => {
  it('keeps picker-enabled chat models the policy allows', () => {
    const models = parseCopilotModelCatalog({
      data: [
        chatModel('gpt-5'),
        chatModel('claude-opus', { policy: { state: 'enabled' } }),
        chatModel('needs-opt-in', { policy: { state: 'unconfigured' } }),
        chatModel('hidden', { model_picker_enabled: false }),
        {
          id: 'embed',
          model_picker_enabled: true,
          capabilities: { type: 'embeddings' },
        },
        { model_picker_enabled: true, capabilities: { type: 'chat' } },
      ],
    })
    expect(models.map((model) => model.id)).toEqual(['gpt-5', 'claude-opus'])
  })

  it('keeps endpoints, limits and supports', () => {
    const [model] = parseCopilotModelCatalog({
      data: [
        chatModel('claude-opus', {
          supported_endpoints: ['/v1/messages', '/chat/completions'],
          capabilities: {
            type: 'chat',
            limits: {
              max_context_window_tokens: 200000,
              max_prompt_tokens: 128000,
              max_output_tokens: 16000,
            },
            supports: { tool_calls: true, vision: true, streaming: true },
          },
        }),
      ],
    })
    expect(model).toEqual({
      id: 'claude-opus',
      supportedEndpoints: ['/v1/messages', '/chat/completions'],
      limits: {
        maxContextWindowTokens: 200000,
        maxPromptTokens: 128000,
        maxOutputTokens: 16000,
      },
      supports: {
        toolCalls: true,
        parallelToolCalls: undefined,
        vision: true,
        streaming: true,
      },
    })
  })

  it('returns nothing for an unexpected payload', () => {
    expect(parseCopilotModelCatalog(null)).toEqual([])
    expect(parseCopilotModelCatalog({ models: [] })).toEqual([])
  })
})

describe('selectCopilotEndpoint', () => {
  it.each([
    [['/chat/completions', '/responses', '/v1/messages'], 'messages'],
    [['/chat/completions', '/responses'], 'responses'],
    [['/chat/completions'], 'chat'],
    [[], 'chat'],
  ])('picks the preferred endpoint of %j', (endpoints, expected) => {
    expect(selectCopilotEndpoint({ supportedEndpoints: endpoints })).toBe(
      expected,
    )
  })

  it('sends a model the catalog does not list to chat completions', () => {
    expect(selectCopilotEndpoint(undefined)).toBe('chat')
  })
})

describe('getCopilotModelCatalog', () => {
  beforeEach(() => {
    requestUrlMock.mockReset()
    clearCopilotModelCatalog('copilot')
    clearCopilotModelCatalog('other')
  })

  it('requests /models on the account origin with the Copilot headers', async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: { data: [chatModel('gpt-5')] },
    } as never)

    await getCopilotModelCatalog('copilot', source())

    expect(requestUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.individual.githubcopilot.com/models',
        headers: expect.objectContaining({
          Authorization: 'Bearer tok-1',
          'Copilot-Integration-Id': 'vscode-chat',
        }),
      }),
    )
  })

  it('shares one fetch per provider and caches it', async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: { data: [chatModel('gpt-5')] },
    } as never)

    const [first, second] = await Promise.all([
      getCopilotModelCatalog('copilot', source()),
      getCopilotModelCatalog('copilot', source()),
    ])
    await getCopilotModelCatalog('copilot', source())
    expect(first).toBe(second)
    expect(requestUrlMock).toHaveBeenCalledTimes(1)

    await getCopilotModelCatalog('other', source())
    expect(requestUrlMock).toHaveBeenCalledTimes(2)

    await getCopilotModelCatalog('copilot', source(), { refresh: true })
    expect(requestUrlMock).toHaveBeenCalledTimes(3)
  })

  it('does not keep a failed fetch', async () => {
    requestUrlMock.mockResolvedValueOnce({ status: 500 } as never)
    await expect(getCopilotModelCatalog('copilot', source())).rejects.toThrow(
      '500',
    )

    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: { data: [chatModel('gpt-5')] },
    } as never)
    await expect(
      getCopilotModelCatalog('copilot', source()),
    ).resolves.toHaveLength(1)
  })

  it('exchanges a new token once on 401', async () => {
    requestUrlMock
      .mockResolvedValueOnce({ status: 401 } as never)
      .mockResolvedValueOnce({
        status: 200,
        json: { data: [chatModel('gpt-5')] },
      } as never)
    const credentialSource = source()

    await expect(
      getCopilotModelCatalog('copilot', credentialSource),
    ).resolves.toHaveLength(1)
    expect(credentialSource.invalidateCopilotToken).toHaveBeenCalledWith(
      'tok-1',
    )
  })
})
