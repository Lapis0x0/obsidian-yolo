import OpenAI from 'openai'

import { ChatModel } from '../../types/chat-model.types'
import {
  LLMOptions,
  LLMRequestNonStreaming,
  LLMRequestStreaming,
  RequestTool,
} from '../../types/llm/request'
import {
  LLMResponseNonStreaming,
  LLMResponseStreaming,
} from '../../types/llm/response'
import { LLMProvider, RequestTransportMode } from '../../types/provider.types'
import { resolveRequestReasoningLevel } from '../../types/reasoning'
import { getBuiltinProviderTools } from '../../utils/llm/model-tools'
import { resolveProviderBaseUrl } from '../../utils/llm/provider-base-url'
import { toProviderHeadersRecord } from '../../utils/llm/provider-headers'
import { formatMessages } from '../../utils/llm/request'

import { BaseLLMProvider } from './base'
import { resolveAdapterForBaseUrl } from './baseUrlDetection'
import { extractEmbeddingVector } from './embedding-utils'
import { LLMBaseUrlNotSetException } from './exception'
import { NoStainlessOpenAI } from './NoStainlessOpenAI'
import { applyOpenAICompatibleCapabilities } from './openaiCompatibleCapabilities'
import { OpenAIMessageAdapter } from './openaiMessageAdapter'
import { ModelRequestPolicy, resolveSdkMaxRetries } from './requestPolicy'
import {
  AutoPromotedTransportMode,
  createRequestTransportMemoryKey,
  resolveRequestTransportMode,
  runWithRequestTransport,
  runWithRequestTransportForStream,
} from './requestTransport'
import { createTransportClients } from './transportClients'

type GeminiThinkingConfig = {
  thinking_budget: number
  include_thoughts: boolean
}

type OpenAICompatibleExtras = {
  thinking_config?: GeminiThinkingConfig
  thinkingConfig?: {
    thinkingBudget: number
    includeThoughts: boolean
  }
  reasoning?: Record<string, unknown>
  extra_body?: Record<string, unknown>
  plugins?: Record<string, unknown>[]
}

const GOOGLE_SEARCH_FUNCTION_TOOL: RequestTool = {
  type: 'function',
  function: {
    name: 'googleSearch',
    description: 'Search the web using Google Search',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
      },
    },
  },
}

const URL_CONTEXT_FUNCTION_TOOL: RequestTool = {
  type: 'function',
  function: {
    name: 'urlContext',
    description: 'Get context from a URL',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to get context from',
        },
      },
    },
  },
}

const hasFunctionToolNamed = (
  tools: RequestTool[] | undefined,
  name: string,
): boolean =>
  Array.isArray(tools) &&
  tools.some((t) => t.type === 'function' && t.function?.name === name)

type OpenAICompatibleRequest = LLMRequestNonStreaming &
  Record<string, unknown> &
  OpenAICompatibleExtras
type OpenAICompatibleStreamingRequest = LLMRequestStreaming &
  Record<string, unknown> &
  OpenAICompatibleExtras

