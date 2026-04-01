import OpenAI from 'openai'

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
import { createObsidianFetch } from '../../utils/llm/obsidian-fetch'
import { resolveProviderBaseUrl } from '../../utils/llm/provider-base-url'
import { toProviderHeadersRecord } from '../../utils/llm/provider-headers'
import { detectReasoningTypeFromModelId } from '../../utils/model-id-utils'

import { BaseLLMProvider } from './base'
import { extractEmbeddingVector } from './embedding-utils'
import { OpenAIMessageAdapter } from './openaiMessageAdapter'
import {
  AutoPromotedTransportMode,
  createRequestTransportMemoryKey,
  resolveRequestTransportMode,
  runWithRequestTransport,
  runWithRequestTransportForStream,
} from './requestTransport'
import { ModelRequestPolicy, resolveSdkMaxRetries } from './requestPolicy'
import { createDesktopNodeFetch } from './sdkFetch'

export class OpenRouterProvider extends BaseLLMProvider<LLMProvider> {
  private adapter: OpenAIMessageAdapter
  private browserClient: OpenAI
  private obsidianClient: OpenAI
  private nodeClient: OpenAI
  private requestTransportMode: RequestTransportMode
  private requestTransportMemoryKey: string
  private onAutoPromoteTransportMode?: (mode: AutoPromotedTransportMode) => void

  private promoteTransportMode = (mode: AutoPromotedTransportMode) => {
    if (this.requestTransportMode === mode) {
      return
    }

    this.provider.additionalSettings = {
      ...(this.provider.additionalSettings ?? {}),
      requestTransportMode: mode,
    }
    this.requestTransportMode = mode
    this.onAutoPromoteTransportMode?.(mode)
  }

  constructor(
    provider: LLMProvider,
    options?: {
      onAutoPromoteTransportMode?: (mode: AutoPromotedTransportMode) => void
      requestPolicy?: ModelRequestPolicy
    },
  ) {
    super(provider)
    this.adapter = new OpenAIMessageAdapter()
    this.onAutoPromoteTransportMode = options?.onAutoPromoteTransportMode
    const defaultHeaders = toProviderHeadersRecord(provider.customHeaders)
    this.requestTransportMemoryKey = createRequestTransportMemoryKey({
      providerType: provider.presetType,
      providerId: provider.id,
      baseUrl: provider.baseUrl,
    })
    this.requestTransportMode = resolveRequestTransportMode({
      additionalSettings: provider.additionalSettings,
      hasCustomBaseUrl: !!provider.baseUrl,
      memoryKey: this.requestTransportMemoryKey,
    })
    const clientOptions = {
      apiKey: provider.apiKey ?? '',
      baseURL: resolveProviderBaseUrl(provider),
      dangerouslyAllowBrowser: true,
      defaultHeaders,
      maxRetries: resolveSdkMaxRetries({
        requestPolicy: options?.requestPolicy,
        requestTransportMode: this.requestTransportMode,
      }),
      timeout: options?.requestPolicy?.timeoutMs,
    }
    this.browserClient = new OpenAI(clientOptions)
    this.obsidianClient = new OpenAI({
      ...clientOptions,
      fetch: createObsidianFetch(),
    })
    this.nodeClient = new OpenAI({
      ...clientOptions,
      fetch: createDesktopNodeFetch(),
    })
  }

  async generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    const mergedRequest = this.applyCustomModelParameters(
      model,
      this.applyReasoningConfig(model, request),
    )

