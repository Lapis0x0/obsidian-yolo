import type { GenerateContentResponse as GeminiGenerateContentResponse } from '@google/genai'

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
import { LLMProvider, RequestTransportMode } from '../../types/provider.types'
import {
  REASONING_META,
  resolveRequestReasoningLevel,
} from '../../types/reasoning'
import { createObsidianFetch } from '../../utils/llm/obsidian-fetch'
import { toProviderHeadersRecord } from '../../utils/llm/provider-headers'
import { getGeminiOAuthService } from '../auth/geminiOAuthRuntime'

import { BaseLLMProvider } from './base'
import { LLMProviderNotConfiguredException } from './exception'
import { GeminiProvider } from './gemini'
import {
  type GeminiFetchRequest,
  type GeminiTransportContext,
  type GeminiUnwrap,
  geminiGenerateViaFetch,
  geminiStreamViaBufferedFetch,
  geminiStreamViaFetch,
} from './geminiFetchTransport'
import { ModelRequestPolicy } from './requestPolicy'
import {
  createRequestTransportMemoryKey,
  resolveRequestTransportMode,
  runWithRequestTransport,
  runWithRequestTransportForStream,
} from './requestTransport'
import { createBrowserFetch, createDesktopNodeFetch } from './sdkFetch'

const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com'
const PROVIDER_LABEL = 'Gemini OAuth'

type CodeAssistResponseEnvelope = {
  response?: GeminiGenerateContentResponse & { responseId?: string }
  traceId?: string
}

// Code Assist wraps the native Gemini response as `{ response, traceId }` for
// non-streaming calls and as bare chunks (sometimes with `responseId`) for SSE.
// Surface either shape as the native response.
const unwrapCodeAssistResponse: GeminiUnwrap = (raw) => {
  const value = raw as
    | CodeAssistResponseEnvelope
    | GeminiGenerateContentResponse
  if (
    value &&
    typeof value === 'object' &&
    'response' in value &&
    value.response
  ) {
    const responseId = value.response.responseId ?? value.traceId
    return (
      responseId ? { ...value.response, responseId } : value.response
    ) as GeminiGenerateContentResponse & { responseId?: string }
  }
  return value as GeminiGenerateContentResponse & { responseId?: string }
}

export class GeminiOAuthProvider extends BaseLLMProvider<LLMProvider> {
  private readonly browserFetch = createBrowserFetch()
  private readonly obsidianFetch = createObsidianFetch()
  private readonly nodeFetch = createDesktopNodeFetch()
  private readonly requestTransportMemoryKey: string
  private readonly requestTransportMode: RequestTransportMode
  private readonly requestPolicy?: ModelRequestPolicy
  private readonly transportContext: GeminiTransportContext

  constructor(
    provider: LLMProvider,
    options?: {
      requestPolicy?: ModelRequestPolicy
    },
  ) {
    super(provider)
    this.requestPolicy = options?.requestPolicy
    this.requestTransportMemoryKey = createRequestTransportMemoryKey({
      providerType: provider.presetType,
      providerId: provider.id,
      baseUrl: CODE_ASSIST_ENDPOINT,
    })
    this.requestTransportMode = resolveRequestTransportMode({
      additionalSettings: provider.additionalSettings,
      hasCustomBaseUrl: false,
      memoryKey: this.requestTransportMemoryKey,
    })
    this.transportContext = {
      providerLabel: PROVIDER_LABEL,
      requestPolicy: this.requestPolicy,
      unwrap: unwrapCodeAssistResponse,
    }
  }

  async getEmbedding(
    _model: string,
    _text: string,
    _options?: { dimensions?: number },
  ): Promise<number[]> {
    throw new LLMProviderNotConfiguredException(
      'Gemini OAuth provider does not support embeddings.',
    )
  }

  async generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    const payload = await this.buildWrappedPayload(model, request, options)
    const fetchRequest: GeminiFetchRequest = {
      url: `${CODE_ASSIST_ENDPOINT}/v1internal:generateContent`,
      headers: payload.headers,
      body: payload.body,
    }

