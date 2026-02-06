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
import { parseImageDataUrl } from '../../utils/llm/image'

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
export class GeminiProvider extends BaseLLMProvider<
  Extract<LLMProvider, { type: 'gemini' }>
> {
  private static readonly SUPPORTED_IMAGE_TYPES = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/heic',
    'image/heif',
  ] as const

  private client: GoogleGenAI
  private apiKey: string

  constructor(provider: Extract<LLMProvider, { type: 'gemini' }>) {
    super(provider)

    const baseUrl = provider.baseUrl
      ? GeminiProvider.normalizeBaseUrl(provider.baseUrl)
      : undefined

    this.client = new GoogleGenAI({
      apiKey: provider.apiKey ?? '',
      httpOptions: baseUrl ? { baseUrl } : undefined,
    })
    this.apiKey = provider.apiKey ?? ''
  }

  async generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    if (model.providerType !== 'gemini') {
      throw new Error('Model is not a Gemini model')
    }

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

      const contents = request.messages
        .map((message) => GeminiProvider.parseRequestMessage(message))
        .filter((content): content is GeminiContent =>
          GeminiProvider.isGeminiContent(content),
        )

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
    if (model.providerType !== 'gemini') {
      throw new Error('Model is not a Gemini model')
    }

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

      const contents = request.messages
        .map((message) => GeminiProvider.parseRequestMessage(message))
        .filter((content): content is GeminiContent =>
          GeminiProvider.isGeminiContent(content),
        )

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

  static parseRequestMessage(message: RequestMessage): GeminiContent | null {
    switch (message.role) {
      case 'system':
        // System messages should be extracted and handled separately
        return null
      case 'user': {
        const contentParts: GeminiPart[] = Array.isArray(message.content)
          ? message.content.flatMap((part) => {
              if (part.type === 'text') {
                return [{ text: part.text }]
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
                  } as GeminiPart,
                ]
              }
              return []
            })
          : [{ text: message.content } as GeminiPart]

        return {
          role: 'user',
          parts: contentParts,
        }
      }
      case 'assistant': {
        const contentParts: GeminiPart[] = []
        if (typeof message.content === 'string' && message.content !== '') {
          contentParts.push({ text: message.content })
        }

        // NOTE:
        // For Gemini thinking/tool models, replaying historical functionCall
        // parts without provider-issued thought signatures can trigger 400:
        // "Function call is missing a thought_signature...".
        // We therefore avoid rehydrating assistant tool_calls here and rely on
        // the corresponding tool/functionResponse messages as execution context.

        if (contentParts.length === 0) {
          return null
        }

        return {
          role: 'model',
          parts: contentParts,
        }
      }
      case 'tool': {
        return {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: message.tool_call.id,
                name: message.tool_call.name,
                response: { result: message.content },
              },
            },
          ],
        }
      }
    }
  }

  static parseNonStreamingResponse(
    response: GeminiGenerateContentResponse,
    model: string,
    messageId: string,
  ): LLMResponseNonStreaming {
    const parts = response.candidates?.[0]?.content?.parts ?? []
    const reasoningPieces = parts
      .filter(
        (part): part is GeminiPart & { text: string } =>
          Boolean(part?.thought) && typeof part?.text === 'string',
      )
      .map((part) => part.text)
    const reasoningText =
      reasoningPieces.length > 0 ? reasoningPieces.join('') : undefined

    const toolCallsRaw = response.functionCalls
      ?.map((call) => GeminiProvider.mapFunctionCall(call))
      .filter((call): call is ToolCall => call !== null)
    const toolCalls =
      toolCallsRaw && toolCallsRaw.length > 0 ? toolCallsRaw : undefined

    return {
      id: messageId,
      choices: [
        {
          finish_reason: response.candidates?.[0]?.finishReason ?? null,
          message: {
            content: response.text ?? '',
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

  private static safeParseJsonObject(raw: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>
      }
    } catch {
      // swallow parse errors and fallback to empty object
    }
    return {}
  }

  private static mapFunctionCall(
    call: GeminiFunctionCall | undefined,
  ): ToolCall | null {
    if (!call?.name) {
      return null
    }
    const args = call.args && typeof call.args === 'object' ? call.args : {}

    return {
      id: call.id ?? uuidv4(),
      type: 'function' as const,
      function: {
        name: call.name,
        arguments: JSON.stringify(args),
      },
    }
  }

  private static mapFunctionCallDelta(
    call: GeminiFunctionCall | undefined,
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
    // Separate answer text and thought summaries if present in parts
    let contentPiece = ''
    let reasoningPiece = ''
    const parts = chunk.candidates?.[0]?.content?.parts ?? []
    if (Array.isArray(parts) && parts.length > 0) {
      for (const p of parts) {
        if (typeof p?.text !== 'string') continue
        if (p.thought) {
          reasoningPiece += p.text
        } else {
          contentPiece += p.text
        }
      }
    }
    const toolCallDeltaRaw =
      chunk.functionCalls
        ?.map((call, index) => GeminiProvider.mapFunctionCallDelta(call, index))
        .filter((call): call is ToolCallDelta => call !== null) ?? []
    const toolCallDeltas =
      toolCallDeltaRaw.length > 0 ? toolCallDeltaRaw : undefined

    return {
      id: messageId,
      choices: [
        {
          finish_reason: chunk.candidates?.[0]?.finishReason ?? null,
          delta: {
            content: contentPiece || chunk.text || '',
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
    if (model.providerType === 'gemini' && options?.geminiTools) {
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
