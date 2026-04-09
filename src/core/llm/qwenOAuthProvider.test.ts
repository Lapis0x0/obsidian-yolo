import { getQwenOAuthService } from '../auth/qwenOAuthRuntime'

import { QwenOAuthProvider } from './qwenOAuthProvider'

jest.mock('../auth/qwenOAuthRuntime', () => ({
  getQwenOAuthService: jest.fn(),
}))

describe('QwenOAuthProvider', () => {
  it('uses a QwenCode-compatible DashScope user agent header', async () => {
    ;(getQwenOAuthService as jest.Mock).mockReturnValue({
      getUsableCredential: jest.fn().mockResolvedValue({
        accessToken: 'token',
        refreshToken: 'refresh',
        resourceUrl: 'portal.qwen.ai',
        expiresAt: Date.now() + 60_000,
        updatedAt: Date.now(),
      }),
    })

    const provider = new QwenOAuthProvider({
      id: 'qwen-oauth',
      name: 'Qwen OAuth',
      presetType: 'qwen-oauth',
      apiKey: '',
      baseUrl: '',
      enable: true,
      models: [],
      customHeaders: [],
      additionalSettings: {},
    } as never)

    const baseFetchMock = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >(async () => new Response('{}', { status: 200 }))
    const baseFetch = baseFetchMock as unknown as typeof fetch
    const authorizedFetch = (
      provider as unknown as {
        createAuthorizedFetch: (baseFetch: typeof fetch) => typeof fetch
      }
    ).createAuthorizedFetch(baseFetch)

    await authorizedFetch(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      {
        method: 'POST',
      },
    )

    const init = baseFetchMock.mock.calls[0]?.[1]
    const headers = new Headers(init?.headers)

    expect(headers.get('User-Agent')).toBe('obsidian-yolo/qwen-oauth')
    expect(headers.get('X-DashScope-UserAgent')).toBe('QwenCode/obsidian-yolo')
  })

  it('preserves tool parameters when generating responses', async () => {
    const generateResponse = jest.fn().mockResolvedValue({
      content: 'ok',
      usage: undefined,
      toolCalls: [],
      annotations: [],
    })

    const provider = new QwenOAuthProvider(
      {
        id: 'qwen-oauth',
        name: 'Qwen OAuth',
        presetType: 'qwen-oauth',
        apiKey: '',
        baseUrl: '',
        enable: true,
        models: [],
        customHeaders: [],
        additionalSettings: {},
      } as never,
      {
        adapter: {
          generateResponse,
          streamResponse: jest.fn(),
        } as never,
      },
    )

    await provider.generateResponse(
      {
        id: 'qwen3-coder-plus',
        name: 'Qwen3 Coder Plus',
        providerId: 'qwen-oauth',
        model: 'qwen3-coder-plus',
        enable: true,
      } as never,
      {
        model: 'qwen3-coder-plus',
        stream: false,
        messages: [
          {
            role: 'user',
            content: 'hello',
          },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'echo',
              description: 'Echo input',
              parameters: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                },
              },
            },
          },
        ],
        tool_choice: 'auto',
      },
    )

    expect(generateResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tools: [
          expect.objectContaining({
            type: 'function',
          }),
        ],
        tool_choice: 'auto',
      }),
      undefined,
    )
  })
})
