import type {
  Content as GeminiContent,
  GenerateContentResponse as GeminiGenerateContentResponse,
  Tool as GeminiTool,
} from '@google/genai'

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
import { LLMProvider } from '../../types/provider.types'
import { createObsidianFetch } from '../../utils/llm/obsidian-fetch'
import { toProviderHeadersRecord } from '../../utils/llm/provider-headers'

import { getGeminiOAuthService } from '../auth/geminiOAuthRuntime'

import { BaseLLMProvider } from './base'
import {
  LLMProviderNotConfiguredException,
  LLMRateLimitExceededException,
} from './exception'
import { GeminiProvider } from './gemini'
import {
  createRequestTransportMemoryKey,
  runWithRequestTransport,
  runWithRequestTransportForStream,
} from './requestTransport'

const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com'

type GeminiApiBody = {
  response?: GeminiGenerateContentResponse
  traceId?: string
}

type GeminiStreamingChunk = GeminiGenerateContentResponse & {
  responseId?: string
}

export class GeminiOAuthProvider extends BaseLLMProvider<LLMProvider> {
  private readonly requestTransportMemoryKey: string
  private readonly obsidianFetch = createObsidianFetch()

  constructor(provider: LLMProvider) {
    super(provider)
    this.requestTransportMemoryKey = createRequestTransportMemoryKey({
      providerType: provider.presetType,
      providerId: provider.id,
      baseUrl: CODE_ASSIST_ENDPOINT,
    })
  }

  async generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    const payload = await this.buildWrappedPayload(model, request, options)

