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
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  siliconflow: 'https://api.siliconflow.cn/v1',
  stepfun: 'https://api.stepfun.com/v1',
  minimax: 'https://api.minimax.chat/v1',
  hunyuan: 'https://api.hunyuan.cloud.tencent.com/v1',
  xai: 'https://api.x.ai/v1',
  'together-ai': 'https://api.together.xyz/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  sambanova: 'https://api.sambanova.ai/v1',
  xiaomimimo: 'https://api.xiaomimimo.com/v1',
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

export function resolveDeepSeekAnthropicBaseUrl(
  baseUrl: string | undefined,
): string {
  const normalized = (baseUrl?.trim() || 'https://api.deepseek.com')
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '')

  try {
    const url = new URL(normalized)
    const path = url.pathname.replace(/\/+$/, '')
    if (url.hostname === 'api.deepseek.com' && path === '') {
      return `${normalized}/anthropic`
    }
  } catch {
    // Keep malformed/custom values intact; the request layer will surface the
    // actual connection error instead of a preview-time guess.
  }

  return normalized
}

export function normalizeGeminiProviderBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, '')
  try {
    const url = new URL(trimmed)
    // Gemini requests append /v1beta explicitly.
    url.pathname = url.pathname.replace(/\/?(v1beta|v1alpha1|v1)(\/)?$/, '')
    return url.toString().replace(/\/+$/, '')
  } catch {
    return trimmed.replace(/\/?(v1beta|v1alpha1|v1)(\/)?$/, '')
  }
}

function joinEndpoint(baseUrl: string, endpoint: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`
}

function resolveOpenAICompatibleRequestBaseUrl(
  provider: Pick<
    LLMProvider,
    'presetType' | 'apiType' | 'baseUrl' | 'additionalSettings'
  >,
): string | undefined {
  const baseUrl = resolveProviderBaseUrl(provider)
  if (!baseUrl) {
    return undefined
  }

  if (
    provider.presetType === 'ollama' ||
    provider.presetType === 'lm-studio' ||
    provider.presetType === 'morph'
  ) {
    return joinEndpoint(baseUrl, 'v1')
  }

  return baseUrl
}

export function resolveProviderPrimaryRequestUrl(
  provider: Pick<
    LLMProvider,
    'presetType' | 'apiType' | 'baseUrl' | 'additionalSettings'
  >,
): string | undefined {
  switch (provider.apiType) {
    case 'openai-compatible': {
      const baseUrl = resolveOpenAICompatibleRequestBaseUrl(provider)
      return baseUrl ? joinEndpoint(baseUrl, 'chat/completions') : undefined
    }
    case 'openai-responses': {
      const baseUrl = resolveProviderBaseUrl(provider)
      return baseUrl ? joinEndpoint(baseUrl, 'responses') : undefined
    }
    case 'anthropic': {
      const baseUrl =
        provider.presetType === 'deepseek'
          ? resolveDeepSeekAnthropicBaseUrl(provider.baseUrl)
          : (
              provider.baseUrl?.trim() ||
              getDefaultBaseUrlForPreset(provider.presetType) ||
              'https://api.anthropic.com'
            )
              .replace(/\/+$/, '')
              .replace(/\/v1$/, '')
      return joinEndpoint(baseUrl, 'v1/messages')
    }
    case 'gemini': {
      const baseUrl = normalizeGeminiProviderBaseUrl(
        provider.baseUrl?.trim() ||
          getDefaultBaseUrlForPreset(provider.presetType) ||
          'https://generativelanguage.googleapis.com',
      )
      return joinEndpoint(
        baseUrl,
        'v1beta/models/{model}:streamGenerateContent',
      )
    }
    case 'amazon-bedrock':
      return undefined
  }
}
