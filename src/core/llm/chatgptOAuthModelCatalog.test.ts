jest.mock('obsidian', () => ({
  requestUrl: jest.fn(),
}))

import { requestUrl } from 'obsidian'

import { listChatGPTOAuthModels } from './chatgptOAuthModelCatalog'

const requestUrlMock = requestUrl as jest.MockedFunction<typeof requestUrl>

describe('listChatGPTOAuthModels', () => {
  beforeEach(() => {
    requestUrlMock.mockReset()
  })

  it('extracts model slugs and filters hidden models', async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        data: [
          { slug: 'gpt-5.3-codex-spark' },
          { slug: 'hidden-model', visibility: 'hide' },
          { id: 'gpt-5.5' },
        ],
      },
      text: '',
    } as never)

    const models = await listChatGPTOAuthModels({
      accessToken: 'access-token',
      accountId: 'account-id',
      headers: { 'X-Custom': 'value' },
      clientVersion: '1.5.12',
    })

    expect(models).toEqual(['gpt-5.3-codex-spark', 'gpt-5.5'])
    expect(requestUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://chatgpt.com/backend-api/codex/models?client_version=1.5.12',
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer access-token',
          'ChatGPT-Account-Id': 'account-id',
          'X-Custom': 'value',
          originator: 'opencode',
        }),
      }),
    )
  })

  it('truncates 4-segment version to 3-segment semver', async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: { models: [{ slug: 'gpt-5.4' }] },
      text: '',
    } as never)

    const models = await listChatGPTOAuthModels({
      accessToken: 'access-token',
      clientVersion: '1.5.12.8',
    })

    expect(models).toEqual(['gpt-5.4'])
    expect(requestUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://chatgpt.com/backend-api/codex/models?client_version=1.5.12',
      }),
    )
  })

  it('passes 3-segment version unchanged', async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: { models: [{ slug: 'gpt-5.5' }] },
      text: '',
    } as never)

    await listChatGPTOAuthModels({
      accessToken: 'access-token',
      clientVersion: '2.0.0',
    })

    expect(requestUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://chatgpt.com/backend-api/codex/models?client_version=2.0.0',
      }),
    )
  })

  it('throws when the endpoint returns an error', async () => {
    requestUrlMock.mockResolvedValue({
      status: 400,
      json: { error: { message: 'Invalid client_version format' } },
      text: '',
    } as never)

    await expect(
      listChatGPTOAuthModels({
        accessToken: 'access-token',
        clientVersion: '1.0.0',
      }),
    ).rejects.toThrow('Failed to fetch models')
  })
})
