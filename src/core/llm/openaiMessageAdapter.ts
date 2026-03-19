import OpenAI from 'openai'
import {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions'

import {
  LLMOptions,
  LLMRequest,
  LLMRequestNonStreaming,
  LLMRequestStreaming,
  RequestMessage,
} from '../../types/llm/request'
import {
  LLMResponseNonStreaming,
  LLMResponseStreaming,
  ToolCall,
  ToolCallDelta,
} from '../../types/llm/response'
import { getToolCallArgumentsText } from '../../types/tool-call.types'

function hasObjectProperty<T extends object, K extends PropertyKey>(
  value: T,
  key: K,
): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key)
}

const RESERVED_REQUEST_KEYS = new Set([
  'model',
  'tools',
  'tool_choice',
  'reasoning_effort',
  'web_search_options',
  'messages',
  'max_tokens',
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'logit_bias',
  'prediction',
  'stream',
  'stream_options',
  'thinking',
  'thinking_config',
  'thinkingConfig',
  'reasoning',
  'extra_body',
])

function extractReasoningContent(source: unknown): string | undefined {
  if (
    typeof source === 'object' &&
    source !== null &&
    'reasoning_content' in source
  ) {
    const reasoning = (source as { reasoning_content?: unknown })
      .reasoning_content
    if (typeof reasoning === 'string') {
      return reasoning
    }
  }
  if (typeof source === 'object' && source !== null && 'reasoning' in source) {
    const reasoning = (source as { reasoning?: unknown }).reasoning
    if (typeof reasoning === 'string') {
      return reasoning
    }
  }
  if (
    typeof source === 'object' &&
    source !== null &&
    'reasoning_details' in source
  ) {
    const details = (source as { reasoning_details?: unknown })
      .reasoning_details
    if (Array.isArray(details)) {
      const parts = details
        .map((detail) => {
          if (!detail || typeof detail !== 'object') return null
          const record = detail as Record<string, unknown>
          if (
            record.type === 'reasoning.text' &&
            typeof record.text === 'string'
          ) {
            return record.text
          }
          if (
            record.type === 'reasoning.summary' &&
            typeof record.summary === 'string'
          ) {
            return record.summary
          }
          return null
        })
        .filter((part): part is string => Boolean(part))
      if (parts.length > 0) {
        return parts.join('\n')
      }
    }
  }
  return undefined
}

function normalizeFunctionArguments(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }
  if (value === null || value === undefined) {
    return undefined
  }
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function normalizeRequestToolCallArguments(value: unknown): string {
  if (
    value &&
    typeof value === 'object' &&
    'kind' in value &&
    typeof (value as { kind?: unknown }).kind === 'string'
  ) {
    return (
      getToolCallArgumentsText(
        value as Parameters<typeof getToolCallArgumentsText>[0],
      ) ?? '{}'
    )
  }

  const argumentsText = normalizeFunctionArguments(value)
  return argumentsText && argumentsText.trim().length > 0 ? argumentsText : '{}'
}

function normalizeToolCalls(source: unknown): ToolCall[] | undefined {
  if (!Array.isArray(source)) {
    return undefined
  }

  const normalized = source
    .map((entry): ToolCall | null => {
      if (!entry || typeof entry !== 'object') {
        return null
      }

      const record = entry as Record<string, unknown>
      const functionRecord =
        typeof record.function === 'object' && record.function !== null
          ? (record.function as Record<string, unknown>)
          : null

      if (!functionRecord) {
        return null
      }

      const name = functionRecord.name
      if (typeof name !== 'string' || name.trim().length === 0) {
        return null
      }

      const argumentsText = normalizeFunctionArguments(functionRecord.arguments)

      return {
        id: typeof record.id === 'string' ? record.id : undefined,
        type: 'function',
        function: {
          name,
          arguments: argumentsText,
        },
      }
    })
    .filter((entry): entry is ToolCall => entry !== null)

  return normalized.length > 0 ? normalized : undefined
}

function extractLegacyFunctionCall(source: unknown): ToolCall[] | undefined {
  if (!source || typeof source !== 'object' || !('function_call' in source)) {
    return undefined
  }

  const functionCall = (source as { function_call?: unknown }).function_call
  if (!functionCall || typeof functionCall !== 'object') {
    return undefined
  }

  const record = functionCall as Record<string, unknown>
  const name = record.name
  if (typeof name !== 'string' || name.trim().length === 0) {
    return undefined
  }

  const argumentsText = normalizeFunctionArguments(record.arguments)

  return [
    {
      type: 'function',
      function: {
        name,
        arguments: argumentsText,
      },
    },
  ]
}

