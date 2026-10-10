jest.mock('obsidian', () => ({
  requestUrl: jest.fn(),
}))

import { requestUrl } from 'obsidian'

import type { CopilotUsableCredential } from '../auth/copilotOAuthService'

import {
  clearCopilotAutoSession,
  findCopilotAutoSessionToken,
  getCopilotAutoSession,
  invalidateCopilotAutoSession,
  parseCopilotAutoSession,
} from './copilotAutoSession'
import type { CopilotCredentialSource } from './copilotFetch'

const requestUrlMock = requestUrl as jest.MockedFunction<typeof requestUrl>

const credential: CopilotUsableCredential = {
  copilotToken: 'tok-1',
  copilotExpiresAt: Date.now() + 60 * 60 * 1000,
  apiBaseUrl: 'https://api.individual.githubcopilot.com',
}

const source = (): CopilotCredentialSource => ({
  getUsableCredential: jest.fn(async () => credential),
  invalidateCopilotToken: jest.fn(),
})

const autoResponse = (
  sessionToken: string,
  model: string,
  expiresInS = 24 * 60 * 60,
) =>
  ({
    status: 200,
    json: {
      session_token: sessionToken,
      selected_model: { id: model, supported_endpoints: ['/responses'] },
      expires_at: Math.floor(Date.now() / 1000) + expiresInS,
    },
  }) as never

const input = { prompt: 'Say PONG', hasImage: false }

describe('Copilot Auto session', () => {
  beforeEach(() => {
    requestUrlMock.mockReset()
    clearCopilotAutoSession('copilot')
  })

  it('parses the picked model, its endpoints and the token', () => {
    const session = parseCopilotAutoSession({
      session_token: 'st',
      selected_model: { id: 'gpt-6-luna', supported_endpoints: ['/responses'] },
      expires_at: 100,
    })
    expect(session).toEqual({
      sessionToken: 'st',
      selectedModel: { id: 'gpt-6-luna', supportedEndpoints: ['/responses'] },
      expiresAt: 100_000,
    })
    expect(parseCopilotAutoSession({ selected_model: {} })).toBeNull()
  })

  it('asks /auto with the routing prompt and the Copilot headers', async () => {
    requestUrlMock.mockResolvedValue(autoResponse('st', 'gpt-6-luna'))
    await getCopilotAutoSession('copilot', source(), {
      prompt: 'Describe this',
      hasImage: true,
    })

    const [request] = requestUrlMock.mock.calls[0] as [
      { url: string; headers: Record<string, string>; body: string },
    ]
    expect(request.url).toBe('https://api.individual.githubcopilot.com/auto')
    expect(request.headers.Authorization).toBe('Bearer tok-1')
    expect(JSON.parse(request.body)).toEqual({
      prompt: 'Describe this',
      tier: 'balance',
      has_image: true,
    })
  })

  it('reuses one session per provider until it nears expiry', async () => {
    requestUrlMock.mockResolvedValueOnce(autoResponse('st-1', 'gpt-6-luna'))
    const [first, second] = await Promise.all([
      getCopilotAutoSession('copilot', source(), input),
      getCopilotAutoSession('copilot', source(), input),
    ])
    expect(first).toBe(second)
    expect(requestUrlMock).toHaveBeenCalledTimes(1)

    clearCopilotAutoSession('copilot')
    // Two minutes left is inside the re-route margin.
    requestUrlMock.mockResolvedValueOnce(
      autoResponse('st-2', 'gpt-6-luna', 120),
    )
    await getCopilotAutoSession('copilot', source(), input)
    requestUrlMock.mockResolvedValueOnce(autoResponse('st-3', 'mai-code'))
    const renewed = await getCopilotAutoSession('copilot', source(), input)
    expect(renewed.sessionToken).toBe('st-3')
  })

  it('hands the token only to requests for the picked model', async () => {
    requestUrlMock.mockResolvedValue(autoResponse('st', 'gpt-6-luna'))
    await getCopilotAutoSession('copilot', source(), input)

    await expect(
      findCopilotAutoSessionToken('copilot', 'gpt-6-luna'),
    ).resolves.toBe('st')
    await expect(
      findCopilotAutoSessionToken('copilot', 'gpt-4.1'),
    ).resolves.toBeUndefined()
    await expect(
      findCopilotAutoSessionToken('other', 'gpt-6-luna'),
    ).resolves.toBeUndefined()
  })

  it('re-routes after the server rejects the session', async () => {
    requestUrlMock.mockResolvedValueOnce(autoResponse('st-1', 'gpt-6-luna'))
    await getCopilotAutoSession('copilot', source(), input)

    // A late rejection of some other token leaves the session alone.
    invalidateCopilotAutoSession('copilot', 'unrelated')
    invalidateCopilotAutoSession('copilot', 'st-1')
    await Promise.resolve()
    await Promise.resolve()

    requestUrlMock.mockResolvedValueOnce(autoResponse('st-2', 'mai-code'))
    const next = await getCopilotAutoSession('copilot', source(), input)
    expect(next.sessionToken).toBe('st-2')
  })

  it('does not keep a failed pick', async () => {
    requestUrlMock.mockResolvedValueOnce({ status: 404 } as never)
    await expect(
      getCopilotAutoSession('copilot', source(), input),
    ).rejects.toThrow('404')

    requestUrlMock.mockResolvedValueOnce(autoResponse('st', 'gpt-6-luna'))
    await expect(
      getCopilotAutoSession('copilot', source(), input),
    ).resolves.toMatchObject({ sessionToken: 'st' })
  })
})
