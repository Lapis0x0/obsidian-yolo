import { LLMProvider } from '../../types/provider.types'

import {
  isBedrockMantleProvider,
  isNativeBedrockProvider,
  resolveBedrockMantleBaseUrl,
  resolveBedrockRuntimeBaseUrl,
} from './bedrock'

/**
 * Default base URL each preset would use when the user leaves the field empty.
 * The value here is the URL the user would naturally type into the form (i.e. without
 * any provider-specific suffix such as `/v1` that the OpenAI-compatible adapter appends
 * for ollama / lm-studio / morph).
 *
 * Note: `anthropic` / `gemini` are listed for form auto-fill only — their providers
 * (anthropic.ts / gemini.ts) read `provider.baseUrl` directly and rely on the SDK
 * default when it is empty, so they do not consume `resolveProviderBaseUrl`. Do not
 * switch those providers to `resolveProviderBaseUrl` without verifying SDK path
 * conventions (Gemini SDK appends `/v1beta`, Anthropic SDK appends `/v1`).
 */
const DEFAULT_BASE_URL_BY_PRESET: Partial<
  Record<LLMProvider['presetType'], string>
> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  deepseek: 'https://api.deepseek.com',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://127.0.0.1:11434',
  'lm-studio': 'http://127.0.0.1:1234',
  moonshot: 'https://api.moonshot.cn/v1',
  perplexity: 'https://api.perplexity.ai',
  mistral: 'https://api.mistral.ai/v1',
  morph: 'https://api.morphllm.com',
}

export function getDefaultBaseUrlForPreset(
  presetType: LLMProvider['presetType'],
): string | undefined {
  return DEFAULT_BASE_URL_BY_PRESET[presetType]
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
