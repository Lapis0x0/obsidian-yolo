import {
  BedrockRuntimeClient,
  ContentBlock,
  ConverseCommand,
  ConverseCommandInput,
  ConverseStreamCommand,
  ConverseStreamOutput,
  ImageFormat,
  InvokeModelCommand,
  Message,
  SystemContentBlock,
  TokenUsage,
  Tool,
  ToolChoice,
  ToolResultContentBlock,
} from '@aws-sdk/client-bedrock-runtime'

import { ChatModel } from '../../types/chat-model.types'
import { REASONING_META, resolveRequestReasoningLevel } from '../../types/reasoning'
import {
  ContentPart,
  LLMOptions,
  LLMRequestNonStreaming,
  LLMRequestStreaming,
  RequestMessage,
  RequestTool,
  RequestToolChoice,
} from '../../types/llm/request'
import {
  LLMResponseNonStreaming,
  LLMResponseStreaming,
  ResponseUsage,
  ToolCall,
} from '../../types/llm/response'
import { LLMProvider } from '../../types/provider.types'
import { getToolCallArgumentsObject } from '../../types/tool-call.types'
import {
  buildBedrockEmbeddingRequestBody,
  createBedrockBearerClientConfig,
  getBedrockRegion,
} from '../../utils/llm/bedrock'
import { parseImageDataUrl } from '../../utils/llm/image'

import { BaseLLMProvider } from './base'
import {
  LLMAPIKeyInvalidException,
  LLMAPIKeyNotSetException,
  LLMModelNotFoundException,
  LLMProviderNotConfiguredException,
  LLMRateLimitExceededException,
} from './exception'
import { ModelRequestPolicy, runWithModelRequestPolicy } from './requestPolicy'

type BedrockJsonBody =
  | string
  | Uint8Array
  | { transformToString?: () => Promise<string> }

type BedrockDocumentType = NonNullable<
  ConverseCommandInput['additionalModelRequestFields']
>

export class BedrockProvider extends BaseLLMProvider<LLMProvider> {
  private client: BedrockRuntimeClient
  private readonly requestPolicy?: ModelRequestPolicy

  private static readonly DEFAULT_MAX_TOKENS = 8192

  constructor(
    provider: LLMProvider,
    options?: {
      requestPolicy?: ModelRequestPolicy
    },
  ) {
    super(provider)
    this.requestPolicy = options?.requestPolicy
    this.client = new BedrockRuntimeClient(
      createBedrockBearerClientConfig(provider),
    )
  }

  async generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    this.validateConfiguration()

    const systemBlocks = BedrockProvider.extractSystemBlocks(request.messages)
    const messages = BedrockProvider.convertMessages(request.messages)
    const thinkingBudget = BedrockProvider.resolveThinkingBudgetTokens(
      model,
      request,
    )
    const maxTokens =
      request.max_tokens ??
      (thinkingBudget !== null
        ? thinkingBudget + BedrockProvider.DEFAULT_MAX_TOKENS
        : BedrockProvider.DEFAULT_MAX_TOKENS)

    const toolConfig = BedrockProvider.buildToolConfig(
      request.tools,
      request.tool_choice,
    )

    const additionalModelRequestFields =
      BedrockProvider.buildAdditionalModelRequestFields(model, request)

