import type {
  Content as GeminiContent,
  FunctionCall as GeminiFunctionCall,
  FunctionDeclaration as GeminiFunctionDeclaration,
  GenerateContentResponse as GeminiGenerateContentResponse,
  Part as GeminiPart,
  Tool as GeminiTool,
  ToolConfig as GeminiToolConfig,
} from '@google/genai'
import { Platform } from 'obsidian'
import { v4 as uuidv4 } from 'uuid'

import { ChatModel } from '../../types/chat-model.types'
import {
  LLMOptions,
  LLMRequestNonStreaming,
  LLMRequestStreaming,
  RequestMessage,
  RequestTool,
} from '../../types/llm/request'
import {
  GeminiAssistantPart,
  LLMResponseNonStreaming,
  LLMResponseStreaming,
  ProviderMetadata,
  ResponseUsage,
  ToolCall,
  ToolCallDelta,
} from '../../types/llm/response'
import { LLMProvider, RequestTransportMode } from '../../types/provider.types'
import {
  REASONING_META,
  resolveRequestReasoningLevel,
} from '../../types/reasoning'
import {
  type ToolCallArguments,
  getToolCallArgumentsObject,
} from '../../types/tool-call.types'
import { parseImageDataUrl } from '../../utils/llm/image'
import { createObsidianFetch } from '../../utils/llm/obsidian-fetch'
import { toProviderHeadersRecord } from '../../utils/llm/provider-headers'

import { BaseLLMProvider } from './base'
import {
  LLMAPIKeyInvalidException,
  LLMAPIKeyNotSetException,
} from './exception'
import {
  type GeminiFetchRequest,
  type GeminiTransportContext,
  geminiGenerateViaFetch,
  geminiJsonFetch,
  geminiStreamViaBufferedFetch,
  geminiStreamViaFetch,
} from './geminiFetchTransport'
import { ModelRequestPolicy } from './requestPolicy'
import {
  type AutoPromotedTransportMode,
  createRequestTransportMemoryKey,
  resolveRequestTransportMode,
  runWithRequestTransport,
  runWithRequestTransportForStream,
} from './requestTransport'
import { createBrowserFetch, createDesktopNodeFetch } from './sdkFetch'

type GeminiStreamChunk = GeminiGenerateContentResponse
type GeminiEmbedResponse = {
  embedding?: { values?: number[] }
}
type GeminiFunctionCallWithMetadata = GeminiFunctionCall & {
  thoughtSignature?: string
}
type GeminiReplayPart = GeminiPart & {
  thoughtSignature?: string
}

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com'
const GEMINI_API_VERSION = 'v1beta'
const PROVIDER_LABEL = 'Gemini'

/**
 * TODO: Consider future migration from '@google/generative-ai' to '@google/genai' (https://github.com/googleapis/js-genai)
 * - Current '@google/generative-ai' library will not support newest models and features
 * - Not migrating yet as '@google/genai' is still in preview status
 */

/**
 * Note on OpenAI Compatibility API:
 * Gemini provides an OpenAI-compatible endpoint (https://ai.google.dev/gemini-api/docs/openai)
 * which allows using the OpenAI SDK with Gemini models. However, there are currently CORS issues
 * preventing its use in Obsidian. Consider switching to this endpoint in the future once these
 * issues are resolved.
 */
/**
 * Build our generic ResponseUsage from a Gemini `usageMetadata` object,
 * lifting Gemini's context-cache hit count (`cachedContentTokenCount`) to the
 * shared `cache_read_input_tokens` slot the UI reads.
 */
function buildGeminiUsage(metadata: {
  promptTokenCount?: number | null
  candidatesTokenCount?: number | null
  totalTokenCount?: number | null
  cachedContentTokenCount?: number | null
}): ResponseUsage {
  const result: ResponseUsage = {
    prompt_tokens: metadata.promptTokenCount ?? 0,
    completion_tokens: metadata.candidatesTokenCount ?? 0,
    total_tokens: metadata.totalTokenCount ?? 0,
  }
  const cached = metadata.cachedContentTokenCount
  if (cached !== undefined && cached !== null && cached > 0) {
    result.cache_read_input_tokens = cached
  }
  return result
}

