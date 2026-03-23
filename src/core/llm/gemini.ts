import { GoogleGenAI } from '@google/genai'
import type {
  Content as GeminiContent,
  FunctionCall as GeminiFunctionCall,
  GenerateContentConfig as GeminiGenerateContentConfig,
  GenerateContentParameters as GeminiGenerateContentParams,
  GenerateContentResponse as GeminiGenerateContentResponse,
  Part as GeminiPart,
  Tool as GeminiTool,
} from '@google/genai'
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
  LLMResponseNonStreaming,
  LLMResponseStreaming,
  ToolCall,
  ToolCallDelta,
} from '../../types/llm/response'
import { LLMProvider } from '../../types/provider.types'
import {
  type ToolCallArguments,
  getToolCallArgumentsObject,
} from '../../types/tool-call.types'
import { parseImageDataUrl } from '../../utils/llm/image'
import { toProviderHeadersRecord } from '../../utils/llm/provider-headers'

import { BaseLLMProvider } from './base'
import {
  LLMAPIKeyInvalidException,
  LLMAPIKeyNotSetException,
  LLMRateLimitExceededException,
} from './exception'

type GeminiStreamGenerator = Awaited<
  ReturnType<
    InstanceType<typeof GoogleGenAI>['models']['generateContentStream']
  >
>
type GeminiStreamChunk =
  GeminiStreamGenerator extends AsyncGenerator<infer Chunk> ? Chunk : never
