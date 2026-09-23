jest.mock('obsidian', () => ({
  requestUrl: jest.fn(),
}))

import { requestUrl } from 'obsidian'

import {
  listBedrockChatModelIds,
  listBedrockEmbeddingModelIds,
} from './bedrockCatalog'

const requestUrlMock = requestUrl as jest.MockedFunction<typeof requestUrl>

const provider = {
  apiKey: ' bearer-key ',
  additionalSettings: { awsRegion: 'us-west-2' },
}

const jsonResponse = (status: number, body: unknown) =>
  ({ status, text: JSON.stringify(body) }) as never

describe('bedrockCatalog', () => {
  beforeEach(() => {
    requestUrlMock.mockReset()
  })

  it('lists active on-demand text models with a bearer token', async () => {
    requestUrlMock.mockResolvedValueOnce(
      jsonResponse(200, {
        modelSummaries: [
          {
            modelId: 'anthropic.claude-sonnet',
            inputModalities: ['TEXT', 'IMAGE'],
            outputModalities: ['TEXT'],
            modelLifecycle: { status: 'ACTIVE' },
          },
          {
            modelId: 'amazon.old-model',
            inputModalities: ['TEXT'],
            outputModalities: ['TEXT'],
            modelLifecycle: { status: 'LEGACY' },
          },
          {
            modelId: 'amazon.titan-embed-text-v2:0',
            inputModalities: ['TEXT'],
            outputModalities: ['EMBEDDING'],
            modelLifecycle: { status: 'ACTIVE' },
          },
          {
            modelId: 'amazon.nova-pro',
            inputModalities: ['TEXT'],
            outputModalities: ['TEXT'],
            modelLifecycle: { status: 'ACTIVE' },
          },
        ],
      }),
    )

    await expect(listBedrockChatModelIds(provider)).resolves.toEqual([
      'amazon.nova-pro',
      'anthropic.claude-sonnet',
    ])
    expect(requestUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://bedrock.us-west-2.amazonaws.com/foundation-models?byOutputModality=TEXT&byInferenceType=ON_DEMAND',
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer bearer-key',
        }),
      }),
    )
  })

  it('keeps only supported embedding families', async () => {
    requestUrlMock.mockResolvedValueOnce(
      jsonResponse(200, {
        modelSummaries: [
          {
            modelId: 'cohere.embed-english-v3',
            inputModalities: ['TEXT'],
            outputModalities: ['EMBEDDING'],
          },
          {
            modelId: 'amazon.titan-embed-image-v1',
            inputModalities: ['IMAGE'],
            outputModalities: ['EMBEDDING'],
          },
          {
            modelId: 'twelvelabs.marengo-embed',
            inputModalities: ['TEXT'],
            outputModalities: ['EMBEDDING'],
          },
        ],
      }),
    )

    await expect(listBedrockEmbeddingModelIds(provider)).resolves.toEqual([
      'cohere.embed-english-v3',
    ])
    expect(requestUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://bedrock.us-west-2.amazonaws.com/foundation-models?byOutputModality=EMBEDDING&byInferenceType=ON_DEMAND',
      }),
    )
  })

  it('surfaces the service error message on failure', async () => {
    requestUrlMock.mockResolvedValueOnce(
      jsonResponse(403, { Message: 'Invalid API Key format' }),
    )

    await expect(listBedrockChatModelIds(provider)).rejects.toThrow(
      'Failed to fetch models: 403 Invalid API Key format',
    )
  })

  it('requires a region before sending a request', async () => {
    await expect(
      listBedrockChatModelIds({ apiKey: 'key', additionalSettings: {} }),
    ).rejects.toThrow('AWS region is required')
    expect(requestUrlMock).not.toHaveBeenCalled()
  })
})