    try {
      const response = await runWithModelRequestPolicy({
        requestPolicy: this.requestPolicy,
        signal: options?.signal,
        run: (signal) =>
          this.client.send(
            new ConverseCommand({
              modelId: request.model,
              messages,
              ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
              inferenceConfig: {
                maxTokens,
                ...(request.temperature != null
                  ? { temperature: request.temperature }
                  : {}),
                ...(request.top_p != null ? { topP: request.top_p } : {}),
              },
              ...(toolConfig ? { toolConfig } : {}),
              ...(additionalModelRequestFields
                ? { additionalModelRequestFields }
                : {}),
            }),
            {
              abortSignal: signal,
            },
          ),
      })

      const outputMessage = response.output?.message
      const contentBlocks = outputMessage?.content ?? []

      const textContent = contentBlocks
        .filter((b): b is ContentBlock.TextMember => 'text' in b)
        .map((b) => b.text)
        .join('')

      const reasoningContent =
        contentBlocks
          .filter(
            (b): b is ContentBlock.ReasoningContentMember =>
              'reasoningContent' in b,
          )
          .map((b) => b.reasoningContent.reasoningText?.text ?? '')
          .join('') || undefined

      const toolCalls: ToolCall[] = contentBlocks
        .filter((b): b is ContentBlock.ToolUseMember => 'toolUse' in b)
        .map(
          (b): ToolCall => ({
            id: b.toolUse.toolUseId,
            type: 'function',
            function: {
              name: b.toolUse.name ?? '',
              arguments: JSON.stringify(b.toolUse.input),
            },
          }),
        )

      const usage = BedrockProvider.convertUsage(response.usage)

      return {
        id: `bedrock-${Date.now()}`,
        choices: [
          {
            finish_reason: BedrockProvider.mapStopReason(response.stopReason),
            message: {
              content: textContent,
              reasoning: reasoningContent,
              role: 'assistant',
              tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            },
          },
        ],
        model: request.model,
        object: 'chat.completion',
        usage,
      }
    } catch (error) {
      throw BedrockProvider.toBedrockError(this.provider, error)
    }
  }

  async streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    this.validateConfiguration()

    const systemBlocks = BedrockProvider.extractSystemBlocks(request.messages)
    const messages = BedrockProvider.convertMessages(request.messages)
    const thinkingBudget = BedrockProvider.resolveThinkingBudgetTokens(
      model,
      request,
    )
    const maxTokens =
      request.max_tokens ??
      (thinkingBudget !== null
        ? thinkingBudget + BedrockProvider.DEFAULT_MAX_TOKENS
        : BedrockProvider.DEFAULT_MAX_TOKENS)

    const toolConfig = BedrockProvider.buildToolConfig(
      request.tools,
      request.tool_choice,
    )

    const additionalModelRequestFields =
      BedrockProvider.buildAdditionalModelRequestFields(model, request)

    try {
      const response = await runWithModelRequestPolicy({
        requestPolicy: this.requestPolicy,
        signal: options?.signal,
        run: (signal) =>
          this.client.send(
            new ConverseStreamCommand({
              modelId: request.model,
              messages,
              ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
              inferenceConfig: {
                maxTokens,
                ...(request.temperature != null
                  ? { temperature: request.temperature }
                  : {}),
                ...(request.top_p != null ? { topP: request.top_p } : {}),
              },
              ...(toolConfig ? { toolConfig } : {}),
              ...(additionalModelRequestFields
                ? { additionalModelRequestFields }
                : {}),
            }),
            {
              abortSignal: signal,
            },
          ),
      })

      if (!response.stream) {
        throw new Error('Bedrock ConverseStream returned no stream')
      }

      return this.streamResponseGenerator(response.stream, request.model)
    } catch (error) {
      throw BedrockProvider.toBedrockError(this.provider, error)
    }
  }

  private async *streamResponseGenerator(
    stream: AsyncIterable<ConverseStreamOutput>,
    model: string,
  ): AsyncIterable<LLMResponseStreaming> {
    const messageId = `bedrock-${Date.now()}`
    let usage: ResponseUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    }
    let finishReason: string | null = null

    for await (const event of stream) {
      if (event.contentBlockDelta) {
        const delta = event.contentBlockDelta.delta
        const blockIndex = event.contentBlockDelta.contentBlockIndex ?? 0

        if (delta && 'text' in delta && delta.text) {
          yield {
            id: messageId,
            choices: [
              {
                finish_reason: null,
                delta: {
                  content: delta.text,
                },
              },
            ],
            object: 'chat.completion.chunk',
            model,
          }
        } else if (
          delta &&
          'reasoningContent' in delta &&
          delta.reasoningContent
        ) {
          const reasoningText =
            'text' in delta.reasoningContent
              ? delta.reasoningContent.text
              : undefined
          if (reasoningText) {
            yield {
              id: messageId,
              choices: [
                {
                  finish_reason: null,
                  delta: {
                    reasoning: reasoningText,
                  },
                },
              ],
              object: 'chat.completion.chunk',
              model,
            }
          }
        } else if (delta && 'toolUse' in delta && delta.toolUse) {
          yield {
            id: messageId,
            choices: [
              {
                finish_reason: null,
                delta: {
                  tool_calls: [
                    {
                      index: blockIndex,
                      function: {
                        arguments: delta.toolUse.input ?? '',
                      },
                    },
                  ],
                },
              },
            ],
            object: 'chat.completion.chunk',
            model,
          }
        }
      } else if (event.contentBlockStart) {
        const start = event.contentBlockStart.start
        const blockIndex = event.contentBlockStart.contentBlockIndex ?? 0

        if (start && 'toolUse' in start && start.toolUse) {
          yield {
            id: messageId,
            choices: [
              {
                finish_reason: null,
                delta: {
                  tool_calls: [
                    {
                      index: blockIndex,
                      id: start.toolUse.toolUseId,
                      type: 'function',
                      function: {
                        name: start.toolUse.name,
                      },
                    },
                  ],
                },
              },
            ],
            object: 'chat.completion.chunk',
            model,
          }
        }
      } else if (event.messageStop) {
        finishReason = BedrockProvider.mapStopReason(
          event.messageStop.stopReason,
        )
      } else if (event.metadata?.usage) {
        usage = BedrockProvider.convertUsage(event.metadata.usage)
      }
    }

    yield {
      id: messageId,
      choices: [
        {
          finish_reason: finishReason,
          delta: {},
        },
      ],
      object: 'chat.completion.chunk',
      model,
      usage,
    }
  }

  async getEmbedding(
    model: string,
    text: string,
    _options?: { dimensions?: number },
  ): Promise<number[]> {
    this.validateConfiguration()

    try {
      const response = await this.client.send(
        new InvokeModelCommand({
          modelId: model,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify(buildBedrockEmbeddingRequestBody(model, text)),
        }),
      )

      const rawBody = await BedrockProvider.bodyToString(response.body)
      const parsed = JSON.parse(rawBody) as Record<string, unknown>
      const vector = BedrockProvider.extractBedrockEmbeddingVector(parsed)

      if (!Array.isArray(vector) || vector.length === 0) {
        throw new Error('Bedrock embedding response did not include values.')
      }

      return vector
    } catch (error) {
      throw BedrockProvider.toBedrockError(this.provider, error, {
        modelId: model,
        action: 'embedding',
      })
    }
  }

  private validateConfiguration(): void {
    const token = this.provider.apiKey?.trim()
    if (!token) {
      throw new LLMAPIKeyNotSetException(
        `Provider ${this.provider.id} API key is not set. Please set the API key in the provider settings.`,
      )
    }

    const region = getBedrockRegion(this.provider)
    if (!region) {
      throw new LLMProviderNotConfiguredException(
        `Provider ${this.provider.id} AWS region is not set. Please set the AWS region in the provider settings.`,
      )
    }
  }

  static extractSystemBlocks(messages: RequestMessage[]): SystemContentBlock[] {
    return messages
      .filter((m) => m.role === 'system')
      .map((m): SystemContentBlock => ({ text: m.content }))
  }

  static convertMessages(messages: RequestMessage[]): Message[] {
    const result: Message[] = []

    for (const msg of messages) {
      switch (msg.role) {
        case 'system':
          break
        case 'user': {
          const contentBlocks = BedrockProvider.convertUserContent(msg.content)
          if (contentBlocks.length > 0) {
            result.push({ role: 'user', content: contentBlocks })
          }
          break
        }
        case 'assistant': {
          const contentBlocks: ContentBlock[] = []

          if (msg.content && msg.content.trim() !== '') {
            contentBlocks.push({ text: msg.content })
          }

          if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              contentBlocks.push({
                toolUse: {
                  toolUseId: tc.id,
                  name: tc.name,
                  input: (getToolCallArgumentsObject(tc.arguments) ??
                    {}) as unknown as BedrockDocumentType,
                },
              })
            }
          }

          if (contentBlocks.length > 0) {
            result.push({ role: 'assistant', content: contentBlocks })
          }
          break
        }
        case 'tool': {
          const toolResultContent: ToolResultContentBlock[] = []

          try {
            const parsed = JSON.parse(msg.content)
            toolResultContent.push({ json: parsed })
          } catch {
            toolResultContent.push({ text: msg.content })
          }

          result.push({
            role: 'user',
            content: [
              {
                toolResult: {
                  toolUseId: msg.tool_call.id,
                  content: toolResultContent,
                  status: 'success',
                },
              },
            ],
          })
          break
        }
      }
    }

    return result
  }

  private static convertUserContent(
    content: string | ContentPart[],
  ): ContentBlock[] {
    if (typeof content === 'string') {
      return [{ text: content }]
    }

    return content.map((part): ContentBlock => {
      switch (part.type) {
        case 'text':
          return { text: part.text }
        case 'image_url': {
          const { mimeType, base64Data } = parseImageDataUrl(part.image_url.url)
          const format = BedrockProvider.toBedrockImageFormat(mimeType)
          const bytes = Uint8Array.from(atob(base64Data), (c) =>
            c.charCodeAt(0),
          )
          return {
            image: {
              format,
              source: { bytes },
            },
          }
        }
      }
    })
  }

  private static toBedrockImageFormat(mimeType: string): ImageFormat {
    const map: Record<string, ImageFormat> = {
      'image/jpeg': 'jpeg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
    }
    const format = map[mimeType]
    if (!format) {
      throw new Error(
        `Unsupported image type ${mimeType}. Bedrock supports: jpeg, png, gif, webp`,
      )
    }
    return format
  }

  private static buildToolConfig(
    tools?: RequestTool[],
    toolChoice?: RequestToolChoice,
  ): { tools: Tool[]; toolChoice?: ToolChoice } | undefined {
    if (!tools || tools.length === 0) return undefined

    const bedrockTools: Tool[] = tools.map(
      (t): Tool => ({
        toolSpec: {
          name: t.function.name,
          description: t.function.description,
          inputSchema: {
            json: t.function.parameters as unknown as BedrockDocumentType,
          },
        },
      }),
    )

    let bedrockToolChoice: ToolChoice | undefined
    if (toolChoice) {
      if (toolChoice === 'auto') {
        bedrockToolChoice = { auto: {} }
      } else if (toolChoice === 'required') {
        bedrockToolChoice = { any: {} }
      } else if (toolChoice === 'none') {
        return undefined
      } else if (
        typeof toolChoice === 'object' &&
        toolChoice.type === 'function'
      ) {
        bedrockToolChoice = { tool: { name: toolChoice.function.name } }
      }
    }

    return {
      tools: bedrockTools,
      ...(bedrockToolChoice ? { toolChoice: bedrockToolChoice } : {}),
    }
  }

  private static resolveThinkingBudgetTokens(
    model: ChatModel,
    request: LLMRequestNonStreaming | LLMRequestStreaming,
  ): number | null {
    const level = resolveRequestReasoningLevel(model, request.reasoningLevel)
    if (
      model.reasoningType !== 'anthropic' ||
      level === undefined ||
      level === 'off'
    ) {
      return null
    }
    if (level === 'auto') {
      return REASONING_META.medium.budget
    }
    return REASONING_META[level].budget
  }

  private static buildAdditionalModelRequestFields(
    model: ChatModel,
    request: LLMRequestNonStreaming | LLMRequestStreaming,
  ): BedrockDocumentType | undefined {
    const budget = BedrockProvider.resolveThinkingBudgetTokens(model, request)
    if (budget === null) {
      return undefined
    }
    return {
      thinking: {
        type: 'enabled',
        budget_tokens: budget,
      },
    }
  }

  private static convertUsage(usage?: TokenUsage): ResponseUsage {
    return {
      prompt_tokens: usage?.inputTokens ?? 0,
      completion_tokens: usage?.outputTokens ?? 0,
      total_tokens: usage?.totalTokens ?? 0,
    }
  }

  private static mapStopReason(reason?: string): string {
    switch (reason) {
      case 'end_turn':
        return 'stop'
      case 'tool_use':
        return 'tool_calls'
      case 'max_tokens':
      case 'model_context_window_exceeded':
        return 'length'
      case 'stop_sequence':
        return 'stop'
      case 'guardrail_intervened':
      case 'content_filtered':
        return 'content_filter'
      default:
        return reason ?? 'stop'
    }
  }

  private static extractBedrockEmbeddingVector(
    payload: Record<string, unknown>,
  ): number[] {
    if (Array.isArray(payload.embedding)) {
      return payload.embedding as number[]
    }

    if (Array.isArray(payload.embeddings) && payload.embeddings.length > 0) {
      const first = payload.embeddings[0]
      if (Array.isArray(first)) {
        return first as number[]
      }
      if (
        first &&
        typeof first === 'object' &&
        Array.isArray((first as { embedding?: number[] }).embedding)
      ) {
        return (first as { embedding: number[] }).embedding
      }
    }

    throw new Error('Embedding model returned an invalid result')
  }

  private static async bodyToString(body: BedrockJsonBody): Promise<string> {
    if (typeof body === 'string') {
      return body
    }

    if (body instanceof Uint8Array) {
      return new TextDecoder().decode(body)
    }

    if (body && typeof body.transformToString === 'function') {
      return body.transformToString()
    }

    throw new Error('Bedrock returned a response body in an unknown format.')
  }

  private static toBedrockError(
    provider: Pick<LLMProvider, 'id'>,
    error: unknown,
    context?: { modelId?: string; action?: 'chat' | 'embedding' },
  ): Error {
    if (!(error instanceof Error)) {
      return new Error(
        `Amazon Bedrock request failed for provider ${provider.id}.`,
      )
    }

    const metadata = error as Error & {
      $metadata?: { httpStatusCode?: number }
      name?: string
    }
    const statusCode = metadata.$metadata?.httpStatusCode
    const action = context?.action ?? 'chat'
    const modelId = context?.modelId
    const messageSuffix = modelId ? ` (model: ${modelId})` : ''

    if (statusCode === 403) {
      return new LLMAPIKeyInvalidException(
        `Amazon Bedrock authentication failed for provider ${provider.id}${messageSuffix}. Please verify the API key / bearer token and its permissions.`,
        error,
      )
    }

    if (statusCode === 404) {
      return new LLMModelNotFoundException(
        `Amazon Bedrock could not find the requested ${action} model for provider ${provider.id}${messageSuffix}.`,
        error,
      )
    }

    if (statusCode === 429) {
      return new LLMRateLimitExceededException(
        `Amazon Bedrock rate limit exceeded for provider ${provider.id}${messageSuffix}. Please try again later.`,
        error,
      )
    }

    if (statusCode === 503 || metadata.name === 'ServiceUnavailableException') {
      return new Error(
        `Amazon Bedrock is temporarily unavailable for provider ${provider.id}${messageSuffix}. Please retry shortly.`,
      )
    }

    if (
      metadata.name === 'ValidationException' &&
      action === 'embedding' &&
      modelId
    ) {
      return new Error(
        `Amazon Bedrock rejected the embedding request for model ${modelId}. Make sure the model supports text embeddings and is compatible with Bedrock InvokeModel.`,
      )
    }

    if (
      /model not found|could not resolve the foundation model|unknown model/i.test(
        error.message,
      )
    ) {
      return new LLMModelNotFoundException(
        `Amazon Bedrock could not find the requested model for provider ${provider.id}${messageSuffix}.`,
        error,
      )
    }

    return new Error(
      `Amazon Bedrock ${action} request failed for provider ${provider.id}${messageSuffix}: ${error.message}`,
    )
  }
}