function normalizeToolCallDeltas(source: unknown): ToolCallDelta[] | undefined {
  if (!Array.isArray(source)) {
    return undefined
  }

  const normalized = source
    .map((entry, fallbackIndex): ToolCallDelta | null => {
      if (!entry || typeof entry !== 'object') {
        return null
      }

      const record = entry as Record<string, unknown>
      const delta: ToolCallDelta = {
        index: typeof record.index === 'number' ? record.index : fallbackIndex,
      }

      if (typeof record.id === 'string') {
        delta.id = record.id
      }
      if (record.type === 'function') {
        delta.type = 'function'
      }

      const functionRecord =
        typeof record.function === 'object' && record.function !== null
          ? (record.function as Record<string, unknown>)
          : null

      if (functionRecord) {
        const name =
          typeof functionRecord.name === 'string'
            ? functionRecord.name
            : undefined
        const argumentsText = normalizeFunctionArguments(
          functionRecord.arguments,
        )
        if (name !== undefined || argumentsText !== undefined) {
          delta.function = {
            name,
            arguments: argumentsText,
          }
        }
      }

      if (!delta.id && !delta.type && !delta.function) {
        return null
      }

      return delta
    })
    .filter((entry): entry is ToolCallDelta => entry !== null)

  return normalized.length > 0 ? normalized : undefined
}

function extractLegacyFunctionCallDelta(
  source: unknown,
): ToolCallDelta[] | undefined {
  if (!source || typeof source !== 'object' || !('function_call' in source)) {
    return undefined
  }

  const functionCall = (source as { function_call?: unknown }).function_call
  if (!functionCall || typeof functionCall !== 'object') {
    return undefined
  }

  const record = functionCall as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name : undefined
  const argumentsText = normalizeFunctionArguments(record.arguments)

  if (!name && argumentsText === undefined) {
    return undefined
  }

  return [
    {
      index: 0,
      type: 'function',
      function: {
        name,
        arguments: argumentsText,
      },
    },
  ]
}

export class OpenAIMessageAdapter {
  async generateResponse(
    client: OpenAI,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    const response = await client.chat.completions.create(
      this.buildChatCompletionCreateParams({
        request,
        stream: false,
      }),
      {
        signal: options?.signal,
      },
    )
    return this.parseNonStreamingResponse(response)
  }

  async streamResponse(
    client: OpenAI,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    const stream = await client.chat.completions.create(
      this.buildChatCompletionCreateParams({
        request,
        stream: true,
      }),
      {
        signal: options?.signal,
      },
    )

    return this.streamResponseGenerator(stream)
  }

  private async *streamResponseGenerator(
    stream: AsyncIterable<ChatCompletionChunk>,
  ): AsyncIterable<LLMResponseStreaming> {
    for await (const chunk of stream) {
      yield this.parseStreamingResponseChunk(chunk)
    }
  }

  protected buildChatCompletionCreateParams(params: {
    request: LLMRequest
    stream: false
  }): ChatCompletionCreateParamsNonStreaming
  protected buildChatCompletionCreateParams(params: {
    request: LLMRequest
    stream: true
  }): ChatCompletionCreateParamsStreaming
  protected buildChatCompletionCreateParams({
    request,
    stream,
  }: {
    request: LLMRequest
    stream: boolean
  }):
    | ChatCompletionCreateParamsStreaming
    | ChatCompletionCreateParamsNonStreaming {
    if (stream) {
      const streamOptions = hasObjectProperty(request, 'stream_options')
        ? ((request as Record<string, unknown>).stream_options as
            | ChatCompletionCreateParamsStreaming['stream_options']
            | undefined)
        : { include_usage: true }

      const params: ChatCompletionCreateParamsStreaming &
        Record<string, unknown> = {
        model: request.model,
        tools: request.tools,
        tool_choice: request.tool_choice,
        reasoning_effort: request.reasoning_effort,
        web_search_options: request.web_search_options,
        messages: request.messages.map((m) => this.parseRequestMessage(m)),
        max_tokens: request.max_tokens,
        temperature: request.temperature,
        top_p: request.top_p,
        frequency_penalty: request.frequency_penalty,
        presence_penalty: request.presence_penalty,
        logit_bias: request.logit_bias,
        prediction: request.prediction,
        stream: true,
        stream_options: streamOptions,
      }
      return this.attachVendorExtensions(params, request)
    }

    const params: ChatCompletionCreateParamsNonStreaming &
      Record<string, unknown> = {
      model: request.model,
      tools: request.tools,
      tool_choice: request.tool_choice,
      reasoning_effort: request.reasoning_effort,
      web_search_options: request.web_search_options,
      messages: request.messages.map((m) => this.parseRequestMessage(m)),
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      top_p: request.top_p,
      frequency_penalty: request.frequency_penalty,
      presence_penalty: request.presence_penalty,
      logit_bias: request.logit_bias,
      prediction: request.prediction,
    }
    return this.attachVendorExtensions(params, request)
  }

