jest.mock('obsidian', () => ({
  requestUrl: jest.fn(),
  normalizePath: (value: string) => value,
}))

import { requestUrl } from 'obsidian'

import {
  GeminiOAuthService,
  buildAuthorizeUrl,
  generatePKCE,
} from './geminiOAuthService'
import { GeminiOAuthCredential, GeminiOAuthStore } from './geminiOAuthStore'

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>

function createStoreMock(): jest.Mocked<GeminiOAuthStore> {
  return {
    getFilePath: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    clear: jest.fn(),
    isExpired: jest.fn(),
  } as unknown as jest.Mocked<GeminiOAuthStore>
}

describe('geminiOAuthService helpers', () => {
  it('builds browser authorization url', async () => {
    const pkce = await generatePKCE()
    const url = new URL(buildAuthorizeUrl(pkce, 'state-1'))

    expect(url.origin).toBe('https://accounts.google.com')
    expect(url.pathname).toBe('/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe(
      '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
    )
    expect(url.searchParams.get('state')).toBe('state-1')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:8085/oauth2callback',
    )
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('access_type')).toBe('offline')
  })
})

describe('GeminiOAuthService', () => {
  beforeEach(() => {
    mockedRequestUrl.mockReset()
  })

  it('refreshes and persists credential', async () => {
    const store = createStoreMock()
    const service = new GeminiOAuthService(store)

    mockedRequestUrl.mockResolvedValue({
      status: 200,
      json: {
        access_token: 'access-2',
        refresh_token: 'refresh-2',
        expires_in: 1200,
      },
    } as never)

    const credential = await service.refreshCredential({
      refreshToken: 'refresh-1',
      email: 'user@example.com',
      projectId: 'project-1',
      managedProjectId: 'managed-1',
    })

    expect(credential.refreshToken).toBe('refresh-2')
    expect(credential.email).toBe('user@example.com')
    expect(credential.managedProjectId).toBe('managed-1')
    expect(store.set.mock.calls).toContainEqual([credential])
  })

  it('returns stored credential when still valid', async () => {
    const store = createStoreMock()
    const service = new GeminiOAuthService(store)
    const credential: GeminiOAuthCredential = {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 60_000,
      updatedAt: Date.now(),
      email: 'user@example.com',
    }

    store.get.mockResolvedValue(credential)
    store.isExpired.mockReturnValue(false)

    await expect(service.getUsableCredential()).resolves.toEqual(credential)
    expect(mockedRequestUrl).not.toHaveBeenCalled()
  })

  it('does not reuse stale explicit project id after settings projectId is cleared', async () => {
    const store = createStoreMock()
    const service = new GeminiOAuthService(store)
    const credential: GeminiOAuthCredential = {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 60_000,
      updatedAt: Date.now(),
      email: 'user@example.com',
      projectId: 'old-explicit-project',
    }

    const loadManagedProjectSpy = jest
      .spyOn(service as never, 'loadManagedProject')
      .mockResolvedValue({
        cloudaicompanionProject: {
          id: 'managed-project',
        },
      } as never)

    const next = await service.ensureProjectContext(credential, undefined)

    expect(loadManagedProjectSpy).toHaveBeenCalledWith(
      'access',
      undefined,
      undefined,
    )
    expect(next).toEqual({
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      expiresAt: credential.expiresAt,
      updatedAt: credential.updatedAt,
      email: credential.email,
      managedProjectId: 'managed-project',
    })
    expect(store.set.mock.calls).toContainEqual([next])
  })
})
