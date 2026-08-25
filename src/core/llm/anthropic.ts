import Anthropic from '@anthropic-ai/sdk'
import {
  Tool as AnthropicTool,
  ToolChoice as AnthropicToolChoice,
  Base64ImageSource,
  ContentBlockParam,
  DocumentBlockParam,
  ImageBlockParam,
  MessageCreateParamsNonStreaming,
  MessageCreateParamsStreaming,
  MessageParam,
  MessageStreamEvent,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages'

import { ChatModel } from '../../types/chat-model.types'
import {
  LLMOptions,
  LLMRequestNonStreaming,
  LLMRequestStreaming,
  RequestMessage,
  RequestTool,
  RequestToolChoice,
} from '../../types/llm/request'
import {
  Annotation,
  HostedWebSearchCall,
  LLMResponseNonStreaming,
  LLMResponseStreaming,
  ResponseUsage,
  ToolCall,
} from '../../types/llm/response'
import { LLMProvider, RequestTransportMode } from '../../types/provider.types'
import {
  REASONING_META,
  resolveRequestReasoningLevel,
} from '../../types/reasoning'
import { getToolCallArgumentsObject } from '../../types/tool-call.types'
import { parseImageDataUrl } from '../../utils/llm/image'
import { getBuiltinProviderTools } from '../../utils/llm/model-tools'
import { toProviderHeadersRecord } from '../../utils/llm/provider-headers'

import { applyAnthropicPromptCache } from './anthropicPromptCache'
import { BaseLLMProvider } from './base'
import {
  LLMAPIKeyInvalidException,
  LLMAPIKeyNotSetException,
} from './exception'
import { ModelRequestPolicy, resolveSdkMaxRetries } from './requestPolicy'
import {
  AutoPromotedTransportMode,
  createRequestTransportMemoryKey,
  resolveRequestTransportMode,
  runWithRequestTransport,
  runWithRequestTransportForStream,
} from './requestTransport'
import { createTransportClients } from './transportClients'

/**
 * Reads the `query` out of a hosted search's streamed arguments. The JSON
 * arrives in fragments, so a partial-but-usable query is extracted before the
 * object closes — the card shows what is being searched while it happens.
 */
const parseHostedSearchQuery = (partialJson: string): string | undefined => {
  try {
    const parsed = JSON.parse(partialJson) as { query?: unknown }
    if (typeof parsed.query === 'string') {
      return parsed.query
    }
  } catch {
    // Still mid-stream; fall through to the partial read below.
  }
  const match = /"query"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(partialJson)
  if (!match) {
    return undefined
  }
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return undefined
  }
}

const SUPPORTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]

function validateImageType(mimeType: string) {
  if (!SUPPORTED_IMAGE_TYPES.includes(mimeType)) {
    throw new Error(
      `Anthropic does not support image type ${mimeType}. Supported types: ${SUPPORTED_IMAGE_TYPES.join(
        ', ',
      )}`,
    )
  }
}

/**
 * A `user` request message's content in Anthropic's own shape.
 *
 * Module-level rather than a method because the Claude Agent SDK path
 * (`core/llm/claude-sdk/`) sends the very same blocks to the very same model
 * family through a subprocess instead of HTTP — the translation is a property
 * of Anthropic's wire format, not of this transport.
 */
export function parseUserMessageContent(
  message: Extract<RequestMessage, { role: 'user' }>,
): string | (TextBlockParam | ImageBlockParam | DocumentBlockParam)[] {
  if (!Array.isArray(message.content)) {
    return message.content
  }
  return message.content.map(
    (part): TextBlockParam | ImageBlockParam | DocumentBlockParam => {
      switch (part.type) {
        case 'text':
          return { type: 'text', text: part.text }
        case 'image_url': {
          const { mimeType, base64Data } = parseImageDataUrl(part.image_url.url)
          validateImageType(mimeType)
          return {
            type: 'image',
            source: {
              data: base64Data,
              media_type: mimeType as Base64ImageSource['media_type'],
              type: 'base64',
            },
          }
        }
        case 'document': {
          // Native PDF support via Anthropic's document block. The 'pdf'
          // modality gate upstream guarantees this only reaches models that
          // advertise native PDF support.
          return {
            type: 'document',
            source: {
              type: 'base64',
              media_type: part.mediaType,
              data: part.data,
            },
          }
        }
      }
    },
  )
}