    return runWithRequestTransport({
      mode: this.getTransportMode(),
      memoryKey: this.requestTransportMemoryKey,
      runBrowser: async () =>
        this.generateViaFetch(this.obsidianFetch, payload, request.model),
      runObsidian: async () =>
        this.generateViaFetch(this.obsidianFetch, payload, request.model),
    })
  }

  async streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    const payload = await this.buildWrappedPayload(model, request, options)

    return runWithRequestTransportForStream({
      mode: this.getTransportMode(),
      memoryKey: this.requestTransportMemoryKey,
      signal: options?.signal,
      createBrowserStream: async (signal) =>
        this.streamViaBufferedFetch(
          this.obsidianFetch,
          payload,
          request.model,
          signal,
        ),
      createObsidianStream: async (signal) =>
        this.streamViaBufferedFetch(
          this.obsidianFetch,
          payload,
          request.model,
          signal,
        ),
    })
  }

  async getEmbedding(_model: string, _text: string): Promise<number[]> {
    throw new LLMProviderNotConfiguredException(
      'Gemini OAuth provider does not support embeddings.',
    )
  }

  private getTransportMode() {
    // Gemini OAuth relies on Google Code Assist endpoints. In Obsidian these
    // endpoints are reliably reachable through requestUrl, while browser fetch
    // hits CORS and desktop node-fetch can time out or expose incompatible
    // stream bodies. Force the transport to Obsidian for stability.
    return 'obsidian' as const
  }

  private async buildWrappedPayload(
    model: ChatModel,
    request: LLMRequestNonStreaming | LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<{
    headers: Headers
    body: string
    streaming: boolean
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

    const systemMessages = request.messages.filter((message) => message.role === 'system')
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
    if (model.thinking?.enabled) {
      config.thinkingConfig = {
        thinkingBudget: model.thinking.thinking_budget,
        includeThoughts: true,
      }
    }

    const tools = this.prepareTools(request, options)
    const requestPayloadBase = {
      contents: GeminiProvider.buildRequestContents(request.messages),
      ...(Object.keys(config).length > 0 ? { generationConfig: config } : {}),
      ...(tools ? { tools } : {}),
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

    return {
      headers,
      body,
      streaming: request.stream === true,
    }
  }

  private async generateViaFetch(
    customFetch: typeof fetch,
    payload: {
      headers: Headers
      body: string
    },
    model: string,
  ): Promise<LLMResponseNonStreaming> {
    const response = await customFetch(
      `${CODE_ASSIST_ENDPOINT}/v1internal:generateContent`,
      {
        method: 'POST',
        headers: payload.headers,
        body: payload.body,
      },
    )

    if (!response.ok) {
      await this.throwForBadResponse(response)
    }

    const parsed = (await response.json()) as GeminiApiBody | GeminiGenerateContentResponse
    const body = this.unwrapResponse(parsed)
    return GeminiProvider.parseNonStreamingResponse(
      body,
      model,
      body.responseId ?? crypto.randomUUID(),
    )
  }

  private async streamViaFetch(
    customFetch: typeof fetch,
    payload: {
      headers: Headers
      body: string
    },
    model: string,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    const headers = new Headers(payload.headers)
    headers.set('Accept', 'text/event-stream')

    const response = await customFetch(
      `${CODE_ASSIST_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers,
        body: payload.body,
        signal,
      },
    )

    if (!response.ok) {
      await this.throwForBadResponse(response)
    }

    if (!response.body) {
      throw new Error('Gemini OAuth streaming response body is missing.')
    }

    return this.streamFromSse(response.body, model, signal)
  }

  private async streamViaBufferedFetch(
    customFetch: typeof fetch,
    payload: {
      headers: Headers
      body: string
    },
    model: string,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    const headers = new Headers(payload.headers)
    headers.set('Accept', 'text/event-stream')

    const response = await customFetch(
      `${CODE_ASSIST_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers,
        body: payload.body,
        signal,
      },
    )

    if (!response.ok) {
      await this.throwForBadResponse(response)
    }

    const text = await response.text()
    return this.streamFromSseText(text, model)
  }

  private async throwForBadResponse(response: Response): Promise<never> {
    const text = await response.text().catch(() => '')
    if (response.status === 429) {
      throw new LLMRateLimitExceededException(
        `Gemini OAuth rate limit exceeded: ${text || response.statusText}`,
      )
    }
    throw new Error(
      `Gemini OAuth request failed (${response.status} ${response.statusText})${text ? `: ${text}` : ''}`,
    )
  }

  private unwrapResponse(
    value: GeminiApiBody | GeminiGenerateContentResponse,
  ): GeminiGenerateContentResponse {
    if ('response' in value && value.response) {
      const responseId = value.response.responseId ?? value.traceId
      return (
        responseId
          ? { ...value.response, responseId }
          : value.response
      ) as GeminiGenerateContentResponse
    }
    return value as GeminiGenerateContentResponse
  }

  private async *streamFromSse(
    stream: ReadableStream<Uint8Array>,
    model: string,
    signal?: AbortSignal,
  ): AsyncIterable<LLMResponseStreaming> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError')
        }
        const { value, done } = await reader.read()
        if (done) {
          break
        }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const chunk = this.parseSseLine(line, model)
          if (chunk) {
            yield chunk
          }
        }
      }

      if (buffer.trim()) {
        const chunk = this.parseSseLine(buffer, model)
        if (chunk) {
          yield chunk
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }

  private async streamFromSseText(
    text: string,
    model: string,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    const lines = text.split(/\r?\n/)
    const chunks = lines
      .map((line) => this.parseSseLine(line, model))
      .filter((chunk): chunk is LLMResponseStreaming => Boolean(chunk))

    return {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          yield chunk
        }
      },
    }
  }

  private parseSseLine(
    line: string,
    model: string,
  ): LLMResponseStreaming | null {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) {
      return null
    }

    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') {
      return null
    }

    const parsed = JSON.parse(data) as GeminiApiBody | GeminiStreamingChunk
    const body = this.unwrapResponse(parsed)
    return GeminiProvider.parseStreamingResponseChunk(
      body as never,
      model,
      body.responseId ?? crypto.randomUUID(),
    )
  }

  private prepareTools(
    request: LLMRequestNonStreaming | LLMRequestStreaming,
    options?: LLMOptions,
  ): GeminiTool[] | undefined {
    const tools: GeminiTool[] = []

    if (options?.geminiTools?.useWebSearch) {
      tools.push({ googleSearch: {} })
    }

    if (options?.geminiTools?.useUrlContext) {
      tools.push({ urlContext: {} })
    }

    if (request.tools && request.tools.length > 0) {
      tools.push(...request.tools.map((tool) => this.parseRequestTool(tool)))
    }

    return tools.length > 0 ? tools : undefined
  }

  private parseRequestTool(tool: RequestTool): GeminiTool {
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

  private removeAdditionalProperties(schema: unknown): unknown {
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
}