    return runWithRequestTransport({
      mode: this.requestTransportMode,
      memoryKey: this.requestTransportMemoryKey,
      onAutoPromoteTransportMode: this.promoteTransportMode,
      runBrowser: () =>
        this.adapter.generateResponse(
          this.browserClient,
          mergedRequest,
          options,
        ),
      runObsidian: () =>
        this.adapter.generateResponse(
          this.obsidianClient,
          mergedRequest,
          options,
        ),
      runNode: () =>
        this.adapter.generateResponse(this.nodeClient, mergedRequest, options),
    })
  }

  async streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    const mergedRequest = this.applyCustomModelParameters(
      model,
      this.applyReasoningConfig(model, request),
    )

    return runWithRequestTransportForStream({
      mode: this.requestTransportMode,
      memoryKey: this.requestTransportMemoryKey,
      onAutoPromoteTransportMode: this.promoteTransportMode,
      signal: options?.signal,
      createBrowserStream: (signal) =>
        this.adapter.streamResponse(this.browserClient, mergedRequest, {
          ...options,
          signal: signal ?? options?.signal,
        }),
      createObsidianStream: (signal) =>
        this.adapter.streamResponse(this.obsidianClient, mergedRequest, {
          ...options,
          signal: signal ?? options?.signal,
        }),
      createNodeStream: (signal) =>
        this.adapter.streamResponse(this.nodeClient, mergedRequest, {
          ...options,
          signal: signal ?? options?.signal,
        }),
    })
  }

  async getEmbedding(model: string, text: string): Promise<number[]> {
    try {
      const embedding = await runWithRequestTransport({
        mode: this.requestTransportMode,
        memoryKey: this.requestTransportMemoryKey,
        onAutoPromoteTransportMode: this.promoteTransportMode,
        runBrowser: () =>
          this.browserClient.embeddings.create({
            model: model,
            input: text,
          }),
        runObsidian: () =>
          this.obsidianClient.embeddings.create({
            model: model,
            input: text,
          }),
        runNode: () =>
          this.nodeClient.embeddings.create({
            model: model,
            input: text,
          }),
      })
      return extractEmbeddingVector(embedding)
    } catch (error) {
      throw new Error(
        `Failed to get embedding from OpenRouter: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
    }
  }

  private applyReasoningConfig<
    RequestType extends LLMRequestNonStreaming | LLMRequestStreaming,
  >(model: ChatModel, request: RequestType): RequestType {
    const formattedRequest = { ...request } as RequestType &
      Record<string, unknown>

    const resolveReasoningType = () => {
      if (model.reasoningType && model.reasoningType !== 'none') {
        return model.reasoningType
      }
      const detected = detectReasoningTypeFromModelId(model.model)
      return detected === 'none' ? null : detected
    }

    const reasoningType = resolveReasoningType()
    const thinkingModel = model as ChatModel & {
      thinking?: {
        enabled?: boolean
        thinking_budget?: number
        budget_tokens?: number
      }
    }
    const reasoningModel = model as ChatModel & {
      reasoning?: { enabled?: boolean; reasoning_effort?: string }
    }

    const budget =
      thinkingModel.thinking?.thinking_budget ??
      thinkingModel.thinking?.budget_tokens

    if (reasoningType === 'openai' && reasoningModel.reasoning) {
      if (reasoningModel.reasoning.enabled === false) {
        formattedRequest.reasoning = { effort: 'none', exclude: true }
      } else {
        const effort = reasoningModel.reasoning.reasoning_effort as
          | 'low'
          | 'medium'
          | 'high'
          | undefined
        if (effort) {
          formattedRequest.reasoning = { effort }
        } else if (reasoningModel.reasoning.enabled) {
          formattedRequest.reasoning = { enabled: true }
        }
      }
    }

    if (reasoningType !== 'openai' && thinkingModel.thinking) {
      if (thinkingModel.thinking.enabled === false) {
        formattedRequest.reasoning = { max_tokens: 0, exclude: true }
      } else if (budget === -1) {
        formattedRequest.reasoning = { enabled: true }
      } else if (typeof budget === 'number') {
        if (budget <= 0) {
          formattedRequest.reasoning = { max_tokens: 0, exclude: true }
        } else {
          formattedRequest.reasoning = { max_tokens: budget }
        }
      }
    }

    if (!reasoningType && reasoningModel.reasoning) {
      if (reasoningModel.reasoning.enabled === false) {
        formattedRequest.reasoning = { effort: 'none', exclude: true }
      } else if (reasoningModel.reasoning.reasoning_effort) {
        formattedRequest.reasoning = {
          effort: reasoningModel.reasoning.reasoning_effort,
        }
      }
    }

    return formattedRequest as RequestType
  }
}