export class AnthropicProvider extends BaseLLMProvider<LLMProvider> {
  private browserClient: Anthropic
  private obsidianClient: Anthropic
  private nodeClient: Anthropic
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

  private isPromptCachingEnabled(): boolean {
    const raw = this.provider.additionalSettings?.promptCaching
    return raw === true
  }

  private static readonly DEFAULT_MAX_TOKENS = 8192

  /**
   * max_tokens must cover thinking tokens too. For bounded levels (low through max)
   * add the budget from REASONING_META on top of DEFAULT_MAX_TOKENS so visible output isn't truncated.
   */
  private static resolveMaxTokens(
    requested: number | undefined,
    level: ReturnType<typeof resolveRequestReasoningLevel>,
  ): number {
    if (typeof requested === 'number') return requested
    if (level && level !== 'off' && level !== 'auto') {
      return AnthropicProvider.DEFAULT_MAX_TOKENS + REASONING_META[level].budget
    }
    return AnthropicProvider.DEFAULT_MAX_TOKENS
  }

  constructor(
    provider: LLMProvider,
    options?: {
      onAutoPromoteTransportMode?: (mode: AutoPromotedTransportMode) => void
      requestPolicy?: ModelRequestPolicy
    },
  ) {
    super(provider)
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
      apiKey: provider.apiKey,
      baseURL: provider.baseUrl
        ? provider.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
        : undefined, // use default
      dangerouslyAllowBrowser: true,
      maxRetries: resolveSdkMaxRetries({
        requestPolicy: options?.requestPolicy,
        requestTransportMode: this.requestTransportMode,
      }),
      timeout: options?.requestPolicy?.timeoutMs,
      ...(defaultHeaders ? { defaultHeaders } : {}),
    }
    const clients = createTransportClients(
      (transportFetch) =>
        new Anthropic({
          ...clientOptions,
          fetch: transportFetch,
        }),
      { providerId: provider.id, protocol: 'passthrough' },
    )
    this.browserClient = clients.browserClient
    this.obsidianClient = clients.obsidianClient
    this.nodeClient = clients.nodeClient
  }

  /**
   * Serializes function tools plus any hosted (server-side) tool the model has
   * enabled. The hosted tool's name is fixed to `web_search` by the protocol,
   * and Anthropic requires globally unique tool names — but our own web search
   * reaches the model fully qualified as `yolo_local__web_search`, so the two
   * coexist and the agent keeps both: the provider-run search and its own
   * configured backend.
   */
  private buildTools(
    model: ChatModel,
    request: LLMRequestNonStreaming | LLMRequestStreaming,
  ): MessageCreateParamsNonStreaming['tools'] {
    const functionTools = request.tools?.map((tool) =>
      AnthropicProvider.parseRequestTool(tool),
    )

    const hasHostedWebSearch = getBuiltinProviderTools(model).some(
      (tool) => tool.type === 'deepseek:web_search',
    )
    if (!hasHostedWebSearch) {
      return functionTools
    }

    // SDK v0.39 predates the server-tool union, so the entry is cast.
    const hostedWebSearch = {
      type: 'web_search_20250305',
      name: 'web_search',
    } as unknown as AnthropicTool

    return [...(functionTools ?? []), hostedWebSearch]
  }

  async generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    if (!this.provider.apiKey) {
      throw new LLMAPIKeyNotSetException(
        `Provider ${this.provider.id} API key is missing. Please set it in settings menu.`,
      )
    }

    const systemMessage = AnthropicProvider.validateSystemMessages(
      request.messages,
    )

    try {
      const level = resolveRequestReasoningLevel(model, request.reasoningLevel)
      const payloadBase: MessageCreateParamsNonStreaming &
        Record<string, unknown> = {
        model: request.model,
        messages: AnthropicProvider.mergeAdjacentUserMessages(
          request.messages
            .map((m) => this.parseRequestMessage(m))
            .filter((m): m is MessageParam => m !== null),
        ),
        system: systemMessage,
        tools: this.buildTools(model, request),
        tool_choice: request.tool_choice
          ? AnthropicProvider.parseRequestToolChoice(request.tool_choice)
          : undefined,
        max_tokens: AnthropicProvider.resolveMaxTokens(
          request.max_tokens,
          level,
        ),
        temperature: request.temperature,
        top_p: request.top_p,
      }

      if (level !== undefined) {
        switch (level) {
          case 'off':
            payloadBase.thinking = { type: 'disabled' }
            break
          case 'auto':
            payloadBase.thinking = {
              type: 'adaptive',
              display: 'summarized',
            } as unknown as MessageCreateParamsNonStreaming['thinking']
            break
          default:
            payloadBase.thinking = {
              type: 'adaptive',
              display: 'summarized',
            } as unknown as MessageCreateParamsNonStreaming['thinking']
            payloadBase.output_config = {
              effort: REASONING_META[level].effort,
            }
        }
      }

      const payload = this.applyCustomModelParameters<
        MessageCreateParamsNonStreaming & Record<string, unknown>
      >(model, {
        ...(this.isPromptCachingEnabled()
          ? applyAnthropicPromptCache(payloadBase)
          : payloadBase),
      })

      const response = await runWithRequestTransport({
        mode: this.requestTransportMode,
        memoryKey: this.requestTransportMemoryKey,
        onAutoPromoteTransportMode: this.promoteTransportMode,
        runBrowser: () =>
          this.browserClient.messages.create(payload, {
            signal: options?.signal,
          }),
        runObsidian: () =>
          this.obsidianClient.messages.create(payload, {
            signal: options?.signal,
          }),
        runNode: () =>
          this.nodeClient.messages.create(payload, {
            signal: options?.signal,
          }),
      })

      return AnthropicProvider.parseNonStreamingResponse(response)
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        // Anthropic's CORS Policy Change (March 2025)
        // Issue: https://github.com/glowingjade/obsidian-smart-composer/issues/286
        //
        // Anthropic recently changed their CORS policy for new individual accounts:
        // - New individual accounts now have CORS restrictions by default
        // - The error occurs even with valid API keys and anthropic-dangerous-direct-browser-access: true
        // - The error message contains "CORS requests are not allowed for this Organization"
        //
        // Solution: Users need to create an organization in their Anthropic account
        if (
          error.message.includes(
            'CORS requests are not allowed for this Organization',
          )
        ) {
          throw new LLMAPIKeyInvalidException(
            `Provider ${this.provider.id} is experiencing a CORS issue. This is a known issue with new individual Anthropic accounts.

To resolve this issue:

1. Go to https://console.anthropic.com/settings/organization
2. Create a new organization
3. Your API key should work properly after creating an organization

For more information, please refer to the following issue:
https://github.com/glowingjade/obsidian-smart-composer/issues/286`,
            error,
          )
        }
        throw new LLMAPIKeyInvalidException(
          `Provider ${this.provider.id} API key is invalid. Please update it in settings menu.`,
          error,
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
    if (!this.provider.apiKey) {
      throw new LLMAPIKeyNotSetException(
        `Provider ${this.provider.id} API key is missing. Please set it in settings menu.`,
      )
    }

    const systemMessage = AnthropicProvider.validateSystemMessages(
      request.messages,
    )

    try {
      const level = resolveRequestReasoningLevel(model, request.reasoningLevel)
      const payloadBase: MessageCreateParamsStreaming &
        Record<string, unknown> = {
        model: request.model,
        messages: AnthropicProvider.mergeAdjacentUserMessages(
          request.messages
            .map((m) => this.parseRequestMessage(m))
            .filter((m): m is MessageParam => m !== null),
        ),
        system: systemMessage,
        tools: this.buildTools(model, request),
        tool_choice: request.tool_choice
          ? AnthropicProvider.parseRequestToolChoice(request.tool_choice)
          : undefined,
        max_tokens: AnthropicProvider.resolveMaxTokens(
          request.max_tokens,
          level,
        ),
        temperature: request.temperature,
        top_p: request.top_p,
        stream: true,
      }

      if (level !== undefined) {
        switch (level) {
          case 'off':
            payloadBase.thinking = { type: 'disabled' }
            break
          case 'auto':
            payloadBase.thinking = {
              type: 'adaptive',
              display: 'summarized',
            } as unknown as MessageCreateParamsStreaming['thinking']
            break
          default:
            payloadBase.thinking = {
              type: 'adaptive',
              display: 'summarized',
            } as unknown as MessageCreateParamsStreaming['thinking']
            payloadBase.output_config = {
              effort: REASONING_META[level].effort,
            }
        }
      }

      const payload = this.applyCustomModelParameters<
        MessageCreateParamsStreaming & Record<string, unknown>
      >(model, {
        ...(this.isPromptCachingEnabled()
          ? applyAnthropicPromptCache(payloadBase)
          : payloadBase),
      })

      const stream = (await runWithRequestTransportForStream({
        mode: this.requestTransportMode,
        memoryKey: this.requestTransportMemoryKey,
        onAutoPromoteTransportMode: this.promoteTransportMode,
        signal: options?.signal,
        createBrowserStream: (signal) =>
          this.browserClient.messages.create(payload, {
            signal: signal ?? options?.signal,
            stream: true,
          }),
        createObsidianStream: (signal) =>
          this.obsidianClient.messages.create(payload, {
            signal: signal ?? options?.signal,
            stream: true,
          }),
        createNodeStream: (signal) =>
          this.nodeClient.messages.create(payload, {
            signal: signal ?? options?.signal,
            stream: true,
          }),
      })) as unknown as AsyncIterable<MessageStreamEvent>

      return this.streamResponseGenerator(stream)
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        // Anthropic's CORS Policy Change (March 2025)
        // Issue: https://github.com/glowingjade/obsidian-smart-composer/issues/286
        //
        // Anthropic recently changed their CORS policy for new individual accounts:
        // - New individual accounts now have CORS restrictions by default
        // - The error occurs even with valid API keys and anthropic-dangerous-direct-browser-access: true
        // - The error message contains "CORS requests are not allowed for this Organization"
        //
        // Solution: Users need to create an organization in their Anthropic account
        if (
          error.message.includes(
            'CORS requests are not allowed for this Organization',
          )
        ) {
          throw new LLMAPIKeyInvalidException(
            `Provider ${this.provider.id} is experiencing a CORS issue. This is a known issue with new individual Anthropic accounts.

To resolve this issue:

1. Go to https://console.anthropic.com/settings/organization
2. Create a new organization
3. Your API key should work properly after creating an organization

For more information, please refer to the following issue:
https://github.com/glowingjade/obsidian-smart-composer/issues/286`,
            error,
          )
        }
        throw new LLMAPIKeyInvalidException(
          `Provider ${this.provider.id} API key is invalid. Please update it in settings menu.`,
          error,
        )
      }

      throw error
    }
  }

  private async *streamResponseGenerator(
    stream: AsyncIterable<MessageStreamEvent>,
  ): AsyncIterable<LLMResponseStreaming> {
    let messageId = ''
    let model = ''
    let usage: ResponseUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    }
    // Hosted tools stream a `server_tool_use` block whose arguments arrive as
    // `input_json_delta` — the same delta type function tool calls use. Those
    // deltas must not reach the tool-call accumulator: the provider already ran
    // the tool, and there is no matching tool call for the agent to execute.
    // They are collected here instead, so the query can be paired with the
    // results that arrive later in a separate `web_search_tool_result` block.
    const serverToolBlockIndices = new Set<number>()
    const hostedSearchByToolUseId = new Map<string, HostedWebSearchCall>()
    const hostedSearchIdByBlockIndex = new Map<number, string>()
    const hostedSearchArgsByBlockIndex = new Map<number, string>()
    const emitHostedSearch = (): LLMResponseStreaming => ({
      id: messageId,
      choices: [
        {
          finish_reason: null,
          delta: {
            providerMetadata: {
              hostedWebSearch: [...hostedSearchByToolUseId.values()],
            },
          },
        },
      ],
      object: 'chat.completion.chunk',
      model,
    })

    for await (const chunk of stream) {
      if (chunk.type === 'message_start') {
        messageId = chunk.message.id
        model = chunk.message.model
        const cacheRead =
          chunk.message.usage.cache_read_input_tokens ?? undefined
        const cacheCreation =
          chunk.message.usage.cache_creation_input_tokens ?? undefined
        const billedInputTokens =
          chunk.message.usage.input_tokens +
          (cacheRead ?? 0) +
          (cacheCreation ?? 0)
        usage = {
          prompt_tokens: billedInputTokens,
          completion_tokens: chunk.message.usage.output_tokens,
          total_tokens: billedInputTokens + chunk.message.usage.output_tokens,
          ...(cacheRead !== undefined
            ? { cache_read_input_tokens: cacheRead }
            : {}),
          ...(cacheCreation !== undefined
            ? { cache_creation_input_tokens: cacheCreation }
            : {}),
        }
      } else if (
        chunk.type === 'content_block_start' ||
        chunk.type === 'content_block_delta'
      ) {
        if (
          chunk.type === 'content_block_start' &&
          chunk.content_block.type === ('server_tool_use' as string)
        ) {
          serverToolBlockIndices.add(chunk.index)
          const block = chunk.content_block as unknown as {
            id?: string
            name?: string
          }
          if (block.name === 'web_search' && block.id) {
            hostedSearchIdByBlockIndex.set(chunk.index, block.id)
            hostedSearchArgsByBlockIndex.set(chunk.index, '')
            hostedSearchByToolUseId.set(block.id, { id: block.id, results: [] })
            yield emitHostedSearch()
          }
          continue
        }
        if (
          chunk.type === 'content_block_delta' &&
          serverToolBlockIndices.has(chunk.index)
        ) {
          const toolUseId = hostedSearchIdByBlockIndex.get(chunk.index)
          if (toolUseId && chunk.delta.type === 'input_json_delta') {
            const args =
              (hostedSearchArgsByBlockIndex.get(chunk.index) ?? '') +
              chunk.delta.partial_json
            hostedSearchArgsByBlockIndex.set(chunk.index, args)
            const query = parseHostedSearchQuery(args)
            const call = hostedSearchByToolUseId.get(toolUseId)
            if (query && call && call.query !== query) {
              hostedSearchByToolUseId.set(toolUseId, { ...call, query })
              yield emitHostedSearch()
            }
          }
          continue
        }
        if (
          chunk.type === 'content_block_start' &&
          chunk.content_block.type === ('web_search_tool_result' as string)
        ) {
          const toolUseId = (
            chunk.content_block as unknown as { tool_use_id?: string }
          ).tool_use_id
          const call = toolUseId
            ? hostedSearchByToolUseId.get(toolUseId)
            : undefined
          if (toolUseId && call) {
            hostedSearchByToolUseId.set(toolUseId, {
              ...call,
              results: AnthropicProvider.parseWebSearchResults(
                chunk.content_block,
              ),
            })
            yield emitHostedSearch()
          }
        }
        const parsedChunk = AnthropicProvider.parseStreamingResponseChunk(
          chunk,
          messageId,
          model,
        )
        if (parsedChunk !== null) {
          yield parsedChunk
        }
      } else if (chunk.type === 'message_delta') {
        // Anthropic streams `message_delta.usage.output_tokens` as the current
        // cumulative output token count, not an incremental delta.
        //
        // Newer Anthropic API revisions (and most third-party proxies) finalize
        // cache accounting in `message_delta.usage` rather than `message_start`,
        // and also re-send `input_tokens` there. SDK v0.39's MessageDeltaUsage
        // type only declares `output_tokens`, so we reach through at runtime.
        const rawUsage = chunk.usage as unknown as {
          input_tokens?: number | null
          output_tokens: number
          cache_read_input_tokens?: number | null
          cache_creation_input_tokens?: number | null
        }
        const cacheRead =
          rawUsage.cache_read_input_tokens ?? usage.cache_read_input_tokens
        const cacheCreation =
          rawUsage.cache_creation_input_tokens ??
          usage.cache_creation_input_tokens
        const freshInputTokens =
          rawUsage.input_tokens ??
          usage.prompt_tokens -
            (usage.cache_read_input_tokens ?? 0) -
            (usage.cache_creation_input_tokens ?? 0)
        const billedInputTokens =
          freshInputTokens + (cacheRead ?? 0) + (cacheCreation ?? 0)
        usage = {
          prompt_tokens: billedInputTokens,
          completion_tokens: rawUsage.output_tokens,
          total_tokens: billedInputTokens + rawUsage.output_tokens,
          ...(cacheRead !== undefined && cacheRead !== null
            ? { cache_read_input_tokens: cacheRead }
            : {}),
          ...(cacheCreation !== undefined && cacheCreation !== null
            ? { cache_creation_input_tokens: cacheCreation }
            : {}),
        }
      }
    }

    // After the stream is complete, yield the final usage
    yield {
      id: messageId,
      choices: [],
      object: 'chat.completion.chunk',
      model: model,
      usage: usage,
    }
  }

  // Anthropic 协议要求 role 严格交替（user / assistant）。当 assistant 一次返回
  // 多个 tool_use 时，下一轮的多条 tool 结果必须打包到同一条 user message 的
  // content[] 里；否则上游会以
  // "`tool_use` ids were found without `tool_result` blocks immediately after"
  // 报 400。这里把映射后相邻的 user 消息合并。
  protected static mergeAdjacentUserMessages(
    messages: MessageParam[],
  ): MessageParam[] {
    const merged: MessageParam[] = []
    for (const message of messages) {
      const prev = merged[merged.length - 1]
      if (prev && prev.role === 'user' && message.role === 'user') {
        const prevContent = Array.isArray(prev.content)
          ? prev.content
          : [{ type: 'text' as const, text: prev.content }]
        const nextContent = Array.isArray(message.content)
          ? message.content
          : [{ type: 'text' as const, text: message.content }]
        merged[merged.length - 1] = {
          role: 'user',
          content: [...prevContent, ...nextContent],
        }
      } else {
        merged.push(message)
      }
    }
    return merged
  }

  protected parseRequestMessage(message: RequestMessage): MessageParam | null {
    switch (message.role) {
      case 'user': {
        return { role: 'user', content: parseUserMessageContent(message) }
      }
      case 'assistant': {
        const anthropicToolCalls = message.tool_calls?.map(
          (toolCall): ContentBlockParam => {
            return {
              type: 'tool_use' as const,
              id: toolCall.id,
              name: toolCall.name,
              input: getToolCallArgumentsObject(toolCall.arguments) ?? {},
            }
          },
        )

        const messageContent = [
          ...(message.content.trim() === ''
            ? []
            : [
                {
                  type: 'text' as const,
                  text: message.content,
                },
              ]),
          ...(anthropicToolCalls ? anthropicToolCalls : []),
        ]

        if (messageContent.length === 0) {
          // No content or tool calls, skip the message
          return null
        }

        return { role: 'assistant', content: messageContent }
      }
      case 'system': {
        // System messages should be extracted and handled separately
        return null
      }
      case 'tool': {
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.tool_call.id,
              content: message.content,
            },
          ],
        }
      }
    }
  }

  /**
   * Converts a hosted-search receipt (`web_search_tool_result`) into the
   * `url_citation` annotations the assistant message already renders as
   * "View Sources". The provider ran the search itself, so this block is the
   * only record of which pages the answer is based on. SDK v0.39 predates the
   * server-tool content blocks, so the shape is read structurally.
   *
   * Returns an empty array for the error variant (`web_search_tool_result` may
   * carry `{type:'web_search_tool_result_error'}` instead of a result list).
   */
  private static parseWebSearchToolResult(block: unknown): Annotation[] {
    return AnthropicProvider.parseWebSearchResults(block).map((result) => ({
      type: 'url_citation',
      url_citation: {
        url: result.url,
        ...(result.title ? { title: result.title } : {}),
      },
    }))
  }

  private static parseWebSearchResults(
    block: unknown,
  ): HostedWebSearchCall['results'] {
    const content = (block as { content?: unknown }).content
    if (!Array.isArray(content)) {
      return []
    }
    return content.flatMap((entry) => {
      const result = entry as { type?: string; url?: string; title?: string }
      if (result.type !== 'web_search_result' || !result.url) {
        return []
      }
      return [
        { url: result.url, ...(result.title ? { title: result.title } : {}) },
      ]
    })
  }

  /**
   * Pairs each `server_tool_use` with the `web_search_tool_result` that carries
   * its `tool_use_id`, producing one receipt per search the provider ran.
   */
  private static parseHostedWebSearchCalls(
    content: readonly unknown[],
  ): HostedWebSearchCall[] {
    const resultsByToolUseId = new Map<string, HostedWebSearchCall['results']>()
    for (const block of content) {
      const typed = block as { type?: string; tool_use_id?: string }
      if (typed.type === 'web_search_tool_result' && typed.tool_use_id) {
        resultsByToolUseId.set(
          typed.tool_use_id,
          AnthropicProvider.parseWebSearchResults(block),
        )
      }
    }

    return content.flatMap((block): HostedWebSearchCall[] => {
      const typed = block as {
        type?: string
        id?: string
        name?: string
        input?: { query?: unknown }
      }
      if (typed.type !== 'server_tool_use' || typed.name !== 'web_search') {
        return []
      }
      const id = typed.id ?? ''
      const query =
        typeof typed.input?.query === 'string' ? typed.input.query : undefined
      return [
        {
          id,
          ...(query ? { query } : {}),
          results: resultsByToolUseId.get(id) ?? [],
        },
      ]
    })
  }

  static parseNonStreamingResponse(
    response: Anthropic.Message,
  ): LLMResponseNonStreaming {
    const textContent = response.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('')

    const reasoningContent =
      response.content
        .filter((c) => c.type === 'thinking')
        .map((c) => c.thinking)
        .join('') || undefined

    const toolCalls: ToolCall[] = response.content
      .filter((c) => c.type === 'tool_use')
      .map((c): ToolCall => {
        return {
          id: c.id,
          type: 'function',
          function: {
            name: c.name,
            arguments: JSON.stringify(c.input),
          },
        }
      })

    const annotations = response.content.flatMap((c) =>
      c.type === ('web_search_tool_result' as string)
        ? AnthropicProvider.parseWebSearchToolResult(c)
        : [],
    )
    const hostedWebSearch = AnthropicProvider.parseHostedWebSearchCalls(
      response.content,
    )

    const cacheRead = response.usage.cache_read_input_tokens ?? undefined
    const cacheCreation =
      response.usage.cache_creation_input_tokens ?? undefined
    const billedInputTokens =
      response.usage.input_tokens + (cacheRead ?? 0) + (cacheCreation ?? 0)

    return {
      id: response.id,
      choices: [
        {
          finish_reason: response.stop_reason,
          message: {
            content: textContent,
            reasoning: reasoningContent,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            ...(annotations.length > 0 ? { annotations } : {}),
            ...(hostedWebSearch.length > 0
              ? { providerMetadata: { hostedWebSearch } }
              : {}),
            role: response.role,
          },
        },
      ],
      model: response.model,
      object: 'chat.completion',
      usage: {
        prompt_tokens: billedInputTokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: billedInputTokens + response.usage.output_tokens,
        ...(cacheRead !== undefined
          ? { cache_read_input_tokens: cacheRead }
          : {}),
        ...(cacheCreation !== undefined
          ? { cache_creation_input_tokens: cacheCreation }
          : {}),
      },
    }
  }

  static parseStreamingResponseChunk(
    chunk: MessageStreamEvent,
    messageId: string,
    model: string,
  ): LLMResponseStreaming | null {
    if (
      chunk.type !== 'content_block_start' &&
      chunk.type !== 'content_block_delta'
    ) {
      throw new Error('Unsupported chunk type')
    }

    if (chunk.type === 'content_block_start') {
      // Hosted-search receipt. It arrives complete in `content_block_start`
      // (no deltas follow), so the annotations are emitted in one chunk.
      if (chunk.content_block.type === ('web_search_tool_result' as string)) {
        const annotations = AnthropicProvider.parseWebSearchToolResult(
          chunk.content_block,
        )
        if (annotations.length === 0) {
          return null
        }
        return {
          id: messageId,
          choices: [
            {
              finish_reason: null,
              delta: { annotations },
            },
          ],
          object: 'chat.completion.chunk',
          model: model,
        }
      }

      if (chunk.content_block.type === 'tool_use') {
        return {
          id: messageId,
          choices: [
            {
              finish_reason: null,
              delta: {
                tool_calls: [
                  {
                    index: chunk.index,
                    id: chunk.content_block.id,
                    type: 'function',
                    function: {
                      name: chunk.content_block.name,
                      // arguments are not provided in the start event
                    },
                  },
                ],
              },
            },
          ],
          object: 'chat.completion.chunk',
          model: model,
        }
      }
    }

    if (chunk.type === 'content_block_delta') {
      if (chunk.delta.type === 'text_delta') {
        return {
          id: messageId,
          choices: [
            {
              finish_reason: null,
              delta: {
                content: chunk.delta.text,
              },
            },
          ],
          object: 'chat.completion.chunk',
          model: model,
        }
      } else if (chunk.delta.type === 'thinking_delta') {
        return {
          id: messageId,
          choices: [
            {
              finish_reason: null,
              delta: {
                reasoning: chunk.delta.thinking,
              },
            },
          ],
          object: 'chat.completion.chunk',
          model: model,
        }
      } else if (chunk.delta.type === 'input_json_delta') {
        return {
          id: messageId,
          choices: [
            {
              finish_reason: null,
              delta: {
                tool_calls: [
                  {
                    index: chunk.index,
                    function: {
                      arguments: chunk.delta.partial_json,
                    },
                  },
                ],
              },
            },
          ],
          object: 'chat.completion.chunk',
          model: model,
        }
      }
    }
    return null
  }

  private static validateSystemMessages(
    messages: RequestMessage[],
  ): string | undefined {
    const systemMessages = messages.filter((m) => m.role === 'system')
    if (systemMessages.length > 1) {
      throw new Error(`Anthropic does not support more than one system message`)
    }
    const systemMessage =
      systemMessages.length > 0 ? systemMessages[0].content : undefined
    if (systemMessage && typeof systemMessage !== 'string') {
      throw new Error(
        `Anthropic only supports string content for system messages`,
      )
    }
    return systemMessage
  }

  private static parseRequestTool(tool: RequestTool): AnthropicTool {
    return {
      name: tool.function.name,
      input_schema: {
        ...tool.function.parameters,
        type: 'object',
      },
      description: tool.function.description,
    }
  }

  private static parseRequestToolChoice(
    toolChoice: RequestToolChoice,
  ): AnthropicToolChoice {
    if (toolChoice === 'none') {
      return {
        type: 'none',
      }
    }
    if (toolChoice === 'auto') {
      return {
        type: 'auto',
      }
    }
    if (toolChoice === 'required') {
      return {
        type: 'any',
      }
    }
    if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
      return {
        type: 'tool',
        name: toolChoice.function.name,
      }
    }
    throw new Error(`Unsupported tool choice: ${JSON.stringify(toolChoice)}`)
  }

  getEmbedding(
    _model: string,
    _text: string,
    _options?: { dimensions?: number },
  ): Promise<number[]> {
    return Promise.reject(
      new Error(
        `Provider ${this.provider.id} does not support embeddings. Please use a different provider.`,
      ),
    )
  }
}
