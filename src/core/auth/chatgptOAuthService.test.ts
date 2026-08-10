jest.mock('obsidian', () => ({
  requestUrl: jest.fn(),
  normalizePath: (value: string) => value,
}))
jest.mock('../../utils/platform/desktopNodeModule', () => ({
  loadDesktopNodeModule: jest.fn(),
}))

import { requestUrl } from 'obsidian'

import { loadDesktopNodeModule } from '../../utils/platform/desktopNodeModule'

import {
  ChatGPTOAuthService,
  buildAuthorizeUrl,
  extractAccountId,
  extractAccountIdFromClaims,
  generatePKCE,
  parseJwtClaims,
} from './chatgptOAuthService'
import { ChatGPTOAuthCredential, ChatGPTOAuthStore } from './chatgptOAuthStore'

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>
const mockedLoadDesktopNodeModule =
  loadDesktopNodeModule as jest.MockedFunction<typeof loadDesktopNodeModule>

function createJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString(
    'base64url',
  )
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

function createStoreMock(): jest.Mocked<ChatGPTOAuthStore> {
  return {
    getFilePath: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    clear: jest.fn(),
    isExpired: jest.fn(),
  } as unknown as jest.Mocked<ChatGPTOAuthStore>
}

describe('chatgptOAuthService helpers', () => {
  it('builds browser authorization url', async () => {
    const pkce = await generatePKCE()
    const url = new URL(
      buildAuthorizeUrl('http://localhost:1455/auth/callback', pkce, 'state-1'),
    )

    expect(url.origin).toBe('https://auth.openai.com')
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe(
      'app_EMoamEEZ73f0CkXaXp7hrann',
    )
    expect(url.searchParams.get('state')).toBe('state-1')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:1455/auth/callback',
    )
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('originator')).toBe('opencode')
  })

  it('parses JWT claims', () => {
    const token = createJwt({ chatgpt_account_id: 'acc-1' })
    expect(parseJwtClaims(token)).toEqual({ chatgpt_account_id: 'acc-1' })
  })

  it('extracts account id from nested auth claims', () => {
    expect(
      extractAccountIdFromClaims({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acc-nested' },
      }),
    ).toBe('acc-nested')
  })

  it('extracts account id from tokens', () => {
    expect(
      extractAccountId({
        id_token: createJwt({ organizations: [{ id: 'org-1' }] }),
        access_token: createJwt({ chatgpt_account_id: 'acc-2' }),
      }),
    ).toBe('org-1')
  })
})

