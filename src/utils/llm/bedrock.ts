import { LLMProvider } from '../../types/provider.types'

type BedrockAdditionalSettings = {
  awsRegion?: string
}

type BedrockProviderLike = Pick<
  LLMProvider,
  'presetType' | 'apiType' | 'apiKey' | 'additionalSettings'
>

export function getBedrockRegion(
  provider: Pick<LLMProvider, 'additionalSettings'>,
): string | undefined {
  const additionalSettings =
    (provider.additionalSettings as BedrockAdditionalSettings) ?? {}
  const awsRegion = additionalSettings.awsRegion?.trim()
  return awsRegion ? awsRegion : undefined
}

export function resolveBedrockMantleBaseUrl(
  provider: Pick<LLMProvider, 'additionalSettings'>,
): string | undefined {
  const region = getBedrockRegion(provider)
  if (!region) {
    return undefined
  }

  return `https://bedrock-mantle.${region}.api.aws`
}

export function resolveBedrockRuntimeBaseUrl(
  provider: Pick<LLMProvider, 'additionalSettings'>,
): string | undefined {
  const region = getBedrockRegion(provider)
  if (!region) {
    return undefined
  }

  return `https://bedrock-runtime.${region}.amazonaws.com`
}

export function isNativeBedrockProvider(
  provider: BedrockProviderLike,
): boolean {
  return (
    provider.presetType === 'amazon-bedrock' &&
    provider.apiType === 'amazon-bedrock'
  )
}

export function isBedrockMantleProvider(
  provider: BedrockProviderLike,
): boolean {
  return (
    provider.presetType === 'amazon-bedrock' &&
    provider.apiType === 'openai-compatible'
  )
}

export function createBedrockBearerClientConfig(
  provider: Pick<LLMProvider, 'apiKey' | 'additionalSettings'>,
): {
  region: string
  token: { token: string }
  authSchemePreference: ['httpBearerAuth']
} {
  const region = getBedrockRegion(provider)
  if (!region) {
    throw new Error('AWS region is required for Amazon Bedrock providers.')
  }
  const token = provider.apiKey?.trim()
  if (!token) {
    throw new Error('Amazon Bedrock API key (bearer token) is required.')
  }

  return {
    region,
    token: { token },
    authSchemePreference: ['httpBearerAuth'],
  }
}

export function isSupportedBedrockEmbeddingModel(modelId: string): boolean {
  const normalizedModelId = modelId.toLowerCase()

  return (
    normalizedModelId.startsWith('amazon.titan-embed') ||
    normalizedModelId.startsWith('cohere.embed')
  )
}

export function buildBedrockEmbeddingRequestBody(
  modelId: string,
  text: string,
): Record<string, unknown> {
  const normalizedModelId = modelId.toLowerCase()

  if (normalizedModelId.startsWith('amazon.titan-embed')) {
    return {
      inputText: text,
    }
  }

  if (normalizedModelId.startsWith('cohere.embed')) {
    return {
      texts: [text],
      input_type: 'search_document',
      embedding_types: ['float'],
    }
  }

  throw new Error(
    `Embedding is not yet supported for the Bedrock model family "${modelId}". Please use a text embedding model such as amazon.titan-embed-* or cohere.embed-*.`,
  )
}
