import {
  BedrockRuntimeClient,
  ContentBlock,
  ConverseCommand,
  ConverseStreamCommand,
  ConverseStreamOutput,
  ImageFormat,
  Message,
  SystemContentBlock,
  Tool,
  ToolChoice,
  ToolResultContentBlock,
  TokenUsage,
} from '@aws-sdk/client-bedrock-runtime'
import { DocumentType } from '@smithy/types'

import { ChatModel } from '../../types/chat-model.types'
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
import { parseImageDataUrl } from '../../utils/llm/image'

import { BaseLLMProvider } from './base'
import { LLMAPIKeyNotSetException } from './exception'

type BedrockAdditionalSettings = {
  awsRegion?: string
}

export class BedrockProvider extends BaseLLMProvider<LLMProvider> {
  private client: BedrockRuntimeClient

  private static readonly DEFAULT_MAX_TOKENS = 8192

  constructor(provider: LLMProvider) {
    super(provider)

    const additionalSettings =
      (provider.additionalSettings as BedrockAdditionalSettings) ?? {}

    const region = additionalSettings.awsRegion || 'us-east-1'

    this.client = new BedrockRuntimeClient({
      region,
      token: { token: provider.apiKey ?? '' },
      authSchemePreference: ['httpBearerAuth'],
    })
  }

  async generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    this.validateCredentials()

    const systemBlocks = BedrockProvider.extractSystemBlocks(request.messages)
    const messages = BedrockProvider.convertMessages(request.messages)
    const maxTokens =
      request.max_tokens ??
      (model.thinking?.enabled &&
      typeof model.thinking.budget_tokens === 'number'
        ? model.thinking.budget_tokens + BedrockProvider.DEFAULT_MAX_TOKENS
        : BedrockProvider.DEFAULT_MAX_TOKENS)

    const toolConfig = BedrockProvider.buildToolConfig(
      request.tools,
      request.tool_choice,
    )

    const additionalModelRequestFields =
      BedrockProvider.buildAdditionalModelRequestFields(model)

    const command = new ConverseCommand({
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
      ...(additionalModelRequestFields ? { additionalModelRequestFields } : {}),
    })

    const response = await this.client.send(command, {
      abortSignal: options?.signal,
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
  }

  async streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    this.validateCredentials()

    const systemBlocks = BedrockProvider.extractSystemBlocks(request.messages)
    const messages = BedrockProvider.convertMessages(request.messages)
    const maxTokens =
      request.max_tokens ??
      (model.thinking?.enabled &&
      typeof model.thinking.budget_tokens === 'number'
        ? model.thinking.budget_tokens + BedrockProvider.DEFAULT_MAX_TOKENS
        : BedrockProvider.DEFAULT_MAX_TOKENS)

    const toolConfig = BedrockProvider.buildToolConfig(
      request.tools,
      request.tool_choice,
    )

    const additionalModelRequestFields =
      BedrockProvider.buildAdditionalModelRequestFields(model)

    const command = new ConverseStreamCommand({
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
      ...(additionalModelRequestFields ? { additionalModelRequestFields } : {}),
    })

    const response = await this.client.send(command, {
      abortSignal: options?.signal,
    })

    if (!response.stream) {
      throw new Error('Bedrock ConverseStream returned no stream')
    }

    return this.streamResponseGenerator(response.stream, request.model)
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
      } else if (event.metadata) {
        if (event.metadata.usage) {
          usage = BedrockProvider.convertUsage(event.metadata.usage)
        }
      }
    }

    // Yield final usage chunk
    yield {
      id: messageId,
      choices: [],
      object: 'chat.completion.chunk',
      model,
      usage,
    }
  }

  getEmbedding(_model: string, _text: string): Promise<number[]> {
    return Promise.reject(
      new Error(
        `Provider ${this.provider.id} does not support embeddings via the Converse API. Please use a different provider.`,
      ),
    )
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private validateCredentials(): void {
    if (!this.provider.apiKey) {
      throw new LLMAPIKeyNotSetException(
        `Provider ${this.provider.id} API key is not set. Please set the API key in the provider settings.`,
      )
    }
  }

  /**
   * Extract system messages into Bedrock SystemContentBlock[].
   */
  static extractSystemBlocks(messages: RequestMessage[]): SystemContentBlock[] {
    return messages
      .filter((m) => m.role === 'system')
      .map((m): SystemContentBlock => ({ text: m.content as string }))
  }

  /**
   * Convert the unified RequestMessage[] into Bedrock Message[].
   * System messages are excluded (handled separately).
   */
  static convertMessages(messages: RequestMessage[]): Message[] {
    const result: Message[] = []

    for (const msg of messages) {
      switch (msg.role) {
        case 'system':
          // Handled separately
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
                    {}) as DocumentType,
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

          // Try to parse as JSON first, fall back to text
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

  /**
   * Convert user message content (string or ContentPart[]) to Bedrock ContentBlock[].
   */
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

  /**
   * Build Bedrock ToolConfiguration from request tools/choice.
   */
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
            json: t.function.parameters as DocumentType,
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
        // Bedrock doesn't have a "none" tool choice -- omit toolConfig entirely
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

  /**
   * Build additionalModelRequestFields for model-specific features
   * like Claude extended thinking.
   */
  private static buildAdditionalModelRequestFields(
    model: ChatModel,
  ): DocumentType | undefined {
    const fields: { [prop: string]: DocumentType } = {}

    // Claude extended thinking support via Bedrock
    if (
      model.thinking?.enabled &&
      typeof model.thinking.budget_tokens === 'number'
    ) {
      fields.thinking = {
        type: 'enabled',
        budget_tokens: model.thinking.budget_tokens,
      }
    }

    return Object.keys(fields).length > 0 ? fields : undefined
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
        return 'length'
      case 'stop_sequence':
        return 'stop'
      default:
        return reason ?? 'stop'
    }
  }
}