export class OpenAICompatibleProvider extends BaseLLMProvider<LLMProvider> {
  private adapter: OpenAIMessageAdapter
  private browserClient: OpenAI
  private obsidianClient: OpenAI
  private nodeClient: OpenAI
  private resolvedBaseUrl?: string
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
      adapter?: OpenAIMessageAdapter
      onAutoPromoteTransportMode?: (mode: AutoPromotedTransportMode) => void
      requestPolicy?: ModelRequestPolicy
    },
  ) {
    super(provider)
    this.onAutoPromoteTransportMode = options?.onAutoPromoteTransportMode
    this.resolvedBaseUrl = resolveProviderBaseUrl(provider)
    this.adapter =
      options?.adapter ?? resolveAdapterForBaseUrl(this.resolvedBaseUrl)
    const defaultHeaders = toProviderHeadersRecord(provider.customHeaders)
    this.requestTransportMemoryKey = createRequestTransportMemoryKey({
      providerType: provider.presetType,
      providerId: provider.id,
      baseUrl: this.resolvedBaseUrl,
    })
    this.requestTransportMode = resolveRequestTransportMode({
      additionalSettings: provider.additionalSettings,
      hasCustomBaseUrl: !!provider.baseUrl,
      memoryKey: this.requestTransportMemoryKey,
    })
    const ClientCtor = provider.additionalSettings?.noStainless
      ? NoStainlessOpenAI
      : OpenAI
    // Prefer standard OpenAI SDK; allow opting into NoStainless to bypass headers/validation when needed
    const clientOptions = {
      apiKey: provider.apiKey ?? '',
      baseURL: this.resolvedBaseUrl ?? '',
      dangerouslyAllowBrowser: true,
      maxRetries: resolveSdkMaxRetries({
        requestPolicy: options?.requestPolicy,
        requestTransportMode: this.requestTransportMode,
      }),
      timeout: options?.requestPolicy?.timeoutMs,
      defaultHeaders,
    }
    const clients = createTransportClients(
      (transportFetch) =>
        new ClientCtor({
          ...clientOptions,
          fetch: transportFetch,
        }),
    )
    this.browserClient = clients.browserClient
    this.obsidianClient = clients.obsidianClient
    this.nodeClient = clients.nodeClient
  }

  async generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    if (!this.resolvedBaseUrl) {
      throw new LLMBaseUrlNotSetException(
        `Provider ${this.provider.id} base URL is missing. Please set it in settings menu.`,
      )
    }

    let formattedRequest: OpenAICompatibleRequest = {
      ...request,
      messages: formatMessages(request.messages),
    }

    this.applyConversationGeminiTools(formattedRequest, model, options)
    this.applyBuiltinProviderTools(formattedRequest, model)

    applyOpenAICompatibleCapabilities({
      request: formattedRequest,
      reasoningType: model.reasoningType,
      reasoningLevel: resolveRequestReasoningLevel(
        model,
        request.reasoningLevel,
      ),
      baseUrl: this.resolvedBaseUrl,
    })

    formattedRequest = this.applyCustomModelParameters(model, formattedRequest)
    return runWithRequestTransport({
      mode: this.requestTransportMode,
      memoryKey: this.requestTransportMemoryKey,
      onAutoPromoteTransportMode: this.promoteTransportMode,
      runBrowser: () =>
        this.adapter.generateResponse(
          this.browserClient,
          formattedRequest,
          options,
        ),
      runObsidian: () =>
        this.adapter.generateResponse(
          this.obsidianClient,
          formattedRequest,
          options,
        ),
      runNode: () =>
        this.adapter.generateResponse(
          this.nodeClient,
          formattedRequest,
          options,
        ),
    })
  }

  async streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    if (!this.resolvedBaseUrl) {
      throw new LLMBaseUrlNotSetException(
        `Provider ${this.provider.id} base URL is missing. Please set it in settings menu.`,
      )
    }

    let formattedRequest: OpenAICompatibleStreamingRequest = {
      ...request,
      messages: formatMessages(request.messages),
    }

    this.applyConversationGeminiTools(formattedRequest, model, options)
    this.applyBuiltinProviderTools(formattedRequest, model)

    applyOpenAICompatibleCapabilities({
      request: formattedRequest,
      reasoningType: model.reasoningType,
      reasoningLevel: resolveRequestReasoningLevel(
        model,
        request.reasoningLevel,
      ),
      baseUrl: this.resolvedBaseUrl,
    })

    formattedRequest = this.applyCustomModelParameters(model, formattedRequest)
    return runWithRequestTransportForStream({
      mode: this.requestTransportMode,
      memoryKey: this.requestTransportMemoryKey,
      onAutoPromoteTransportMode: this.promoteTransportMode,
      signal: options?.signal,
      createBrowserStream: (signal) =>
        this.adapter.streamResponse(this.browserClient, formattedRequest, {
          ...options,
          signal: signal ?? options?.signal,
        }),
      createObsidianStream: (signal) =>
        this.adapter.streamResponse(this.obsidianClient, formattedRequest, {
          ...options,
          signal: signal ?? options?.signal,
        }),
      createNodeStream: (signal) =>
        this.adapter.streamResponse(this.nodeClient, formattedRequest, {
          ...options,
          signal: signal ?? options?.signal,
        }),
    })
  }

  async getEmbedding(
    model: string,
    text: string,
    options?: { dimensions?: number },
  ): Promise<number[]> {
    const dimensionsParam = options?.dimensions
      ? { dimensions: options.dimensions }
      : {}
    const embedding = await runWithRequestTransport({
      mode: this.requestTransportMode,
      memoryKey: this.requestTransportMemoryKey,
      onAutoPromoteTransportMode: this.promoteTransportMode,
      runBrowser: () =>
        this.browserClient.embeddings.create({
          model: model,
          input: text,
          encoding_format: 'float',
          ...dimensionsParam,
        }),
      runObsidian: () =>
        this.obsidianClient.embeddings.create({
          model: model,
          input: text,
          encoding_format: 'float',
          ...dimensionsParam,
        }),
      runNode: () =>
        this.nodeClient.embeddings.create({
          model: model,
          input: text,
          encoding_format: 'float',
          ...dimensionsParam,
        }),
    })
    return extractEmbeddingVector(embedding)
  }

  /**
   * Conversation-level Gemini tool overrides (`options.geminiTools` set by the
   * chat input bar). Only triggers when the model is configured for the
   * Gemini built-in tool family. Synthesizes `googleSearch` / `urlContext`
   * function tools that Vertex-style OpenAI-compatible gateways understand.
   */
  private applyConversationGeminiTools(
    formattedRequest:
      | OpenAICompatibleRequest
      | OpenAICompatibleStreamingRequest,
    model: ChatModel,
    options: LLMOptions | undefined,
  ) {
    const geminiToolsSettings = options?.geminiTools
    if (model.builtinToolProvider !== 'gemini' || !geminiToolsSettings) {
      return
    }
    const openaiTools: RequestTool[] = []
    if (
      geminiToolsSettings.useWebSearch &&
      !hasFunctionToolNamed(formattedRequest.tools, 'googleSearch')
    ) {
      openaiTools.push(GOOGLE_SEARCH_FUNCTION_TOOL)
    }
    if (
      geminiToolsSettings.useUrlContext &&
      !hasFunctionToolNamed(formattedRequest.tools, 'urlContext')
    ) {
      openaiTools.push(URL_CONTEXT_FUNCTION_TOOL)
    }
    if (openaiTools.length > 0) {
      formattedRequest.tools = [
        ...(formattedRequest.tools ?? []),
        ...openaiTools,
      ]
    }
  }

  /**
   * Model-level built-in provider tools. Dispatched per family — each provider
   * uses a different request slot:
   *
   * - `web_search` → `extra_body.tools=[{type:'web_search'}]` (OpenAI Chat
   *   Completions hosted web search, forwarded by Azure / DeepSeek-style
   *   gateways that opt-in).
   * - `openrouter:web_search` → `plugins=[{id:'web', engine?, max_results?}]`
   *   per https://openrouter.ai/docs/guides/features/plugins/web-search.
   *   Only emitted when the gateway base URL targets openrouter.ai — other
   *   openai-compatible gateways would reject the unknown field.
   * - `grok:live_search` → `extra_body.search_parameters={mode:'auto', return_citations:true}`
   *   per xAI's Live Search extension on chat completions. Only emitted when
   *   the gateway base URL targets api.x.ai.
   * - `gemini:web_search` → synthetic `googleSearch` function tool, matching
   *   the conversation-override path so Vertex-style gateways see a single,
   *   recognizable shape. Skipped if already present (dedup with conversation
   *   overrides).
   *
   * Cross-family mismatches silently no-op rather than rewriting the user's
   * intent — see `model-tools.ts` for the rationale.
   */
  private applyBuiltinProviderTools(
    formattedRequest:
      | OpenAICompatibleRequest
      | OpenAICompatibleStreamingRequest,
    model: ChatModel,
  ) {
    const tools = getBuiltinProviderTools(model)
    if (tools.length === 0) return
    const baseUrlLower = this.resolvedBaseUrl?.toLowerCase() ?? ''
    // Host-anchored matchers — a bare `substring.includes` would also match
    // e.g. `evilopenrouter.ai`, which we don't want to silently forward to.
    const isOpenRouterGateway = /(^|\/\/)([^/]*\.)?openrouter\.ai(\/|$|:)/.test(
      baseUrlLower,
    )
    const isXaiGateway = /(^|\/\/)([^/]*\.)?x\.ai(\/|$|:)/.test(baseUrlLower)

    for (const tool of tools) {
      if (tool.type === 'web_search') {
        const existing = Array.isArray(formattedRequest.extra_body?.tools)
          ? (formattedRequest.extra_body?.tools as unknown[])
          : []
        formattedRequest.extra_body = {
          ...(formattedRequest.extra_body ?? {}),
          tools: [...existing, { type: 'web_search' }],
        }
      } else if (tool.type === 'openrouter:web_search' && isOpenRouterGateway) {
        // Use OpenRouter's `plugins` path rather than the newer server-tools
        // path: only GPT-5 reliably recognizes a non-`function`-typed tool
        // entry, so the plugin path is the one that works uniformly across
        // Claude / MiniMax / Gemini / etc. See openRouterProvider.ts for the
        // longer rationale.
        const plugin: Record<string, unknown> = { id: 'web' }
        if (tool.engine) plugin.engine = tool.engine
        if (typeof tool.maxResults === 'number')
          plugin.max_results = tool.maxResults
        formattedRequest.plugins = [...(formattedRequest.plugins ?? []), plugin]
      } else if (tool.type === 'grok:live_search' && isXaiGateway) {
        formattedRequest.extra_body = {
          ...(formattedRequest.extra_body ?? {}),
          search_parameters: { mode: 'auto', return_citations: true },
        }
      }
      // else: cross-family mismatch — drop silently.
      //
      // In particular, `gemini:web_search` / `gemini:url_context` are NOT
      // dispatched here even when they appear: Gemini's hosted tool family
      // only lands when the request hits a native Gemini transport
      // (`gemini.ts` / `geminiOAuthProvider.ts`). Synthesizing them as
      // OpenAI-style `function` tools on an openai-compatible gateway would
      // look reasonable but would NOT actually run web search — the gateway
      // has no way to execute the synthetic `googleSearch` call. The
      // pre-existing conversation-level synthesis is preserved as-is for
      // backwards compatibility but is intentionally not extended.
    }
  }
}
