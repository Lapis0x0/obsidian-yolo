jest.mock('obsidian', () => ({
  requestUrl: jest.fn(),
  normalizePath: (value: string) => value,
}))

import { requestUrl } from 'obsidian'

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
      buildAuthorizeUrl('http://127.0.0.1:1455/auth/callback', pkce, 'state-1'),
    )

    expect(url.origin).toBe('https://auth.openai.com')
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe(
      'app_EMoamEEZ73f0CkXaXp7hrann',
    )
    expect(url.searchParams.get('state')).toBe('state-1')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:1455/auth/callback',
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
