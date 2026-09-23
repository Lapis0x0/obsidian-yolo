jest.mock('obsidian', () => ({
  requestUrl: jest.fn(),
}))

import { requestUrl } from 'obsidian'

import { listGeminiModelIds } from './geminiModelCatalog'

const requestUrlMock = requestUrl as jest.MockedFunction<typeof requestUrl>

const jsonResponse = (status: number, body: unknown) =>
  ({ status, text: JSON.stringify(body) }) as never

describe('listGeminiModelIds', () => {
  beforeEach(() => {
    requestUrlMock.mockReset()
  })

  it('follows nextPageToken and strips the models/ prefix', async () => {
    requestUrlMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          models: [
            { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
            { name: 'models/text-embedding-004' },
          ],
          nextPageToken: 'page-2',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { models: [{ name: 'models/gemini-2.5-flash' }] }),
      )

    const ids = await listGeminiModelIds({
      apiKey: 'key',
      customHeaders: [{ key: 'X-Custom', value: 'value' }],
    })

    expect(ids).toEqual([
      'gemini-2.5-pro',
      'text-embedding-004',
      'gemini-2.5-flash',
    ])
    expect(requestUrlMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: 'https://generativelanguage.googleapis.com/v1beta/models',
        method: 'GET',
        headers: expect.objectContaining({
          'x-goog-api-key': 'key',
          'X-Custom': 'value',
        }),
      }),
    )
    expect(requestUrlMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: 'https://generativelanguage.googleapis.com/v1beta/models?pageToken=page-2',
      }),
    )
  })

  it('strips a trailing API version from a custom base URL', async () => {
    requestUrlMock.mockResolvedValueOnce(jsonResponse(200, { models: [] }))

    await listGeminiModelIds({
      apiKey: 'key',
      baseUrl: 'https://proxy.example.com/gemini/v1beta/',
    })

    expect(requestUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://proxy.example.com/gemini/v1beta/models',
      }),
    )
  })

  it('surfaces the API error message on failure', async () => {
    requestUrlMock.mockResolvedValueOnce(
      jsonResponse(400, { error: { message: 'API key not valid.' } }),
    )

    await expect(listGeminiModelIds({ apiKey: 'bad' })).rejects.toThrow(
      'Failed to fetch models: 400 API key not valid.',
    )
  })
})