describe('ChatGPTOAuthService', () => {
  beforeEach(() => {
    mockedRequestUrl.mockReset()
    mockedLoadDesktopNodeModule.mockReset()
  })

  it('reports the underlying error for every unavailable callback port', async () => {
    const store = createStoreMock()
    const service = new ChatGPTOAuthService(store)

    mockedLoadDesktopNodeModule.mockRejectedValue(
      new Error('Node.js modules are unavailable in this Obsidian runtime.'),
    )

    await expect(service.beginBrowserAuthorization()).rejects.toThrow(
      'Failed to start local OAuth callback server: 127.0.0.1:1455 — Node.js modules are unavailable in this Obsidian runtime.; 127.0.0.1:1457 — Node.js modules are unavailable in this Obsidian runtime.',
    )
    expect(mockedLoadDesktopNodeModule).toHaveBeenCalledTimes(2)
  })

  it('binds the callback server to IPv4 while keeping localhost in the redirect URI', async () => {
    const store = createStoreMock()
    const service = new ChatGPTOAuthService(store)
    let notifyListening: (() => void) | undefined
    let handleRequest: jest.Mock | undefined
    const server: {
      once: jest.Mock
      removeListener: jest.Mock
      listen: jest.Mock
      address: jest.Mock
      close: jest.Mock
    } = {
      once: jest.fn((event: string, listener: () => void) => {
        if (event === 'listening') {
          notifyListening = listener
        }
        return server
      }),
      removeListener: jest.fn(() => server),
      listen: jest.fn(() => {
        notifyListening?.()
        return server
      }),
      address: jest.fn(() => ({ port: 1455 })),
      close: jest.fn(),
    }
    const createServer = jest.fn((listener: unknown) => {
      handleRequest = listener as jest.Mock
      return server
    })
    mockedLoadDesktopNodeModule.mockResolvedValue({ createServer } as never)

    const authorization = await service.beginBrowserAuthorization()

    expect(server.listen).toHaveBeenCalledWith(1455, '127.0.0.1')
    expect(authorization.redirectUri).toBe(
      'http://localhost:1455/auth/callback',
    )
    expect(
      new URL(authorization.authorizationUrl).searchParams.get('redirect_uri'),
    ).toBe('http://localhost:1455/auth/callback')

    const response = {
      writeHead: jest.fn(),
      end: jest.fn(),
    }
    const completion = expect(authorization.complete).rejects.toThrow(
      'ChatGPT OAuth login was cancelled.',
    )
    handleRequest?.({ url: '/cancel' }, response)
    await completion
    expect(response.writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'text/html; charset=utf-8',
      Connection: 'close',
    })
    expect(server.close).toHaveBeenCalledTimes(1)
  })

  it('starts device authorization', async () => {
    const store = createStoreMock()
    const service = new ChatGPTOAuthService(store)

    mockedRequestUrl.mockResolvedValue({
      status: 200,
      json: {
        device_auth_id: 'dev-1',
        user_code: 'ABCD-EFGH',
        interval: '5',
      },
    } as never)

    await expect(service.beginDeviceAuthorization()).resolves.toEqual({
      deviceAuthId: 'dev-1',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.openai.com/codex/device',
      intervalMs: 5000,
    })
  })

  it('rejects an invalid device authorization payload', async () => {
    const service = new ChatGPTOAuthService(createStoreMock())

    mockedRequestUrl.mockResolvedValue({
      status: 200,
      json: { interval: '5' },
    } as never)

    await expect(service.beginDeviceAuthorization()).rejects.toThrow(
      'Device authorization returned an invalid user code payload',
    )
  })

  it('polls device authorization and persists the exchanged credential', async () => {
    const setCredentials: jest.MockedFunction<ChatGPTOAuthStore['set']> =
      jest.fn()
    const store = createStoreMock()
    store.set = setCredentials
    const service = new ChatGPTOAuthService(store)

    mockedRequestUrl
      .mockResolvedValueOnce({
        status: 200,
        json: {
          authorization_code: 'authorization-code',
          code_verifier: 'code-verifier',
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        json: {
          access_token: createJwt({ chatgpt_account_id: 'acc-device' }),
          refresh_token: 'refresh-device',
          expires_in: 3600,
        },
      } as never)

    await expect(
      service.pollDeviceAuthorization({
        deviceAuthId: 'dev-1',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://auth.openai.com/codex/device',
        intervalMs: 5000,
      }),
    ).resolves.toMatchObject({
      refreshToken: 'refresh-device',
      accountId: 'acc-device',
    })
    expect(setCredentials).toHaveBeenCalledTimes(1)
  })

  it('does not poll when device authorization is already cancelled', async () => {
    const service = new ChatGPTOAuthService(createStoreMock())
    const abortController = new AbortController()
    abortController.abort()

    await expect(
      service.pollDeviceAuthorization(
        {
          deviceAuthId: 'dev-1',
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://auth.openai.com/codex/device',
          intervalMs: 5000,
        },
        abortController.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(mockedRequestUrl).not.toHaveBeenCalled()
  })

  it('refreshes and persists credential', async () => {
    const store = createStoreMock()
    const service = new ChatGPTOAuthService(store)

    mockedRequestUrl.mockResolvedValue({
      status: 200,
      json: {
        access_token: createJwt({ chatgpt_account_id: 'acc-3' }),
        refresh_token: 'refresh-2',
        expires_in: 1200,
      },
    } as never)

    const credential = await service.refreshCredential({
      refreshToken: 'refresh-1',
      accountId: 'acc-old',
    })

    expect(credential.refreshToken).toBe('refresh-2')
    expect(credential.accountId).toBe('acc-3')
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
    const setMock = store.set
    expect(setMock).toHaveBeenCalledWith(credential)
  })

  it('returns stored credential when still valid', async () => {
    const store = createStoreMock()
    const service = new ChatGPTOAuthService(store)
    const credential: ChatGPTOAuthCredential = {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 60_000,
      updatedAt: Date.now(),
    }

    store.get.mockResolvedValue(credential)
    store.isExpired.mockReturnValue(false)

    await expect(service.getUsableCredential()).resolves.toEqual(credential)
    expect(mockedRequestUrl).not.toHaveBeenCalled()
  })
})
