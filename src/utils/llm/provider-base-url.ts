import { LLMProvider } from '../../types/provider.types'

const DEFAULT_BASE_URL_BY_PRESET: Partial<
  Record<LLMProvider['presetType'], string>
> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
}

export function resolveProviderBaseUrl(
  provider: Pick<LLMProvider, 'presetType' | 'baseUrl'>,
): string | undefined {
  const customBaseUrl = provider.baseUrl?.trim()
  if (customBaseUrl) {
    return customBaseUrl.replace(/\/+$/, '')
  }

  return DEFAULT_BASE_URL_BY_PRESET[provider.presetType]
}
