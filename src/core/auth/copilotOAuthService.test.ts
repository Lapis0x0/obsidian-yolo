jest.mock('obsidian', () => ({
  requestUrl: jest.fn(),
  normalizePath: (value: string) => value,
}))

import { requestUrl } from 'obsidian'

import { COPILOT_EDITOR_HEADERS } from './copilotEditorHeaders'
import {
  COPILOT_TOKEN_REFRESH_MARGIN_MS,
  CopilotDeviceAuthorization,
  CopilotOAuthService,
} from './copilotOAuthService'
import { CopilotOAuthCredential, CopilotOAuthStore } from './copilotOAuthStore'

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>

/** An in-memory store, so tests observe what the service persists. */
function createMemoryStore(initial: CopilotOAuthCredential | null = null): {
  store: CopilotOAuthStore
  current: () => CopilotOAuthCredential | null
} {
  let value = initial
  const store = {
    get: jest.fn(() => Promise.resolve(value)),
    set: jest.fn((next: CopilotOAuthCredential) => {
      value = next
      return Promise.resolve()
    }),
    clear: jest.fn(() => {
      value = null
      return Promise.resolve()
    }),
  } as unknown as CopilotOAuthStore
  return { store, current: () => value }
}

const response = (status: number, json: unknown) =>
  ({ status, json, text: JSON.stringify(json) }) as never

const authorization = (
  overrides: Partial<CopilotDeviceAuthorization> = {},
): CopilotDeviceAuthorization => ({
  deviceCode: 'device-code',
  userCode: 'ABCD-1234',
  verificationUri: 'https://github.com/login/device',
  intervalMs: 5000,
  expiresAt: Date.now() + 900_000,
  ...overrides,
})

const exchangeResponse = (token: string, expiresInS = 1800) =>
  response(200, {
    token,
    expires_at: Math.floor(Date.now() / 1000) + expiresInS,
    endpoints: { api: 'https://api.individual.githubcopilot.com/' },
  })

const sentBody = (callIndex: number): URLSearchParams =>
  new URLSearchParams(
    (mockedRequestUrl.mock.calls[callIndex][0] as { body: string }).body,
  )