    return runWithRequestTransport({
      mode: this.requestTransportMode,
      memoryKey: this.requestTransportMemoryKey,
      runBrowser: () =>
        geminiGenerateViaFetch({
          fetchImpl: this.browserFetch,
          request: fetchRequest,
          model: request.model,
          signal: options?.signal,
          parse: GeminiProvider.parseNonStreamingResponse,
          context: this.transportContext,
        }),
      runObsidian: () =>
        geminiGenerateViaFetch({
          fetchImpl: this.obsidianFetch,
          request: fetchRequest,
          model: request.model,
          signal: options?.signal,
          parse: GeminiProvider.parseNonStreamingResponse,
          context: this.transportContext,
        }),
      runNode: () =>
        geminiGenerateViaFetch({
          fetchImpl: this.nodeFetch,
          request: fetchRequest,
          model: request.model,
          signal: options?.signal,
          parse: GeminiProvider.parseNonStreamingResponse,
          context: this.transportContext,
        }),
    })
  }

  async streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    const payload = await this.buildWrappedPayload(model, request, options)
    const fetchRequest: GeminiFetchRequest = {
      url: `${CODE_ASSIST_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`,
      headers: payload.headers,
      body: payload.body,
    }

    return runWithRequestTransportForStream({
      mode: this.requestTransportMode,
      memoryKey: this.requestTransportMemoryKey,
      signal: options?.signal,
      createBrowserStream: (signal) =>
        geminiStreamViaFetch({
          fetchImpl: this.browserFetch,
          request: fetchRequest,
          model: request.model,
          signal,
          parse: GeminiProvider.parseStreamingResponseChunk,
          context: this.transportContext,
        }),
      createObsidianStream: (signal) =>
        geminiStreamViaBufferedFetch({
          fetchImpl: this.obsidianFetch,
          request: fetchRequest,
          model: request.model,
          signal,
          parse: GeminiProvider.parseStreamingResponseChunk,
          context: this.transportContext,
        }),
      createNodeStream: (signal) =>
        geminiStreamViaFetch({
          fetchImpl: this.nodeFetch,
          request: fetchRequest,
          model: request.model,
          signal,
          parse: GeminiProvider.parseStreamingResponseChunk,
          context: this.transportContext,
        }),
    })
  }

  private async buildWrappedPayload(
    model: ChatModel,
    request: LLMRequestNonStreaming | LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<{
    headers: Headers
    body: string
  }> {
    const service = getGeminiOAuthService(this.provider.id)
    if (!service) {
      throw new LLMProviderNotConfiguredException(
        'Gemini OAuth service is not initialized.',
      )
    }

    const credential = await service.getUsableCredential()
    if (!credential) {
      throw new LLMProviderNotConfiguredException(
        'Gemini OAuth is not logged in. Please connect your account in settings.',
      )
    }

    const configuredProjectId =
      typeof this.provider.additionalSettings?.projectId === 'string'
        ? this.provider.additionalSettings.projectId
        : undefined
    const contextualCredential = await service.ensureProjectContext(
      credential,
      configuredProjectId,
      request.model,
    )
    const projectId =
      contextualCredential.managedProjectId ?? contextualCredential.projectId
    if (!projectId) {
      throw new LLMProviderNotConfiguredException(
        'Gemini OAuth could not resolve a Google Cloud project for this account.',
      )
    }

    const systemMessages = request.messages.filter(
      (message) => message.role === 'system',
    )
    const systemInstruction =
      systemMessages.length > 0
        ? systemMessages.map((message) => message.content).join('\n')
        : undefined

    const config: Record<string, unknown> = {
      ...(request.max_tokens ? { maxOutputTokens: request.max_tokens } : {}),
      ...(typeof request.temperature === 'number'
        ? { temperature: request.temperature }
        : {}),
    }
    const level = resolveRequestReasoningLevel(model, request.reasoningLevel)
    if (level !== undefined) {
      const isGemini3 = /gemini-3/i.test(request.model)
      if (level === 'auto') {
        // omit
      } else if (level === 'off') {
        if (isGemini3) {
          config.thinkingConfig = {
            thinkingLevel: 'minimal',
            includeThoughts: false,
          }
        } else {
          config.thinkingConfig = {
            thinkingBudget: 0,
            includeThoughts: false,
          }
        }
      } else if (isGemini3) {
        config.thinkingConfig = {
          thinkingLevel: level === 'extra-high' ? 'high' : level,
          includeThoughts: true,
        }
      } else {
        config.thinkingConfig = {
          thinkingBudget: REASONING_META[level].budget,
          includeThoughts: true,
        }
      }
    }

    const prepared = GeminiProvider.prepareTools(request, model, options)
    const requestPayloadBase = {
      contents: GeminiProvider.buildRequestContents(request.messages),
      ...(Object.keys(config).length > 0 ? { generationConfig: config } : {}),
      ...(prepared ? { tools: prepared.tools } : {}),
      ...(prepared?.toolConfig ? { toolConfig: prepared.toolConfig } : {}),
      ...(systemInstruction
        ? {
            systemInstruction: {
              role: 'user',
              parts: [{ text: systemInstruction }],
            },
          }
        : {}),
    }
    const requestPayload = this.applyCustomModelParameters(
      model,
      requestPayloadBase as Record<string, unknown>,
    )

    const body = JSON.stringify({
      project: projectId,
      model: request.model,
      user_prompt_id: crypto.randomUUID(),
      request: requestPayload,
    })

    const headers = new Headers({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${contextualCredential.accessToken}`,
      'User-Agent': `GeminiCLI/0.1.21/${request.model} (obsidian-yolo)`,
      'x-activity-request-id': crypto.randomUUID(),
      ...(toProviderHeadersRecord(this.provider.customHeaders) ?? {}),
    })

    return { headers, body }
  }
}
