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
      clientVersion: '1.5.12.7',
    })

    expect(models).toEqual(['gpt-5.3-codex-spark', 'gpt-5.5'])
    expect(requestUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://chatgpt.com/backend-api/codex/models',
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

  it('retries the same models endpoint with client_version after an empty response', async () => {
    requestUrlMock
      .mockResolvedValueOnce({
        status: 200,
        json: { data: [] },
        text: '',
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        json: { models: [{ slug: 'gpt-5.4' }] },
        text: '',
      } as never)

    const models = await listChatGPTOAuthModels({
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      accessToken: 'access-token',
      clientVersion: '1.5.12.7 beta',
    })

    expect(models).toEqual(['gpt-5.4'])
    expect(requestUrlMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: 'https://chatgpt.com/backend-api/codex/models',
      }),
    )
    expect(requestUrlMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: 'https://chatgpt.com/backend-api/codex/models?client_version=1.5.12.7%20beta',
      }),
    )
  })
})
