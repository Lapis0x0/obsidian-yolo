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
import { CopilotOAuthError } from '../auth/copilotOAuthService'

import { AnthropicProvider } from './anthropic'
import { BaseLLMProvider } from './base'
import {
  COPILOT_AUTO_MODEL_ID,
  CopilotAutoRoutingInput,
  findCopilotAutoSessionToken,
  getCopilotAutoSession,
  invalidateCopilotAutoSession,
} from './copilotAutoSession'
import { CopilotCredentialSource, createCopilotFetch } from './copilotFetch'
import {
  getCopilotModelCatalog,
  selectCopilotEndpoint,
} from './copilotModelCatalog'
import type { CopilotEndpoint } from './copilotRequestTraits'
import {
  LLMAPIKeyInvalidException,
  LLMProviderNotConfiguredException,
} from './exception'
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

const REAUTH_MESSAGE =
  'GitHub Copilot rejected the login. Please reconnect your GitHub account in settings.'
const NO_SUBSCRIPTION_MESSAGE =
  'This GitHub account has no Copilot access, or Copilot is disabled by policy.'

const findInCauseChain = <T>(
  error: unknown,
  pick: (candidate: unknown) => T | undefined,
): T | undefined => {
  let current: unknown = error
  for (let depth = 0; current && depth < 4; depth += 1) {
    const found = pick(current)
    if (found !== undefined) return found
    const next = current as { cause?: unknown; rawError?: unknown }
    current = next.rawError ?? next.cause
  }
  return undefined
}

/**
 * The inner providers word a 401 as an API-key problem for their own vendor,
 * and a login failure inside the fetch layer reaches here wrapped by the SDK.
 * A Copilot user has no API key, so both become one Copilot-worded error of
 * the kind the chat surface shows with a "go to settings" action.
 */
const toCopilotAuthError = (
  error: unknown,
): LLMAPIKeyInvalidException | undefined => {
  const loginCode = findInCauseChain(error, (candidate) =>
    candidate instanceof CopilotOAuthError ? candidate.code : undefined,
  )
  if (loginCode === 'no_subscription') {
    return new LLMAPIKeyInvalidException(
      NO_SUBSCRIPTION_MESSAGE,
      error as Error,
    )
  }
  const unauthorized =
    loginCode === 'reauth_required' ||
    findInCauseChain(error, (candidate) =>
      (candidate as { status?: unknown }).status === 401 ? true : undefined,
    )
  return unauthorized
    ? new LLMAPIKeyInvalidException(REAUTH_MESSAGE, error as Error)
    : undefined
}

/** What Copilot Auto routes on: the latest user message and whether it has images. */
const toAutoRoutingInput = (
  request: LLMRequestNonStreaming | LLMRequestStreaming,
): CopilotAutoRoutingInput => {
  const lastUser = [...request.messages]
    .reverse()
    .find((message) => message.role === 'user')
  const content = lastUser?.content
  if (typeof content === 'string') {
    return { prompt: content, hasImage: false }
  }
  const parts = content ?? []
  return {
    prompt: parts
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n'),
    hasImage: parts.some((part) => part.type === 'image_url'),
  }
}

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
      createCopilotFetch(transportFetch, () => this.getCredentialSource(), {
        find: (modelId) => findCopilotAutoSessionToken(provider.id, modelId),
        reject: (sessionToken) =>
          invalidateCopilotAutoSession(provider.id, sessionToken),
      })
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
    try {
      const route = await this.resolveRoute(model, request)
      return await route.provider.generateResponse(
        route.model,
        { ...request, model: route.model.model },
        options,
      )
    } catch (error) {
      throw toCopilotAuthError(error) ?? error
    }
  }

  async streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    try {
      const route = await this.resolveRoute(model, request)
      return await route.provider.streamResponse(
        route.model,
        { ...request, model: route.model.model },
        options,
      )
    } catch (error) {
      throw toCopilotAuthError(error) ?? error
    }
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

  /**
   * The inner provider and the model it is asked for. Auto stands for
   * whichever model Copilot picked for this provider's session, so the
   * request is sent under that model's id and on that model's endpoint.
   */
  private async resolveRoute(
    model: ChatModel,
    request: LLMRequestNonStreaming | LLMRequestStreaming,
  ): Promise<{ provider: BaseLLMProvider<LLMProvider>; model: ChatModel }> {
    if (model.model === COPILOT_AUTO_MODEL_ID) {
      const session = await getCopilotAutoSession(
        this.provider.id,
        this.getCredentialSource(),
        toAutoRoutingInput(request),
      )
      return {
        provider:
          this.endpointProviders[selectCopilotEndpoint(session.selectedModel)],
        model: { ...model, model: session.selectedModel.id },
      }
    }

    const catalog = await getCopilotModelCatalog(
      this.provider.id,
      this.getCredentialSource(),
    )
    const entry = catalog.find((candidate) => candidate.id === model.model)
    return {
      provider: this.endpointProviders[selectCopilotEndpoint(entry)],
      model,
    }
  }
}
