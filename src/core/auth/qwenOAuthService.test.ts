jest.mock('obsidian', () => ({
  requestUrl: jest.fn(),
  normalizePath: (value: string) => value,
}))

import { requestUrl } from 'obsidian'

import { QwenOAuthService, generatePKCE } from './qwenOAuthService'
import { QwenOAuthStore } from './qwenOAuthStore'

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>

function createStoreMock(): jest.Mocked<QwenOAuthStore> {
  return {
    getFilePath: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    clear: jest.fn(),
    isExpired: jest.fn(),
  } as unknown as jest.Mocked<QwenOAuthStore>
}

describe('qwenOAuthService helpers', () => {
  it('generates PKCE pair', async () => {
    const pkce = await generatePKCE()
    expect(pkce.verifier.length).toBeGreaterThan(10)
    expect(pkce.challenge.length).toBeGreaterThan(10)
  })
})

describe('QwenOAuthService', () => {
  beforeEach(() => {
    mockedRequestUrl.mockReset()
  })

  it('starts device authorization and resolves credential', async () => {
    const store = createStoreMock()
    const service = new QwenOAuthService(store)

    mockedRequestUrl
      .mockResolvedValueOnce({
        status: 200,
        json: {
          device_code: 'device-1',
          verification_uri: 'https://chat.qwen.ai/device',
          verification_uri_complete: 'https://chat.qwen.ai/device?code=abc',
          expires_in: 300,
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        json: {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 1200,
          resource_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        },
      } as never)

    const authorization = await service.beginBrowserAuthorization()
    expect(authorization.authorizationUrl).toBe(
      'https://chat.qwen.ai/device?code=abc',
    )

    const credential = await authorization.complete
    expect(credential.accessToken).toBe('access-1')
    expect(credential.resourceUrl).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    )
    expect(store.set.mock.calls).toContainEqual([credential])
  })

  it('refreshes and persists credential', async () => {
    const store = createStoreMock()
    const service = new QwenOAuthService(store)

    mockedRequestUrl.mockResolvedValue({
      status: 200,
      json: {
        access_token: 'access-2',
        expires_in: 1800,
      },
    } as never)

    const credential = await service.refreshCredential({
      refreshToken: 'refresh-1',
      resourceUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    })

    expect(credential.refreshToken).toBe('refresh-1')
    expect(credential.resourceUrl).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    )
    expect(store.set.mock.calls).toContainEqual([credential])
  })
})
