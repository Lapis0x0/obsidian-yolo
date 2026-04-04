import { LLMProvider } from '../../types/provider.types'

import {
  isBedrockMantleProvider,
  isNativeBedrockProvider,
  resolveBedrockMantleBaseUrl,
  resolveBedrockRuntimeBaseUrl,
} from './bedrock'

const DEFAULT_BASE_URL_BY_PRESET: Partial<
  Record<LLMProvider['presetType'], string>
> = {
  openai: 'https://api.openai.com/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  openrouter: 'https://openrouter.ai/api/v1',
}

export function resolveProviderBaseUrl(
  provider: Pick<
    LLMProvider,
    'presetType' | 'apiType' | 'baseUrl' | 'additionalSettings'
  >,
): string | undefined {
  const customBaseUrl = provider.baseUrl?.trim()
  if (customBaseUrl) {
    return customBaseUrl.replace(/\/+$/, '')
  }

  if (isBedrockMantleProvider(provider)) {
    return resolveBedrockMantleBaseUrl(provider)
  }

  return DEFAULT_BASE_URL_BY_PRESET[provider.presetType]
}

export function resolveProviderDisplayBaseUrl(
  provider: Pick<
    LLMProvider,
    'presetType' | 'apiType' | 'baseUrl' | 'additionalSettings'
  >,
): string | undefined {
  if (isNativeBedrockProvider(provider)) {
    return resolveBedrockRuntimeBaseUrl(provider)
  }

  return resolveProviderBaseUrl(provider)
}
