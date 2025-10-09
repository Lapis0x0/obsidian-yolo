import { GoogleGenAI } from '@google/genai'
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
} from '../../types/llm/response'
import { LLMProvider } from '../../types/provider.types'
import { parseImageDataUrl } from '../../utils/llm/image'

import { BaseLLMProvider } from './base'
import {
  LLMAPIKeyInvalidException,
  LLMAPIKeyNotSetException,
  LLMRateLimitExceededException,
} from './exception'

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
  private client: GoogleGenAI
  private apiKey: string

  constructor(provider: Extract<LLMProvider, { type: 'gemini' }>) {
    super(provider)
    if (provider.baseUrl) {
      throw new Error('Gemini does not support custom base URL')
    }

    this.client = new GoogleGenAI({ apiKey: provider.apiKey ?? '' })
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
      const config: any = {
        maxOutputTokens: request.max_tokens,
        temperature: request.temperature,
      }
      if ((model as any).thinking?.enabled) {
        const budget = (model as any).thinking.thinking_budget
        config.thinkingConfig = { thinkingBudget: budget }
        if (request.model.includes('2.5')) {
          config.thinkingConfig.includeThoughts = true
        }
      }

      // Prepare tools including Gemini native tools
      const tools = this.prepareTools(request, model, options)

      let payload: Record<string, unknown> = {
        model: request.model,
        contents: request.messages
          .map((message) => GeminiProvider.parseRequestMessage(message))
          .filter((m) => m !== null),
        config: {
          ...config,
          ...(tools ? { tools } : {}),
        },
      }

      if (systemInstruction) {
        payload.systemInstruction = systemInstruction
      }

      payload = this.applyCustomModelParameters(model, payload)

      const result: any = await this.client.models.generateContent(
        payload as any,
      )

      const messageId = crypto.randomUUID()
      return GeminiProvider.parseNonStreamingResponse(
        result,
        request.model,
        messageId,
      )
    } catch (error) {
      const isInvalidApiKey =
        error.message?.includes('API_KEY_INVALID') ||
        error.message?.includes('API key not valid')

      if (isInvalidApiKey) {
        throw new LLMAPIKeyInvalidException(
          `Provider ${this.provider.id} API key is invalid. Please update it in settings menu.`,
          error as Error,
        )
      }

      throw error
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
      const config: any = {
        maxOutputTokens: request.max_tokens,
        temperature: request.temperature,
      }
      if ((model as any).thinking?.enabled) {
        const budget = (model as any).thinking.thinking_budget
        config.thinkingConfig = { thinkingBudget: budget }
        if (request.model.includes('2.5')) {
          config.thinkingConfig.includeThoughts = true
        }
      }

      // Prepare tools including Gemini native tools
      const tools = this.prepareTools(request, model, options)

      let payload: Record<string, unknown> = {
        model: request.model,
        contents: request.messages
          .map((message) => GeminiProvider.parseRequestMessage(message))
          .filter((m) => m !== null),
        config: {
          ...config,
          ...(tools ? { tools } : {}),
        },
      }

      if (systemInstruction) {
        payload.systemInstruction = systemInstruction
      }

      payload = this.applyCustomModelParameters(model, payload)

      const stream = await this.client.models.generateContentStream(
        payload as any,
      )

      const messageId = crypto.randomUUID()
      return this.streamResponseGenerator(
        stream as any,
        request.model,
        messageId,
      )
    } catch (error) {
      const isInvalidApiKey =
        error.message?.includes('API_KEY_INVALID') ||
        error.message?.includes('API key not valid')

      if (isInvalidApiKey) {
        throw new LLMAPIKeyInvalidException(
          `Gemini API key is invalid. Please update it in settings menu.`,
          error as Error,
        )
      }
      // Fallback: some networks/proxies can break streaming ("protocol error: unexpected EOF").
      // Try non-streaming once and adapt it into a single-chunk async iterable.
      const shouldFallback = /protocol error|unexpected EOF/i.test(
        String(error?.message ?? ''),
      )
      if (shouldFallback) {
        const nonStream = await this.generateResponse(
          model,
          request as any,
          options,
        )
        const singleChunk = async function* (
          resp: LLMResponseNonStreaming,
        ): AsyncIterable<LLMResponseStreaming> {
          yield {
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
        }
        return singleChunk(nonStream)
      }
      throw error
    }
  }

  private async *streamResponseGenerator(
    stream: AsyncIterable<any>,
    model: string,
    messageId: string,
  ): AsyncIterable<LLMResponseStreaming> {
    for await (const chunk of stream as any) {
      yield GeminiProvider.parseStreamingResponseChunk(chunk, model, messageId)
    }
  }

  static parseRequestMessage(message: RequestMessage): any | null {
    switch (message.role) {
      case 'system':
        // System messages should be extracted and handled separately
        return null
      case 'user': {
        const contentParts: any[] = Array.isArray(message.content)
          ? message.content.map((part) => {
              switch (part.type) {
                case 'text':
                  return { text: part.text }
                case 'image_url': {
                  const { mimeType, base64Data } = parseImageDataUrl(
                    part.image_url.url,
                  )
                  GeminiProvider.validateImageType(mimeType)

                  return {
                    inlineData: {
                      data: base64Data,
                      mimeType,
                    },
                  }
                }
              }
            })
          : [{ text: message.content }]

        return {
          role: 'user',
          parts: contentParts,
        }
      }
      case 'assistant': {
        const contentParts: any[] = [
          ...(message.content === '' ? [] : [{ text: message.content }]),
          ...(message.tool_calls?.map((toolCall): any => {
            try {
              const args = JSON.parse(toolCall.arguments ?? '{}')
              return {
                functionCall: {
                  name: toolCall.name,
                  args,
                },
              }
            } catch (error) {
              // If the arguments are not valid JSON, return an empty object
              return {
                functionCall: {
                  name: toolCall.name,
                  args: {},
                },
              }
            }
          }) ?? []),
        ]

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
                name: message.tool_call.name,
                response: { result: message.content }, // Gemini requires a response object
              },
            },
          ],
        }
      }
    }
  }

  static parseNonStreamingResponse(
    response: any,
    model: string,
    messageId: string,
  ): LLMResponseNonStreaming {
    // Extract thought summaries if present
    let reasoningText: string | undefined
    try {
      const parts = response?.response?.candidates?.[0]?.content?.parts ?? []
      if (Array.isArray(parts) && parts.length > 0) {
        const thoughtPieces = parts
          .filter((p: any) => p?.thought && typeof p?.text === 'string')
          .map((p: any) => p.text)
        reasoningText =
          thoughtPieces.length > 0 ? thoughtPieces.join('') : undefined
      }
    } catch {
      // Ignore parsing issues for optional reasoning metadata.
    }
    return {
      id: messageId,
      choices: [
        {
          finish_reason:
            response.response?.candidates?.[0]?.finishReason ?? null,
          message: {
            content: (response.text ?? response.response?.text?.()) as string,
            reasoning: reasoningText ?? null,
            role: 'assistant',
            tool_calls: (
              response.functionCalls ?? response.response?.functionCalls?.()
            )?.map((f: any) => ({
              id: uuidv4(),
              type: 'function',
              function: {
                name: f.name,
                arguments: JSON.stringify(f.args),
              },
            })),
          },
        },
      ],
      created: Date.now(),
      model: model,
      object: 'chat.completion',
      usage:
        (response.response?.usageMetadata ?? response.usageMetadata)
          ? {
              prompt_tokens: (response.response?.usageMetadata
                ?.promptTokenCount ??
                response.usageMetadata?.promptTokenCount) as number,
              completion_tokens: (response.response?.usageMetadata
                ?.candidatesTokenCount ??
                response.usageMetadata?.candidatesTokenCount) as number,
              total_tokens: (response.response?.usageMetadata
                ?.totalTokenCount ??
                response.usageMetadata?.totalTokenCount) as number,
            }
          : undefined,
    }
  }

  static parseStreamingResponseChunk(
    chunk: any,
    model: string,
    messageId: string,
  ): LLMResponseStreaming {
    // Separate answer text and thought summaries if present in parts
    let contentPiece = ''
    let reasoningPiece = ''
    try {
      const parts = chunk?.candidates?.[0]?.content?.parts ?? []
      if (Array.isArray(parts) && parts.length > 0) {
        for (const p of parts) {
          if (!p?.text) continue
          if (p?.thought) reasoningPiece += p.text
          else contentPiece += p.text
        }
      }
    } catch {
      // Ignore parsing issues for partial chunk metadata.
    }
    return {
      id: messageId,
      choices: [
        {
          finish_reason: chunk.candidates?.[0]?.finishReason ?? null,
          delta: {
            content:
              (contentPiece ||
                (typeof chunk.text === 'function'
                  ? chunk.text()
                  : chunk.text)) ??
              '',
            reasoning: reasoningPiece || undefined,
            tool_calls: (typeof chunk.functionCalls === 'function'
              ? chunk.functionCalls()
              : chunk.functionCalls
            )?.map((f: any, index: number) => ({
              index,
              id: uuidv4(),
              type: 'function',
              function: {
                name: f.name,
                arguments: JSON.stringify(f.args),
              },
            })),
          },
        },
      ],
      created: Date.now(),
      model: model,
      object: 'chat.completion.chunk',
      usage: chunk.usageMetadata
        ? {
            prompt_tokens: chunk.usageMetadata.promptTokenCount,
            completion_tokens: chunk.usageMetadata.candidatesTokenCount,
            total_tokens: chunk.usageMetadata.totalTokenCount,
          }
        : undefined,
    }
  }

  private static removeAdditionalProperties(schema: unknown): unknown {
    // TODO: Remove this function when Gemini supports additionalProperties field in JSON schema
    if (typeof schema !== 'object' || schema === null) {
      return schema
    }

    if (Array.isArray(schema)) {
      return schema.map((item) => this.removeAdditionalProperties(item))
    }

    const { additionalProperties: _, ...rest } = schema as Record<
      string,
      unknown
    >

    return Object.fromEntries(
      Object.entries(rest).map(([key, value]) => [
        key,
        this.removeAdditionalProperties(value),
      ]),
    )
  }

  private static parseRequestTool(tool: RequestTool): any {
    // Remove additionalProperties for compatibility
    const cleanedParameters = this.removeAdditionalProperties(
      tool.function.parameters,
    ) as Record<string, any>

    return {
      functionDeclarations: [
        {
          name: tool.function.name,
          description: tool.function.description,
          parametersJsonSchema: {
            type: 'object',
            properties: cleanedParameters.properties ?? {},
          },
        },
      ],
    }
  }

  private static validateImageType(mimeType: string) {
    const SUPPORTED_IMAGE_TYPES = [
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/heic',
      'image/heif',
    ]
    if (!SUPPORTED_IMAGE_TYPES.includes(mimeType)) {
      throw new Error(
        `Gemini does not support image type ${mimeType}. Supported types: ${SUPPORTED_IMAGE_TYPES.join(
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
      const res: any = await this.client.models.embedContent({
        model,
        contents: text,
      })
      // Support both shapes
      const values = res.embedding?.values ?? res.embeddings?.[0]?.values
      return values as number[]
    } catch (error) {
      if (error.status === 429) {
        throw new LLMRateLimitExceededException(
          'Gemini API rate limit exceeded. Please try again later.',
        )
      }
      throw error
    }
  }

  private prepareTools(
    request: LLMRequestNonStreaming | LLMRequestStreaming,
    model: ChatModel,
    options?: LLMOptions,
  ): any[] | undefined {
    const tools: any[] = []

    // Add Gemini native tools if enabled
    if ((model as any).toolType === 'gemini' && (options as any)?.geminiTools) {
      const geminiTools = (options as any).geminiTools

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
}
