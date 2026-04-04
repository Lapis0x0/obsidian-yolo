import { LLMProvider } from '../../types/provider.types'

import { KimiMessageAdapter } from './kimiMessageAdapter'
import { OpenAICompatibleProvider } from './openaiCompatibleProvider'
import { AutoPromotedTransportMode } from './requestTransport'
import { ModelRequestPolicy } from './requestPolicy'

export class MoonshotProvider extends OpenAICompatibleProvider {
  constructor(
    provider: LLMProvider,
    options?: {
      onAutoPromoteTransportMode?: (mode: AutoPromotedTransportMode) => void
      requestPolicy?: ModelRequestPolicy
    },
  ) {
    super(provider, {
      ...options,
      adapter: new KimiMessageAdapter(),
    })
  }
}
