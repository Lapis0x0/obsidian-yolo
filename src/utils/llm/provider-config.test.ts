import { EmbeddingModel } from '../../types/embedding-model.types'
import { LLMProvider } from '../../types/provider.types'

import { reconcileEmbeddingModelsForProviderUpdate } from './provider-config'

const createEmbeddingModels = (): EmbeddingModel[] => [
  {
    id: 'embed-1',
    providerId: 'bedrock',
    model: 'amazon.titan-embed-text-v2:0',
    dimension: 1024,
  },
  {
    id: 'embed-2',
    providerId: 'other',
    model: 'text-embedding-3-large',
    dimension: 3072,
  },
]

const createProvider = (overrides: Partial<LLMProvider> = {}): LLMProvider => ({
  id: 'bedrock',
  presetType: 'amazon-bedrock',
  apiType: 'amazon-bedrock',
  apiKey: 'token',
  additionalSettings: {
    awsRegion: 'us-east-1',
  },
  ...overrides,
})

describe('reconcileEmbeddingModelsForProviderUpdate', () => {
  it('drops embedding models when the updated provider no longer supports embeddings', () => {
    expect(
      reconcileEmbeddingModelsForProviderUpdate({
        embeddingModels: createEmbeddingModels(),
        previousProvider: createProvider(),
        nextProvider: createProvider({
          apiType: 'openai-compatible',
        }),
      }),
    ).toEqual([
      {
        id: 'embed-2',
        providerId: 'other',
        model: 'text-embedding-3-large',
        dimension: 3072,
      },
    ])
  })

  it('remaps embedding models when a supported provider id changes', () => {
    expect(
      reconcileEmbeddingModelsForProviderUpdate({
        embeddingModels: createEmbeddingModels(),
        previousProvider: createProvider(),
        nextProvider: createProvider({
          id: 'bedrock-renamed',
        }),
      }),
    ).toEqual([
      {
        id: 'embed-1',
        providerId: 'bedrock-renamed',
        model: 'amazon.titan-embed-text-v2:0',
        dimension: 1024,
      },
      {
        id: 'embed-2',
        providerId: 'other',
        model: 'text-embedding-3-large',
        dimension: 3072,
      },
    ])
  })
})
