import {
  LLMProvider,
  getDefaultApiTypeForPresetType,
} from '../../types/provider.types'

import {
  resolveProviderBaseUrl,
  resolveProviderDisplayBaseUrl,
  resolveProviderPrimaryRequestUrl,
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

  it('defaults moonshot preset to openai-compatible', () => {
    expect(getDefaultApiTypeForPresetType('moonshot')).toBe('openai-compatible')
  })

  it('uses the Moonshot API URL for moonshot providers', () => {
    expect(
      resolveProviderBaseUrl({
        presetType: 'moonshot',
        apiType: 'openai-compatible',
      }),
    ).toBe('https://api.moonshot.cn/v1')
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

  it('previews OpenAI-compatible chat completions URL', () => {
    expect(
      resolveProviderPrimaryRequestUrl({
        presetType: 'openrouter',
        apiType: 'openai-compatible',
        baseUrl: 'https://openrouter.ai/api/v1',
      }),
    ).toBe('https://openrouter.ai/api/v1/chat/completions')
  })

  it('previews URLs without duplicate slashes', () => {
    expect(
      resolveProviderPrimaryRequestUrl({
        presetType: 'openai-compatible',
        apiType: 'openai-compatible',
        baseUrl: 'https://proxy.example/openai/',
      }),
    ).toBe('https://proxy.example/openai/chat/completions')
  })

  it('previews OpenAI Responses URL', () => {
    expect(
      resolveProviderPrimaryRequestUrl({
        presetType: 'openai',
        apiType: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1/',
      }),
    ).toBe('https://api.openai.com/v1/responses')
  })

  it('previews Anthropic messages URL when base URL already includes v1', () => {
    expect(
      resolveProviderPrimaryRequestUrl({
        presetType: 'anthropic',
        apiType: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
      }),
    ).toBe('https://api.anthropic.com/v1/messages')
  })

  it('previews DeepSeek Anthropic-compatible messages URL', () => {
    expect(
      resolveProviderPrimaryRequestUrl({
        presetType: 'deepseek',
        apiType: 'anthropic',
      }),
    ).toBe('https://api.deepseek.com/anthropic/v1/messages')
  })

  it('previews Gemini streamGenerateContent URL with a model placeholder', () => {
    expect(
      resolveProviderPrimaryRequestUrl({
        presetType: 'gemini',
        apiType: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/',
      }),
    ).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent',
    )
  })

  it('previews local OpenAI-compatible providers with the runtime v1 suffix', () => {
    expect(
      resolveProviderPrimaryRequestUrl({
        presetType: 'ollama',
        apiType: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434',
      }),
    ).toBe('http://127.0.0.1:11434/v1/chat/completions')
    expect(
      resolveProviderPrimaryRequestUrl({
        presetType: 'lm-studio',
        apiType: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1234',
      }),
    ).toBe('http://127.0.0.1:1234/v1/chat/completions')
    expect(
      resolveProviderPrimaryRequestUrl({
        presetType: 'morph',
        apiType: 'openai-compatible',
        baseUrl: 'https://api.morphllm.com',
      }),
    ).toBe('https://api.morphllm.com/v1/chat/completions')
  })
})
