import type { LLMProvider } from '../../types/provider.types'

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

  return provider?.additionalSettings?.requestTransportMode !== 'obsidian'
}
