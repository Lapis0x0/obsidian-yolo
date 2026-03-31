import {
  LLMProvider,
  getDefaultApiTypeForPresetType,
} from '../../types/provider.types'

import {
  resolveProviderBaseUrl,
  resolveProviderDisplayBaseUrl,
} from './provider-base-url'
import { providerSupportsEmbedding } from './provider-config'

const createBedrockProvider = (
  overrides: Partial<LLMProvider> = {},
): LLMProvider => ({
  id: 'bedrock',
  presetType: 'amazon-bedrock',
  apiType: 'amazon-bedrock',
  apiKey: 'token',
  additionalSettings: {
    awsRegion: 'us-east-1',
  },
  ...overrides,
})

describe('provider-base-url', () => {
  it('defaults amazon-bedrock preset to the native api type', () => {
    expect(getDefaultApiTypeForPresetType('amazon-bedrock')).toBe(
      'amazon-bedrock',
    )
  })

  it('derives the Bedrock Mantle URL for openai-compatible mode', () => {
    expect(
      resolveProviderBaseUrl(
        createBedrockProvider({
          apiType: 'openai-compatible',
        }),
      ),
    ).toBe('https://bedrock-mantle.us-east-1.api.aws')
  })

  it('keeps a custom base URL override for Bedrock Mantle', () => {
    expect(
      resolveProviderBaseUrl(
        createBedrockProvider({
          apiType: 'openai-compatible',
          baseUrl: 'https://custom-mantle.example/v1/',
        }),
      ),
    ).toBe('https://custom-mantle.example/v1')
  })

  it('shows the Bedrock runtime URL for native providers', () => {
    expect(resolveProviderDisplayBaseUrl(createBedrockProvider())).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com',
    )
  })

  it('only enables embeddings for native Bedrock providers', () => {
    expect(providerSupportsEmbedding(createBedrockProvider())).toBe(true)
    expect(
      providerSupportsEmbedding(
        createBedrockProvider({
          apiType: 'openai-compatible',
        }),
      ),
    ).toBe(false)
  })
})