type GeminiRequestConfig = GeminiGenerateContentConfig & {
  abortSignal?: AbortSignal
}
type GeminiFunctionCallWithMetadata = GeminiFunctionCall & {
  thoughtSignature?: string
}
type GeminiReplayPart = GeminiPart & {
  thoughtSignature?: string
}

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
export class GeminiProvider extends BaseLLMProvider<LLMProvider> {
  private static readonly SUPPORTED_IMAGE_TYPES = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/heic',
    'image/heif',
  ] as const

  private client: GoogleGenAI
  private apiKey: string

  constructor(provider: LLMProvider) {
    super(provider)

    const baseUrl = provider.baseUrl
      ? GeminiProvider.normalizeBaseUrl(provider.baseUrl)
      : undefined
    const defaultHeaders = toProviderHeadersRecord(provider.customHeaders)
    const httpOptions =
      baseUrl || defaultHeaders
        ? {
            ...(baseUrl ? { baseUrl } : {}),
            ...(defaultHeaders ? { headers: defaultHeaders } : {}),
          }
        : undefined

    this.client = new GoogleGenAI({
      apiKey: provider.apiKey ?? '',
      httpOptions,
    })
    this.apiKey = provider.apiKey ?? ''
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

    const systemMessages = request.messages.filter((m) => m.role === 'system')
    const systemInstruction: string | undefined =
      systemMessages.length > 0
        ? systemMessages.map((m) => m.content).join('\n')
        : undefined

    try {
      const config: GeminiRequestConfig = {
        maxOutputTokens: request.max_tokens ?? undefined,
        temperature: request.temperature ?? undefined,
      }
      if (model.thinking?.enabled) {
        const budget = model.thinking.thinking_budget
        config.thinkingConfig = {
          thinkingBudget: budget,
          includeThoughts: true,
        }
      }
      if (options?.signal) {
        config.abortSignal = options.signal
      }

      // Prepare tools including Gemini native tools
      const tools = this.prepareTools(request, model, options)

      const contents = GeminiProvider.buildRequestContents(request.messages)

      const shouldIncludeConfig =
        (tools?.length ?? 0) > 0 ||
        Object.values(config).some((value) => value !== undefined) ||
        Boolean(systemInstruction) ||
        Boolean(options?.signal)

      const payloadBase: GeminiGenerateContentParams = {
        model: request.model,
        contents,
        ...(shouldIncludeConfig
          ? {
              config: {
                ...config,
                ...(tools ? { tools } : {}),
                ...(systemInstruction ? { systemInstruction } : {}),
              },
            }
          : {}),
      }

      const payload = this.applyCustomModelParameters(
        model,
        payloadBase as GeminiGenerateContentParams & Record<string, unknown>,
      )

      const result = await this.client.models.generateContent(payload)

      const messageId = crypto.randomUUID()
      return GeminiProvider.parseNonStreamingResponse(
        result,
        request.model,
        messageId,
      )
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

    const systemMessages = request.messages.filter((m) => m.role === 'system')
    const systemInstruction: string | undefined =
      systemMessages.length > 0
        ? systemMessages.map((m) => m.content).join('\n')
        : undefined

    try {
      if (options?.signal?.aborted) {
        throw GeminiProvider.createAbortError()
      }
      const config: GeminiRequestConfig = {
        maxOutputTokens: request.max_tokens ?? undefined,
        temperature: request.temperature ?? undefined,
      }
      if (model.thinking?.enabled) {
        const budget = model.thinking.thinking_budget
        config.thinkingConfig = {
          thinkingBudget: budget,
          includeThoughts: true,
        }
      }
      if (options?.signal) {
        config.abortSignal = options.signal
      }

      // Prepare tools including Gemini native tools
      const tools = this.prepareTools(request, model, options)

      const contents = GeminiProvider.buildRequestContents(request.messages)

      const shouldIncludeConfig =
        (tools?.length ?? 0) > 0 ||
        Object.values(config).some((value) => value !== undefined) ||
        Boolean(systemInstruction) ||
        Boolean(options?.signal)

      const payloadBase: GeminiGenerateContentParams = {
        model: request.model,
        contents,
        ...(shouldIncludeConfig
          ? {
              config: {
                ...config,
                ...(tools ? { tools } : {}),
                ...(systemInstruction ? { systemInstruction } : {}),
              },
            }
          : {}),
      }

      const payload = this.applyCustomModelParameters(
        model,
        payloadBase as GeminiGenerateContentParams & Record<string, unknown>,
      )

      const stream = await this.client.models.generateContentStream(payload)

      const messageId = crypto.randomUUID()
      return this.streamResponseGenerator(
        stream,
        request.model,
        messageId,
        options?.signal,
      )
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

  private async *streamResponseGenerator(
    stream: AsyncIterable<GeminiStreamChunk>,
    model: string,
    messageId: string,
    signal?: AbortSignal,
  ): AsyncIterable<LLMResponseStreaming> {
    const iterator = stream[Symbol.asyncIterator]()
    let abortListener: (() => void) | null = null
    try {
      if (signal) {
        if (signal.aborted) {
          throw GeminiProvider.createAbortError()
        }
        const onAbort = () => {
          if (typeof iterator.return === 'function') {
            void iterator.return()
          }
        }
        signal.addEventListener('abort', onAbort, { once: true })
        abortListener = onAbort
      }
      while (true) {
        if (signal?.aborted) {
          throw GeminiProvider.createAbortError()
        }
        const { value, done } = await iterator.next()
        if (done) break
        if (signal?.aborted) {
          throw GeminiProvider.createAbortError()
        }
        yield GeminiProvider.parseStreamingResponseChunk(
          value,
          model,
          messageId,
        )
      }
    } finally {
      if (abortListener && signal) {
        signal.removeEventListener('abort', abortListener)
      }
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

  static parseNonStreamingResponse(
    response: GeminiGenerateContentResponse,
    model: string,
    messageId: string,
  ): LLMResponseNonStreaming {
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
          },
        },
      ],
      created: Date.now(),
      model,
      object: 'chat.completion',
      usage: response.usageMetadata
        ? {
            prompt_tokens: response.usageMetadata.promptTokenCount ?? 0,
            completion_tokens: response.usageMetadata.candidatesTokenCount ?? 0,
            total_tokens: response.usageMetadata.totalTokenCount ?? 0,
          }
        : undefined,
    }
  }

  private static isGeminiContent(
    content: GeminiContent | null,
  ): content is GeminiContent {
    return content !== null
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

  private static isHttpError(
    error: unknown,
  ): error is { status: number; message?: string } {
    return (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      typeof (error as { status?: unknown }).status === 'number'
    )
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

  static parseStreamingResponseChunk(
    chunk: GeminiStreamChunk,
    model: string,
    messageId: string,
  ): LLMResponseStreaming {
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
          },
        },
      ],
      created: Date.now(),
      model: model,
      object: 'chat.completion.chunk',
      usage: chunk.usageMetadata
        ? {
            prompt_tokens: chunk.usageMetadata.promptTokenCount ?? 0,
            completion_tokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
            total_tokens: chunk.usageMetadata.totalTokenCount ?? 0,
          }
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

  async getEmbedding(model: string, text: string): Promise<number[]> {
    if (!this.apiKey) {
      throw new LLMAPIKeyNotSetException(
        `Provider ${this.provider.id} API key is missing. Please set it in settings menu.`,
      )
    }

    try {
      const res = await this.client.models.embedContent({
        model,
        contents: text,
      })
      // Support both shapes
      const values =
        ('embedding' in res &&
        res.embedding &&
        typeof res.embedding === 'object' &&
        Array.isArray((res.embedding as { values?: number[] }).values)
          ? (res.embedding as { values?: number[] }).values
          : res.embeddings?.[0]?.values) ?? null
      if (!values) {
        throw new Error('Gemini embedding response did not include values.')
      }
      return values
    } catch (error) {
      if (GeminiProvider.isHttpError(error) && error.status === 429) {
        throw new LLMRateLimitExceededException(
          'Gemini API rate limit exceeded. Please try again later.',
        )
      }
      throw GeminiProvider.toError(error)
    }
  }

  private prepareTools(
    request: LLMRequestNonStreaming | LLMRequestStreaming,
    model: ChatModel,
    options?: LLMOptions,
  ): GeminiTool[] | undefined {
    const tools: GeminiTool[] = []

    // Add Gemini native tools if enabled
    if (options?.geminiTools) {
      const geminiTools = options.geminiTools

      // Add Google Search tool
      if (geminiTools.useWebSearch) {
        tools.push({ googleSearch: {} })
      }

      // Add URL Context tool
      if (geminiTools.useUrlContext) {
        tools.push({ urlContext: {} })
      }
    }

    // Add function calling tools if provided
    if (request.tools && request.tools.length > 0) {
      tools.push(
        ...request.tools.map((tool) => GeminiProvider.parseRequestTool(tool)),
      )
    }

    return tools.length > 0 ? tools : undefined
  }

  private static removeAdditionalProperties(schema: unknown): unknown {
    // TODO: Remove this function when Gemini supports additionalProperties field in JSON schema
    if (typeof schema !== 'object' || schema === null) {
      return schema
    }

    if (Array.isArray(schema)) {
      return schema.map((item) => this.removeAdditionalProperties(item))
    }

    const rest = { ...(schema as Record<string, unknown>) }
    delete rest.additionalProperties

    return Object.fromEntries(
      Object.entries(rest).map(([key, value]) => [
        key,
        this.removeAdditionalProperties(value),
      ]),
    )
  }

  private static parseRequestTool(tool: RequestTool): GeminiTool {
    const cleanedSchema = this.removeAdditionalProperties(
      tool.function.parameters,
    )

    return {
      functionDeclarations: [
        {
          name: tool.function.name,
          description: tool.function.description,
          parametersJsonSchema: cleanedSchema,
        },
      ],
    }
  }

  private static normalizeBaseUrl(raw: string): string {
    const trimmed = raw.replace(/\/+$/, '')
    try {
      const url = new URL(trimmed)
      // Avoid double version segments when SDK appends /v1beta or /v1.
      url.pathname = url.pathname.replace(/\/?(v1beta|v1alpha1|v1)(\/)?$/, '')
      return url.toString().replace(/\/+$/, '')
    } catch {
      // Fallback for non-standard schemes: just strip trailing version pieces.
      return trimmed.replace(/\/?(v1beta|v1alpha1|v1)(\/)?$/, '')
    }
  }
}