describe('CopilotOAuthService device authorization', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockedRequestUrl.mockReset()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('requests a device code with the Copilot client id and JSON accept', async () => {
    const { store } = createMemoryStore()
    const service = new CopilotOAuthService(store)
    mockedRequestUrl.mockResolvedValue(
      response(200, {
        device_code: 'dc',
        user_code: 'WXYZ-0000',
        verification_uri: 'https://github.com/login/device',
        interval: 7,
        expires_in: 900,
      }),
    )

    await expect(service.beginDeviceAuthorization()).resolves.toMatchObject({
      deviceCode: 'dc',
      userCode: 'WXYZ-0000',
      verificationUri: 'https://github.com/login/device',
      intervalMs: 7000,
    })
    const request = mockedRequestUrl.mock.calls[0][0] as {
      url: string
      headers: Record<string, string>
    }
    expect(request.url).toBe('https://github.com/login/device/code')
    expect(request.headers.Accept).toBe('application/json')
    expect(sentBody(0).get('client_id')).toBe('Iv1.b507a08c87ecfe98')
    expect(sentBody(0).get('scope')).toBe('read:user')
  })

  it('keeps polling while pending, backs off on slow_down, then stores the GitHub token', async () => {
    const { store, current } = createMemoryStore()
    const service = new CopilotOAuthService(store)
    mockedRequestUrl
      .mockResolvedValueOnce(response(200, { error: 'authorization_pending' }))
      .mockResolvedValueOnce(response(200, { error: 'slow_down' }))
      .mockResolvedValueOnce(
        response(200, { error: 'slow_down', interval: 20 }),
      )
      .mockResolvedValueOnce(response(200, { access_token: 'gho_token' }))

    const result = service.pollDeviceAuthorization(authorization())

    await jest.advanceTimersByTimeAsync(5000)
    expect(mockedRequestUrl).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(5000)
    expect(mockedRequestUrl).toHaveBeenCalledTimes(2)
    // slow_down without a server interval: 5s + 5s.
    await jest.advanceTimersByTimeAsync(9999)
    expect(mockedRequestUrl).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(1)
    expect(mockedRequestUrl).toHaveBeenCalledTimes(3)
    // slow_down with a server interval: use the server's 20s.
    await jest.advanceTimersByTimeAsync(19_999)
    expect(mockedRequestUrl).toHaveBeenCalledTimes(3)
    await jest.advanceTimersByTimeAsync(1)

    await expect(result).resolves.toMatchObject({ githubToken: 'gho_token' })
    expect(current()?.githubToken).toBe('gho_token')
    expect(current()?.session).toBeUndefined()
    expect(sentBody(0).get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:device_code',
    )
    expect(sentBody(0).get('device_code')).toBe('device-code')
  })

  it('reports an expired device code', async () => {
    const service = new CopilotOAuthService(createMemoryStore().store)
    mockedRequestUrl.mockResolvedValue(
      response(400, { error: 'expired_token' }),
    )

    const result = expect(
      service.pollDeviceAuthorization(authorization()),
    ).rejects.toMatchObject({ code: 'device_code_expired' })
    await jest.advanceTimersByTimeAsync(5000)
    await result
  })

  it('stops once the device code lifetime has passed', async () => {
    const service = new CopilotOAuthService(createMemoryStore().store)
    mockedRequestUrl.mockResolvedValue(
      response(200, { error: 'authorization_pending' }),
    )

    const result = expect(
      service.pollDeviceAuthorization(
        authorization({ expiresAt: Date.now() + 8000 }),
      ),
    ).rejects.toMatchObject({ code: 'device_code_expired' })
    await jest.advanceTimersByTimeAsync(8000)
    await result
    expect(mockedRequestUrl).toHaveBeenCalledTimes(2)
  })

  it('reports a declined authorization', async () => {
    const service = new CopilotOAuthService(createMemoryStore().store)
    mockedRequestUrl.mockResolvedValue(
      response(200, { error: 'access_denied' }),
    )

    const result = expect(
      service.pollDeviceAuthorization(authorization()),
    ).rejects.toMatchObject({ code: 'access_denied' })
    await jest.advanceTimersByTimeAsync(5000)
    await result
  })

  it('stops polling when aborted', async () => {
    const service = new CopilotOAuthService(createMemoryStore().store)
    const abortController = new AbortController()

    const result = expect(
      service.pollDeviceAuthorization(authorization(), abortController.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    abortController.abort()
    await result
    expect(mockedRequestUrl).not.toHaveBeenCalled()
  })
})

describe('CopilotOAuthService token exchange', () => {
  beforeEach(() => {
    mockedRequestUrl.mockReset()
  })

  it('returns null when not logged in', async () => {
    const service = new CopilotOAuthService(createMemoryStore().store)
    await expect(service.getUsableCredential()).resolves.toBeNull()
    await expect(service.getStatus()).resolves.toEqual({
      state: 'disconnected',
    })
    expect(mockedRequestUrl).not.toHaveBeenCalled()
  })

  it('exchanges the GitHub token and persists the Copilot session', async () => {
    const { store, current } = createMemoryStore({
      githubToken: 'gho_token',
      updatedAt: 0,
    })
    const service = new CopilotOAuthService(store)
    mockedRequestUrl.mockResolvedValue(exchangeResponse('tid=1'))

    const credential = await service.getUsableCredential()

    expect(credential).toMatchObject({
      copilotToken: 'tid=1',
      apiBaseUrl: 'https://api.individual.githubcopilot.com',
    })
    expect(current()?.session).toEqual(credential)
    const request = mockedRequestUrl.mock.calls[0][0] as {
      url: string
      method: string
      headers: Record<string, string>
    }
    expect(request.url).toBe('https://api.github.com/copilot_internal/v2/token')
    expect(request.method).toBe('GET')
    expect(request.headers).toMatchObject({
      ...COPILOT_EDITOR_HEADERS,
      Accept: 'application/json',
      Authorization: 'token gho_token',
    })
  })

  it('reuses a Copilot token with more than five minutes left', async () => {
    const service = new CopilotOAuthService(
      createMemoryStore({
        githubToken: 'gho_token',
        updatedAt: 0,
        session: {
          copilotToken: 'tid=cached',
          copilotExpiresAt:
            Date.now() + COPILOT_TOKEN_REFRESH_MARGIN_MS + 60_000,
          apiBaseUrl: 'https://api.githubcopilot.com',
        },
      }).store,
    )

    await expect(service.getUsableCredential()).resolves.toMatchObject({
      copilotToken: 'tid=cached',
    })
    expect(mockedRequestUrl).not.toHaveBeenCalled()
  })

  it('re-exchanges a Copilot token with less than five minutes left', async () => {
    const service = new CopilotOAuthService(
      createMemoryStore({
        githubToken: 'gho_token',
        updatedAt: 0,
        session: {
          copilotToken: 'tid=old',
          copilotExpiresAt: Date.now() + COPILOT_TOKEN_REFRESH_MARGIN_MS - 1000,
          apiBaseUrl: 'https://api.githubcopilot.com',
        },
      }).store,
    )
    mockedRequestUrl.mockResolvedValue(exchangeResponse('tid=new'))

    await expect(service.getUsableCredential()).resolves.toMatchObject({
      copilotToken: 'tid=new',
    })
    expect(mockedRequestUrl).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight exchange between concurrent callers', async () => {
    const service = new CopilotOAuthService(
      createMemoryStore({ githubToken: 'gho_token', updatedAt: 0 }).store,
    )
    let resolveExchange: (value: unknown) => void = () => undefined
    mockedRequestUrl.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveExchange = resolve
      }) as never,
    )

    const first = service.getUsableCredential()
    const second = service.getUsableCredential()
    await Promise.resolve()
    resolveExchange(exchangeResponse('tid=shared'))

    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(a?.copilotToken).toBe('tid=shared')
    expect(mockedRequestUrl).toHaveBeenCalledTimes(1)
  })

  it('exchanges again after a request reports the token as rejected', async () => {
    const service = new CopilotOAuthService(
      createMemoryStore({ githubToken: 'gho_token', updatedAt: 0 }).store,
    )
    mockedRequestUrl
      .mockResolvedValueOnce(exchangeResponse('tid=1'))
      .mockResolvedValueOnce(exchangeResponse('tid=2'))

    const first = await service.getUsableCredential()
    service.invalidateCopilotToken(first!.copilotToken)
    await expect(service.getUsableCredential()).resolves.toMatchObject({
      copilotToken: 'tid=2',
    })

    // A late rejection of the old token leaves the new one in place.
    service.invalidateCopilotToken('tid=1')
    await expect(service.getUsableCredential()).resolves.toMatchObject({
      copilotToken: 'tid=2',
    })
    expect(mockedRequestUrl).toHaveBeenCalledTimes(2)
  })

  it('maps 401 to a required re-login and keeps the stored login', async () => {
    const { store, current } = createMemoryStore({
      githubToken: 'gho_revoked',
      updatedAt: 0,
    })
    const service = new CopilotOAuthService(store)
    mockedRequestUrl.mockResolvedValue(response(401, { message: 'Bad' }))

    await expect(service.getUsableCredential()).rejects.toMatchObject({
      code: 'reauth_required',
    })
    await expect(service.getStatus()).resolves.toEqual({
      state: 'reauth_required',
    })
    expect(current()?.githubToken).toBe('gho_revoked')
  })

  it('maps 403 to a missing subscription', async () => {
    const service = new CopilotOAuthService(
      createMemoryStore({ githubToken: 'gho_token', updatedAt: 0 }).store,
    )
    mockedRequestUrl.mockResolvedValue(
      response(403, { message: 'Resource not accessible' }),
    )

    await expect(service.getUsableCredential()).rejects.toMatchObject({
      code: 'no_subscription',
    })
    await expect(service.getStatus()).resolves.toEqual({
      state: 'no_subscription',
    })
  })

  it('does not write back an exchange that finishes after disconnect', async () => {
    const { store, current } = createMemoryStore({
      githubToken: 'gho_token',
      updatedAt: 0,
    })
    const service = new CopilotOAuthService(store)
    let resolveExchange: (value: unknown) => void = () => undefined
    mockedRequestUrl.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveExchange = resolve
      }) as never,
    )

    const pending = service.getUsableCredential()
    await Promise.resolve()
    await service.clearCredential()
    resolveExchange(exchangeResponse('tid=late'))

    await expect(pending).resolves.toBeNull()
    expect(current()).toBeNull()
  })
})