export class GeminiProvider extends BaseLLMProvider<LLMProvider> {
  private static readonly SUPPORTED_IMAGE_TYPES = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/heic',
    'image/heif',
  ] as const

  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly customHeaders: Record<string, string> | undefined
  private readonly requestPolicy?: ModelRequestPolicy
  private readonly browserFetch = createBrowserFetch()
  private readonly obsidianFetch = createObsidianFetch()
  private readonly nodeFetch = createDesktopNodeFetch()
  private requestTransportMode: RequestTransportMode
  private readonly requestTransportMemoryKey: string
  private readonly transportContext: GeminiTransportContext
  private readonly onAutoPromoteTransportMode?: (
    mode: AutoPromotedTransportMode,
  ) => void

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
    this.requestPolicy = options?.requestPolicy
    this.onAutoPromoteTransportMode = options?.onAutoPromoteTransportMode
    this.apiKey = provider.apiKey ?? ''
    this.baseUrl = provider.baseUrl
      ? GeminiProvider.normalizeBaseUrl(provider.baseUrl)
      : DEFAULT_GEMINI_BASE_URL
    this.customHeaders = toProviderHeadersRecord(provider.customHeaders)
    this.requestTransportMemoryKey = createRequestTransportMemoryKey({
      providerType: provider.presetType,
      providerId: provider.id,
      baseUrl: this.baseUrl,
    })
    this.requestTransportMode = resolveRequestTransportMode({
      additionalSettings: provider.additionalSettings,
      hasCustomBaseUrl: Boolean(provider.baseUrl),
      memoryKey: this.requestTransportMemoryKey,
    })
    this.transportContext = {
      providerLabel: PROVIDER_LABEL,
      requestPolicy: this.requestPolicy,
    }
    if (!Platform.isDesktop && this.requestTransportMode === 'node') {
      // Node transport requires Electron's main process; gracefully degrade.
      this.requestTransportMode = 'obsidian'
    }
  }

  private buildHeaders(): Headers {
    return new Headers({
      'Content-Type': 'application/json',
      'x-goog-api-key': this.apiKey,
      ...(this.customHeaders ?? {}),
    })
  }

  private buildUrl(model: string, action: string, query?: string): string {
    const modelPath = GeminiProvider.normalizeModelPath(model)
    const query_ = query ? `?${query}` : ''
    return `${this.baseUrl}/${GEMINI_API_VERSION}/${modelPath}:${action}${query_}`
  }

  private buildRestBody(
    request: LLMRequestNonStreaming | LLMRequestStreaming,
    model: ChatModel,
    options?: LLMOptions,
  ): string {
    const systemMessages = request.messages.filter((m) => m.role === 'system')
    const systemInstructionText =
      systemMessages.length > 0
        ? systemMessages.map((m) => m.content).join('\n')
        : undefined

    const generationConfig: Record<string, unknown> = {
      ...(request.max_tokens !== undefined && request.max_tokens !== null
        ? { maxOutputTokens: request.max_tokens }
        : {}),
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
        generationConfig.thinkingConfig = isGemini3
          ? { thinkingLevel: 'minimal', includeThoughts: false }
          : { thinkingBudget: 0, includeThoughts: false }
      } else if (isGemini3) {
        generationConfig.thinkingConfig = {
          thinkingLevel: level === 'extra-high' ? 'high' : level,
          includeThoughts: true,
        }
      } else {
        generationConfig.thinkingConfig = {
          thinkingBudget: REASONING_META[level].budget,
          includeThoughts: true,
        }
      }
    }

    const prepared = GeminiProvider.prepareTools(request, model, options)

    const restBody: Record<string, unknown> = {
      contents: GeminiProvider.buildRequestContents(request.messages),
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
      ...(prepared ? { tools: prepared.tools } : {}),
      ...(prepared?.toolConfig ? { toolConfig: prepared.toolConfig } : {}),
      ...(systemInstructionText
        ? {
            systemInstruction: {
              role: 'user',
              parts: [{ text: systemInstructionText }],
            },
          }
        : {}),
    }

    return JSON.stringify(this.applyCustomModelParameters(model, restBody))
  }

  async generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    if (!this.apiKey) {
      throw new LLMAPIKeyNotSetException(
        `Provider ${this.provider.id} API key is missing. Please set it in settings menu.`,
      )
    }

    try {
      const fetchRequest: GeminiFetchRequest = {
        url: this.buildUrl(request.model, 'generateContent'),
        headers: this.buildHeaders(),
        body: this.buildRestBody(request, model, options),
      }

      return await runWithRequestTransport({
        mode: this.requestTransportMode,
        memoryKey: this.requestTransportMemoryKey,
        onAutoPromoteTransportMode: this.promoteTransportMode,
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
    } catch (error) {
      const message = GeminiProvider.getErrorMessage(error)
      const isInvalidApiKey =
        message?.includes('API_KEY_INVALID') ||
        message?.includes('API key not valid')

      if (isInvalidApiKey) {
        throw new LLMAPIKeyInvalidException(
          `Provider ${this.provider.id} API key is invalid. Please update it in settings menu.`,
          GeminiProvider.toError(error),
        )
      }

      throw GeminiProvider.toError(error)
    }
  }

  async streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    if (!this.apiKey) {
      throw new LLMAPIKeyNotSetException(
        `Provider ${this.provider.id} API key is missing. Please set it in settings menu.`,
      )
    }

    if (options?.signal?.aborted) {
      throw GeminiProvider.createAbortError()
    }

    try {
      const fetchRequest: GeminiFetchRequest = {
        url: this.buildUrl(request.model, 'streamGenerateContent', 'alt=sse'),
        headers: this.buildHeaders(),
        body: this.buildRestBody(request, model, options),
      }

      return await runWithRequestTransportForStream({
        mode: this.requestTransportMode,
        memoryKey: this.requestTransportMemoryKey,
        onAutoPromoteTransportMode: this.promoteTransportMode,
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
    } catch (error) {
      const message = GeminiProvider.getErrorMessage(error)
      const isInvalidApiKey =
        message?.includes('API_KEY_INVALID') ||
        message?.includes('API key not valid')

      if (isInvalidApiKey) {
        throw new LLMAPIKeyInvalidException(
          `Gemini API key is invalid. Please update it in settings menu.`,
          GeminiProvider.toError(error),
        )
      }
      // Fallback: some networks/proxies can break streaming ("protocol error: unexpected EOF").
      // Try non-streaming once and adapt it into a single-chunk async iterable.
      const shouldFallback = message
        ? /protocol error|unexpected EOF/i.test(message)
        : false
      if (shouldFallback) {
        const nonStream = await this.generateResponse(
          model,
          GeminiProvider.toNonStreamingRequest(request),
          options,
        )
        const singleChunk = async function* (
          resp: LLMResponseNonStreaming,
        ): AsyncIterable<LLMResponseStreaming> {
          const chunk: LLMResponseStreaming = {
            id: resp.id,
            created: resp.created,
            model: resp.model,
            object: 'chat.completion.chunk',
            choices: [
              {
                finish_reason: resp.choices[0]?.finish_reason ?? null,
                delta: {
                  content: resp.choices[0]?.message?.content ?? '',
                  reasoning: resp.choices[0]?.message?.reasoning ?? undefined,
                  tool_calls: undefined,
                },
              },
            ],
            usage: resp.usage,
          }
          await Promise.resolve() // 保持异步迭代语义，避免同步调用时阻塞
          yield chunk
        }
        return singleChunk(nonStream)
      }
      throw GeminiProvider.toError(error)
    }
  }

  private static createAbortError(): Error {
    const error = new Error('Aborted')
    error.name = 'AbortError'
    return error
  }

  static buildRequestContents(messages: RequestMessage[]): GeminiContent[] {
    const contents: GeminiContent[] = []

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]

      if (message.role === 'system') {
        continue
      }

      if (message.role === 'user') {
        const content = GeminiProvider.parseUserMessage(message)
        if (content) {
          contents.push(content)
        }
        continue
      }

      if (message.role === 'assistant') {
        const assistantContent = GeminiProvider.parseAssistantMessage(message)
        if (assistantContent) {
          contents.push(assistantContent)
        }

        const toolResponses: Extract<RequestMessage, { role: 'tool' }>[] = []
        let lookaheadIndex = index + 1
        while (
          lookaheadIndex < messages.length &&
          messages[lookaheadIndex]?.role === 'tool'
        ) {
          const toolMessage = messages[lookaheadIndex]
          if (toolMessage.role !== 'tool') {
            break
          }
          toolResponses.push(toolMessage)
          lookaheadIndex += 1
        }

        const toolContent = GeminiProvider.parseToolMessages(toolResponses)
        if (toolContent) {
          contents.push(toolContent)
          index = lookaheadIndex - 1
        }
        continue
      }

      const toolContent = GeminiProvider.parseToolMessages([message])
      if (toolContent) {
        contents.push(toolContent)
      }
    }

    return contents
  }

  private static parseUserMessage(
    message: Extract<RequestMessage, { role: 'user' }>,
  ): GeminiContent | null {
    const contentParts: GeminiReplayPart[] = Array.isArray(message.content)
      ? message.content.flatMap((part) => {
          if (part.type === 'text') {
            return [{ text: part.text } as GeminiReplayPart]
          }
          if (part.type === 'image_url') {
            const { mimeType, base64Data } = parseImageDataUrl(
              part.image_url.url,
            )
            GeminiProvider.validateImageType(mimeType)
            return [
              {
                inlineData: {
                  data: base64Data,
                  mimeType,
                },
              } as GeminiReplayPart,
            ]
          }
          if (part.type === 'document') {
            // Gemini accepts native PDF input via inlineData with the
            // application/pdf mimeType (≈258 tokens/page billing).
            return [
              {
                inlineData: {
                  data: part.data,
                  mimeType: part.mediaType,
                },
              } as GeminiReplayPart,
            ]
          }
          return []
        })
      : [{ text: message.content } as GeminiReplayPart]

    return contentParts.length > 0
      ? {
          role: 'user',
          parts: contentParts,
        }
      : null
  }

  private static parseAssistantMessage(
    message: Extract<RequestMessage, { role: 'assistant' }>,
  ): GeminiContent | null {
    const nativeParts = message.providerMetadata?.gemini?.parts
    if (Array.isArray(nativeParts) && nativeParts.length > 0) {
      const replayParts = nativeParts
        .map((part) => GeminiProvider.deserializeAssistantPart(part))
        .filter((part): part is GeminiReplayPart => Boolean(part))

      if (replayParts.length > 0) {
        return {
          role: 'model',
          parts: replayParts,
        }
      }
    }

    const contentParts: GeminiReplayPart[] = []

    if (typeof message.content === 'string' && message.content !== '') {
      contentParts.push({ text: message.content })
    }

    if (Array.isArray(message.tool_calls)) {
      contentParts.push(
        ...message.tool_calls.map((toolCall) =>
          GeminiProvider.mapToolCallRequestToPart(toolCall),
        ),
      )
    }

    if (contentParts.length === 0) {
      return null
    }

    return {
      role: 'model',
      parts: contentParts,
    }
  }

  private static parseToolMessages(
    messages: RequestMessage[],
  ): GeminiContent | null {
    const functionResponses = messages
      .filter(
        (message): message is Extract<RequestMessage, { role: 'tool' }> =>
          message.role === 'tool',
      )
      .map((message) => ({
        functionResponse: {
          id: message.tool_call.id,
          name: message.tool_call.name,
          response: { result: message.content },
        },
      }))

    if (functionResponses.length === 0) {
      return null
    }

    return {
      role: 'user',
      parts: functionResponses,
    }
  }

  private static mapToolCallRequestToPart(toolCall: {
    id: string
    name: string
    arguments?: ToolCallArguments
    metadata?: {
      thoughtSignature?: string
    }
  }): GeminiReplayPart {
    const part: GeminiReplayPart = {
      functionCall: {
        id: toolCall.id,
        name: toolCall.name,
        args: getToolCallArgumentsObject(toolCall.arguments) ?? {},
      },
    }

    if (toolCall.metadata?.thoughtSignature) {
      part.thoughtSignature = toolCall.metadata.thoughtSignature
    }

    return part
  }

  static parseRequestMessage(message: RequestMessage): GeminiContent | null {
    switch (message.role) {
      case 'system':
        // System messages should be extracted and handled separately
        return null
      case 'user':
        return GeminiProvider.parseUserMessage(message)
      case 'assistant':
        return GeminiProvider.parseAssistantMessage(message)
      case 'tool':
        return GeminiProvider.parseToolMessages([message])
    }
  }

  static parseNonStreamingResponse = (
    response: GeminiGenerateContentResponse,
    model: string,
    messageId: string,
  ): LLMResponseNonStreaming => {
    const parts = response.candidates?.[0]?.content?.parts ?? []
    const { contentText, reasoningText } =
      GeminiProvider.extractTextSegments(parts)

    const functionCalls = GeminiProvider.resolveFunctionCallsWithMetadata({
      functionCalls: response.functionCalls,
      parts: response.candidates?.[0]?.content?.parts,
    })

    const toolCallsRaw = functionCalls
      ?.map((call) => GeminiProvider.mapFunctionCall(call))
      .filter((call): call is ToolCall => call !== null)
    const toolCalls =
      toolCallsRaw && toolCallsRaw.length > 0 ? toolCallsRaw : undefined

    if (toolCalls && toolCalls.length > 0) {
      console.debug('[YOLO] Gemini non-stream tool calls detected:', {
        finishReason: response.candidates?.[0]?.finishReason ?? null,
        count: toolCalls.length,
        firstTool: toolCalls[0]?.function.name,
      })
    }

    return {
      id: messageId,
      choices: [
        {
          finish_reason: response.candidates?.[0]?.finishReason ?? null,
          message: {
            content: contentText,
            reasoning: reasoningText ?? null,
            role: 'assistant',
            tool_calls: toolCalls,
            providerMetadata: GeminiProvider.serializeProviderMetadata({
              parts,
              functionCalls,
            }),
          },
        },
      ],
      created: Date.now(),
      model,
      object: 'chat.completion',
      usage: response.usageMetadata
        ? buildGeminiUsage(response.usageMetadata)
        : undefined,
    }
  }

  private static mapFunctionCall(
    call: GeminiFunctionCallWithMetadata | undefined,
  ): ToolCall | null {
    if (!call?.name) {
      return null
    }
    const args = call.args && typeof call.args === 'object' ? call.args : {}

    const thoughtSignature =
      typeof call.thoughtSignature === 'string' &&
      call.thoughtSignature.trim().length > 0
        ? call.thoughtSignature
        : undefined

    return {
      id: call.id ?? uuidv4(),
      type: 'function' as const,
      metadata: thoughtSignature ? { thoughtSignature } : undefined,
      function: {
        name: call.name,
        arguments: JSON.stringify(args),
      },
    }
  }

  private static mapFunctionCallDelta(
    call: GeminiFunctionCallWithMetadata | undefined,
    index: number,
  ): ToolCallDelta | null {
    const base = this.mapFunctionCall(call)
    if (!base) {
      return null
    }
    return {
      index,
      id: base.id,
      type: base.type,
      metadata: base.metadata,
      function: base.function,
    }
  }

  private static getErrorMessage(error: unknown): string | null {
    if (typeof error === 'string') {
      return error
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      typeof (error as { message?: unknown }).message === 'string'
    ) {
      return (error as { message: string }).message
    }
    return null
  }

  private static toError(error: unknown): Error {
    if (error instanceof Error) {
      return error
    }
    const message = GeminiProvider.getErrorMessage(error) ?? 'Unexpected error'
    return new Error(message)
  }

  private static toNonStreamingRequest(
    request: LLMRequestStreaming,
  ): LLMRequestNonStreaming {
    return {
      ...request,
      stream: false,
    }
  }

  static parseStreamingResponseChunk = (
    chunk: GeminiStreamChunk,
    model: string,
    messageId: string,
  ): LLMResponseStreaming => {
    const parts = chunk.candidates?.[0]?.content?.parts ?? []
    const { contentText: contentPiece, reasoningText: reasoningPiece } =
      GeminiProvider.extractTextSegments(parts)
    const functionCalls = GeminiProvider.resolveFunctionCallsWithMetadata({
      functionCalls: chunk.functionCalls,
      parts: chunk.candidates?.[0]?.content?.parts,
    })

    const toolCallDeltaRaw =
      functionCalls
        ?.map((call, index) => GeminiProvider.mapFunctionCallDelta(call, index))
        .filter((call): call is ToolCallDelta => call !== null) ?? []
    const toolCallDeltas =
      toolCallDeltaRaw.length > 0 ? toolCallDeltaRaw : undefined

    if (toolCallDeltas && toolCallDeltas.length > 0) {
      console.debug('[YOLO] Gemini stream tool call deltas:', {
        finishReason: chunk.candidates?.[0]?.finishReason ?? null,
        count: toolCallDeltas.length,
        firstTool: toolCallDeltas[0]?.function?.name,
      })
    }

    return {
      id: messageId,
      choices: [
        {
          finish_reason: chunk.candidates?.[0]?.finishReason ?? null,
          delta: {
            content: contentPiece,
            reasoning: reasoningPiece || undefined,
            tool_calls: toolCallDeltas,
            providerMetadata: GeminiProvider.serializeProviderMetadata({
              parts,
              functionCalls,
            }),
          },
        },
      ],
      created: Date.now(),
      model: model,
      object: 'chat.completion.chunk',
      usage: chunk.usageMetadata
        ? buildGeminiUsage(chunk.usageMetadata)
        : undefined,
    }
  }

  private static extractTextSegments(parts: GeminiPart[] | undefined): {
    contentText: string
    reasoningText?: string
  } {
    let contentText = ''
    let reasoningText = ''

    if (!Array.isArray(parts) || parts.length === 0) {
      return { contentText }
    }

    for (const part of parts) {
      if (typeof part?.text !== 'string') {
        continue
      }
      if (part.thought) {
        reasoningText += part.text
      } else {
        contentText += part.text
      }
    }

    return {
      contentText,
      reasoningText: reasoningText || undefined,
    }
  }

  private static resolveFunctionCallsWithMetadata({
    functionCalls,
    parts,
  }: {
    functionCalls: GeminiFunctionCall[] | undefined
    parts: GeminiPart[] | undefined
  }): GeminiFunctionCallWithMetadata[] | undefined {
    const fromParts = GeminiProvider.extractFunctionCallsFromParts(parts)
    if (!functionCalls || functionCalls.length === 0) {
      return fromParts
    }

    return functionCalls.map((call, index) => {
      const partCall = fromParts?.[index]
      if (!partCall?.thoughtSignature) {
        return call as GeminiFunctionCallWithMetadata
      }
      return {
        ...(call as GeminiFunctionCallWithMetadata),
        thoughtSignature: partCall.thoughtSignature,
      }
    })
  }

  private static extractFunctionCallsFromParts(
    parts: GeminiPart[] | undefined,
  ): GeminiFunctionCallWithMetadata[] | undefined {
    if (!Array.isArray(parts) || parts.length === 0) {
      return undefined
    }

    const extracted: GeminiFunctionCallWithMetadata[] = []

    for (const part of parts) {
      if (!part || typeof part !== 'object') {
        continue
      }
      const record = part as Record<string, unknown>
      const functionCall = record.functionCall
      if (!functionCall || typeof functionCall !== 'object') {
        continue
      }
      const thoughtSignature =
        typeof record.thoughtSignature === 'string'
          ? record.thoughtSignature
          : undefined
      extracted.push({
        ...(functionCall as GeminiFunctionCallWithMetadata),
        thoughtSignature,
      })
    }

    return extracted.length > 0 ? extracted : undefined
  }

  private static serializeProviderMetadata({
    parts,
    functionCalls,
  }: {
    parts: GeminiPart[] | undefined
    functionCalls: GeminiFunctionCallWithMetadata[] | undefined
  }): ProviderMetadata | undefined {
    const serializedParts = GeminiProvider.serializeAssistantParts(
      parts,
      functionCalls,
    )
    if (serializedParts.length === 0) {
      return undefined
    }

    return {
      gemini: {
        parts: serializedParts,
      },
    }
  }

  private static serializeAssistantParts(
    parts: GeminiPart[] | undefined,
    functionCalls?: GeminiFunctionCallWithMetadata[],
  ): GeminiAssistantPart[] {
    const serialized: GeminiAssistantPart[] = []

    if (Array.isArray(parts) && parts.length > 0) {
      for (const part of parts) {
        if (!part || typeof part !== 'object') {
          continue
        }

        const record = part as Record<string, unknown>
        const thoughtSignature =
          typeof record.thoughtSignature === 'string'
            ? record.thoughtSignature
            : undefined

        if (typeof part.text === 'string') {
          serialized.push({
            type: 'text',
            text: part.text,
            ...(part.thought ? { thought: true } : {}),
            ...(thoughtSignature ? { thoughtSignature } : {}),
          })
        }

        const functionCall = record.functionCall
        if (
          functionCall &&
          typeof functionCall === 'object' &&
          typeof (functionCall as { name?: unknown }).name === 'string'
        ) {
          const call = functionCall as GeminiFunctionCall
          if (typeof call.name !== 'string') {
            continue
          }
          serialized.push({
            type: 'functionCall',
            name: call.name,
            ...(typeof call.id === 'string' ? { id: call.id } : {}),
            ...(call.args &&
            typeof call.args === 'object' &&
            !Array.isArray(call.args)
              ? { args: call.args }
              : {}),
            ...(thoughtSignature ? { thoughtSignature } : {}),
          })
        }
      }

      return serialized
    }

    if (Array.isArray(functionCalls)) {
      for (const call of functionCalls) {
        if (!call?.name) {
          continue
        }
        serialized.push({
          type: 'functionCall',
          name: call.name,
          ...(typeof call.id === 'string' ? { id: call.id } : {}),
          ...(call.args &&
          typeof call.args === 'object' &&
          !Array.isArray(call.args)
            ? { args: call.args }
            : {}),
          ...(typeof call.thoughtSignature === 'string'
            ? { thoughtSignature: call.thoughtSignature }
            : {}),
        })
      }
    }

    return serialized
  }

  private static deserializeAssistantPart(
    part: GeminiAssistantPart,
  ): GeminiReplayPart | null {
    if (part.type === 'text') {
      if (part.text.length === 0 && !part.thoughtSignature) {
        return null
      }
      return {
        text: part.text,
        ...(part.thought ? { thought: true } : {}),
        ...(part.thoughtSignature
          ? { thoughtSignature: part.thoughtSignature }
          : {}),
      }
    }

    return {
      functionCall: {
        name: part.name,
        ...(part.id ? { id: part.id } : {}),
        args: part.args ?? {},
      },
      ...(part.thoughtSignature
        ? { thoughtSignature: part.thoughtSignature }
        : {}),
    }
  }

  private static validateImageType(mimeType: string) {
    if (
      !GeminiProvider.SUPPORTED_IMAGE_TYPES.includes(
        mimeType as (typeof GeminiProvider.SUPPORTED_IMAGE_TYPES)[number],
      )
    ) {
      throw new Error(
        `Gemini does not support image type ${mimeType}. Supported types: ${GeminiProvider.SUPPORTED_IMAGE_TYPES.join(
          ', ',
        )}`,
      )
    }
  }

  async getEmbedding(
    model: string,
    text: string,
    _options?: { dimensions?: number },
  ): Promise<number[]> {
    if (!this.apiKey) {
      throw new LLMAPIKeyNotSetException(
        `Provider ${this.provider.id} API key is missing. Please set it in settings menu.`,
      )
    }

    const fetchRequest: GeminiFetchRequest = {
      url: this.buildUrl(model, 'embedContent'),
      headers: this.buildHeaders(),
      body: JSON.stringify({
        content: { parts: [{ text }] },
      }),
    }

    try {
      const result = await runWithRequestTransport({
        mode: this.requestTransportMode,
        memoryKey: this.requestTransportMemoryKey,
        onAutoPromoteTransportMode: this.promoteTransportMode,
        runBrowser: () =>
          geminiJsonFetch<GeminiEmbedResponse>({
            fetchImpl: this.browserFetch,
            request: fetchRequest,
            context: this.transportContext,
          }),
        runObsidian: () =>
          geminiJsonFetch<GeminiEmbedResponse>({
            fetchImpl: this.obsidianFetch,
            request: fetchRequest,
            context: this.transportContext,
          }),
        runNode: () =>
          geminiJsonFetch<GeminiEmbedResponse>({
            fetchImpl: this.nodeFetch,
            request: fetchRequest,
            context: this.transportContext,
          }),
      })
      const values = result.embedding?.values
      if (!values) {
        throw new Error('Gemini embedding response did not include values.')
      }
      return values
    } catch (error) {
      throw GeminiProvider.toError(error)
    }
  }

  static prepareTools(
    request: LLMRequestNonStreaming | LLMRequestStreaming,
    model: ChatModel,
    options?: LLMOptions,
  ): { tools: GeminiTool[]; toolConfig?: GeminiToolConfig } | undefined {
    const tools: GeminiTool[] = []

    // Activation sources (OR-combined, dedup so each tool lands at most once):
    //   1. Conversation override (chat input bar) → `options.geminiTools.*`
    //   2. Model-level toggle (model settings)    → `builtinTools.gemini.*`
    const modelLevelGemini =
      model.builtinToolProvider === 'gemini'
        ? model.builtinTools?.gemini
        : undefined
    const useWebSearch =
      (options?.geminiTools?.useWebSearch ?? false) ||
      modelLevelGemini?.webSearch?.enabled === true
    const useUrlContext =
      (options?.geminiTools?.useUrlContext ?? false) ||
      modelLevelGemini?.urlContext?.enabled === true
    if (useWebSearch) {
      tools.push({ googleSearch: {} })
    }
    if (useUrlContext) {
      tools.push({ urlContext: {} })
    }

    // Merge all function calling tools into a single `functionDeclarations`
    // entry to match Gemini's canonical request format.
    if (request.tools && request.tools.length > 0) {
      tools.push({
        functionDeclarations: request.tools.map((tool) =>
          GeminiProvider.parseRequestFunctionDeclaration(tool),
        ),
      })
    }

    if (tools.length === 0) {
      return undefined
    }

    const hasBuiltinTool = useWebSearch || useUrlContext
    return {
      tools,
      ...(hasBuiltinTool
        ? { toolConfig: { includeServerSideToolInvocations: true } }
        : {}),
    }
  }

  // Normalize arbitrary JSON Schema (mostly from third-party MCP tools) into
  // the subset Gemini actually accepts. Currently:
  //   - drop `additionalProperties` (Gemini rejects it)
  //   - for `type: 'array'` without `items`, inject a fallback `items` so the
  //     request passes Gemini's strict validation. `string` is the safest
  //     placeholder — it's a degraded representation, not the original schema.
  // Extend with new branches only when Gemini reports a concrete failure.
  static sanitizeSchemaForGemini(schema: unknown): unknown {
    if (typeof schema !== 'object' || schema === null) {
      return schema
    }

    if (Array.isArray(schema)) {
      return schema.map((item) => this.sanitizeSchemaForGemini(item))
    }

    const rest = { ...(schema as Record<string, unknown>) }
    delete rest.additionalProperties

    if (rest.type === 'array' && !('items' in rest)) {
      rest.items = { type: 'string' }
    }

    return Object.fromEntries(
      Object.entries(rest).map(([key, value]) => [
        key,
        this.sanitizeSchemaForGemini(value),
      ]),
    )
  }

  private static parseRequestFunctionDeclaration(
    tool: RequestTool,
  ): GeminiFunctionDeclaration {
    const cleanedSchema = this.sanitizeSchemaForGemini(tool.function.parameters)

    return {
      name: tool.function.name,
      description: tool.function.description,
      parametersJsonSchema: cleanedSchema,
    }
  }

  private static normalizeBaseUrl(raw: string): string {
    const trimmed = raw.replace(/\/+$/, '')
    try {
      const url = new URL(trimmed)
      // Avoid double version segments since we always append /v1beta ourselves.
      url.pathname = url.pathname.replace(/\/?(v1beta|v1alpha1|v1)(\/)?$/, '')
      return url.toString().replace(/\/+$/, '')
    } catch {
      // Fallback for non-standard schemes: just strip trailing version pieces.
      return trimmed.replace(/\/?(v1beta|v1alpha1|v1)(\/)?$/, '')
    }
  }

  private static normalizeModelPath(model: string): string {
    if (model.startsWith('models/') || model.startsWith('tunedModels/')) {
      return model
    }
    return `models/${model}`
  }
}
