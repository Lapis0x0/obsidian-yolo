import { ChatModel } from '../../types/chat-model.types'
import {
  LLMOptions,
  LLMRequestNonStreaming,
  LLMRequestStreaming,
} from '../../types/llm/request'
import {
  LLMResponseNonStreaming,
  LLMResponseStreaming,
} from '../../types/llm/response'
import { LLMProvider } from '../../types/provider.types'
import { getCopilotOAuthService } from '../auth/copilotOAuthRuntime'

import { AnthropicProvider } from './anthropic'
import { BaseLLMProvider } from './base'
import { CopilotCredentialSource, createCopilotFetch } from './copilotFetch'
import {
  getCopilotModelCatalog,
  selectCopilotEndpoint,
} from './copilotModelCatalog'
import type { CopilotEndpoint } from './copilotRequestTraits'
import { LLMProviderNotConfiguredException } from './exception'
import { OpenAICompatibleProvider } from './openaiCompatibleProvider'
import { OpenAIResponsesProvider } from './openaiResponsesProvider'
import { ModelRequestPolicy } from './requestPolicy'
import { AutoPromotedTransportMode } from './requestTransport'

/**
 * The SDK clients are built against this origin and key; `createCopilotFetch`
 * replaces both on every request with the account's API origin and the
 * current Copilot token, which are only known once a request is made.
 */
const PLACEHOLDER_BASE_URL = 'https://api.githubcopilot.com'
const PLACEHOLDER_API_KEY = 'github-copilot'

/**
 * GitHub Copilot serves each model on some of three wire formats — Chat
 * Completions, Responses, Anthropic Messages — as its `/models` catalog
 * declares. Each format's request shaping already lives in a provider, so this
 * one holds one of each and forwards a request to the one the model calls for;
 * all three share the Copilot fetch layer for auth and headers.
 */
export class CopilotProvider extends BaseLLMProvider<LLMProvider> {
  private readonly endpointProviders: Record<
    CopilotEndpoint,
    BaseLLMProvider<LLMProvider>
  >

  constructor(
    provider: LLMProvider,
    options?: {
      requestPolicy?: ModelRequestPolicy
      onAutoPromoteTransportMode?: (mode: AutoPromotedTransportMode) => void
    },
  ) {
    super(provider)
    // One shared object, so a transport auto-promotion recorded by one inner
    // provider is seen by the other two.
    const innerProvider: LLMProvider = {
      ...provider,
      baseUrl: PLACEHOLDER_BASE_URL,
      apiKey: PLACEHOLDER_API_KEY,
    }
    const wrapFetch = (transportFetch: typeof fetch) =>
      createCopilotFetch(transportFetch, () => this.getCredentialSource())
    const innerOptions = {
      requestPolicy: options?.requestPolicy,
      onAutoPromoteTransportMode: options?.onAutoPromoteTransportMode,
      wrapFetch,
    }

    this.endpointProviders = {
      chat: new OpenAICompatibleProvider(innerProvider, innerOptions),
      responses: new OpenAIResponsesProvider(innerProvider, innerOptions),
      messages: new AnthropicProvider(innerProvider, {
        ...innerOptions,
        // Copilot's Messages gateway does not implement Anthropic betas, so
        // `thinking.block_binding` (and its beta header) stays out.
        thinkingBlockBinding: false,
      }),
    }
  }

  async generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    const provider = await this.resolveEndpointProvider(model)
    return provider.generateResponse(model, request, options)
  }

  async streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    const provider = await this.resolveEndpointProvider(model)
    return provider.streamResponse(model, request, options)
  }

  async getEmbedding(
    _model: string,
    _text: string,
    _options?: { dimensions?: number },
  ): Promise<number[]> {
    throw new LLMProviderNotConfiguredException(
      'GitHub Copilot provider does not support embeddings.',
    )
  }

  private getCredentialSource(): CopilotCredentialSource {
    const service = getCopilotOAuthService(this.provider.id)
    if (!service) {
      throw new LLMProviderNotConfiguredException(
        'GitHub Copilot login service is not initialized.',
      )
    }
    return service
  }

  private async resolveEndpointProvider(
    model: ChatModel,
  ): Promise<BaseLLMProvider<LLMProvider>> {
    const catalog = await getCopilotModelCatalog(
      this.provider.id,
      this.getCredentialSource(),
    )
    const entry = catalog.find((candidate) => candidate.id === model.model)
    return this.endpointProviders[selectCopilotEndpoint(entry)]
  }
}