  private attachVendorExtensions<T extends Record<string, unknown>>(
    params: T,
    request: LLMRequest,
  ): T {
    const mutable = params as Record<string, unknown>

    if (
      hasObjectProperty(request, 'thinking') &&
      request.thinking &&
      typeof request.thinking === 'object'
    ) {
      mutable.thinking = request.thinking
    }
    const thinkingConfig =
      (hasObjectProperty(request, 'thinking_config') &&
        request.thinking_config &&
        typeof request.thinking_config === 'object' &&
        request.thinking_config) ||
      (hasObjectProperty(request, 'thinkingConfig') &&
        request.thinkingConfig &&
        typeof request.thinkingConfig === 'object' &&
        request.thinkingConfig)
    if (thinkingConfig) {
      mutable.thinking_config = thinkingConfig
    }

    if (
      hasObjectProperty(request, 'reasoning') &&
      request.reasoning &&
      typeof request.reasoning === 'object'
    ) {
      mutable.reasoning = request.reasoning
    }

    if (
      hasObjectProperty(request, 'extra_body') &&
      request.extra_body &&
      typeof request.extra_body === 'object'
    ) {
      const { tools, ...otherExtraBody } = request.extra_body as {
        tools?: ChatCompletionTool[]
        [key: string]: unknown
      }
      if (Array.isArray(tools)) {
        mutable.tools = tools
        if (hasObjectProperty(mutable, 'tool_choice')) {
          delete (mutable as { tool_choice?: unknown }).tool_choice
        }
      }
      if (Object.keys(otherExtraBody).length > 0) {
        mutable.extra_body = otherExtraBody
      }
    }

    const requestRecord = request as Record<string, unknown>
    for (const [key, value] of Object.entries(requestRecord)) {
      if (RESERVED_REQUEST_KEYS.has(key)) {
        continue
      }
      if (value === undefined) {
        continue
      }
      if (Object.prototype.hasOwnProperty.call(mutable, key)) {
        continue
      }
      mutable[key] = value
    }

    return params
  }

  protected parseRequestMessage(
    message: RequestMessage,
  ): ChatCompletionMessageParam {
    switch (message.role) {
      case 'user': {
        const content = Array.isArray(message.content)
          ? message.content.map((part): ChatCompletionContentPart => {
              switch (part.type) {
                case 'text':
                  return { type: 'text', text: part.text }
                case 'image_url':
                  return { type: 'image_url', image_url: part.image_url }
                default:
                  throw new Error('Unsupported content part type.')
              }
            })
          : message.content
        return { role: 'user', content }
      }
      case 'assistant': {
        if (Array.isArray(message.content)) {
          throw new Error('Assistant message should be a string')
        }
        return {
          role: 'assistant',
          content: message.content,
          tool_calls: message.tool_calls?.map((toolCall) => ({
            id: toolCall.id,
            function: {
              arguments: normalizeRequestToolCallArguments(toolCall.arguments),
              name: toolCall.name,
            },
            type: 'function',
          })),
        }
      }
      case 'system': {
        if (Array.isArray(message.content)) {
          throw new Error('System message should be a string')
        }
        return { role: 'system', content: message.content }
      }
      case 'tool': {
        return {
          role: 'tool',
          content: message.content,
          tool_call_id: message.tool_call.id,
        }
      }
    }
  }

  protected parseNonStreamingResponse(
    response: ChatCompletion,
  ): LLMResponseNonStreaming {
    return {
      id: response.id,
      choices: response.choices.map((choice) => ({
        ...(() => {
          const toolCallsFromStandardField = normalizeToolCalls(
            choice.message.tool_calls,
          )
          const toolCallsFromLegacyField = extractLegacyFunctionCall(
            choice.message,
          )
          const normalizedToolCalls =
            toolCallsFromStandardField ?? toolCallsFromLegacyField

          if (!toolCallsFromStandardField && toolCallsFromLegacyField) {
            console.warn(
              '[Smart Composer] Parsed legacy function_call response format (non-stream).',
            )
          }

          return {
            finish_reason: choice.finish_reason,
            message: {
              content: choice.message.content,
              reasoning: extractReasoningContent(choice.message),
              role: choice.message.role,
              tool_calls: normalizedToolCalls,
            },
          }
        })(),
      })),
      created: response.created,
      model: response.model,
      object: 'chat.completion',
      system_fingerprint: response.system_fingerprint,
      usage: response.usage,
    }
  }

  protected parseStreamingResponseChunk(
    chunk: ChatCompletionChunk,
  ): LLMResponseStreaming {
    return {
      id: chunk.id,
      choices: chunk.choices.map((choice) => ({
        ...(() => {
          const toolCallsFromStandardField = normalizeToolCallDeltas(
            choice.delta.tool_calls,
          )
          const toolCallsFromLegacyField = extractLegacyFunctionCallDelta(
            choice.delta,
          )
          const normalizedToolCallDeltas =
            toolCallsFromStandardField ?? toolCallsFromLegacyField

          if (!toolCallsFromStandardField && toolCallsFromLegacyField) {
            console.warn(
              '[Smart Composer] Parsed legacy function_call response format (stream).',
            )
          }

          return {
            finish_reason: choice.finish_reason ?? null,
            delta: {
              content: choice.delta.content ?? null,
              reasoning: extractReasoningContent(choice.delta),
              role: choice.delta.role,
              tool_calls: normalizedToolCallDeltas,
            },
          }
        })(),
      })),
      created: chunk.created,
      model: chunk.model,
      object: 'chat.completion.chunk',
      system_fingerprint: chunk.system_fingerprint,
      usage: chunk.usage ?? undefined,
    }
  }
}
