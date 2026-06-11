import type { LLMProvider } from '../../types/provider.types'

import { resolveRequestTransportMode } from './requestTransport'

export const shouldUseStreamingForProvider = ({
  requestedStream,
  provider,
}: {
  requestedStream: boolean
  provider?: LLMProvider
}): boolean => {
  if (!requestedStream) {
    return false
  }

  if (!provider) {
    return true
  }

  return (
    resolveRequestTransportMode({
      additionalSettings: provider.additionalSettings,
      hasCustomBaseUrl: Boolean(provider.baseUrl?.trim()),
    }) !== 'obsidian'
  )
}
