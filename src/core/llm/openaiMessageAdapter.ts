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
} from '../../types/llm/response'

function hasObjectProperty<T extends object, K extends PropertyKey>(
  value: T,
  key: K,
): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key)
}

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
  return undefined
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
    const parsedMessages = request.messages.map((m) =>
      this.parseRequestMessage(m),
    )

    // Ensure assistant.tool_calls only reference tool messages that actually exist.
    try {
      const toolIds = new Set(
        parsedMessages
          .filter((m) => m.role === 'tool')
          .map((m: any) => m.tool_call_id),
      )

      for (const pm of parsedMessages) {
        if (pm.role === 'assistant' && Array.isArray((pm as any).tool_calls)) {
          const filtered = (pm as any).tool_calls.filter((tc: any) =>
            toolIds.has(tc.id),
          )
          if (filtered.length > 0) {
            ;(pm as any).tool_calls = filtered
          } else {
            delete (pm as any).tool_calls
          }
        }
      }

      const toolMessages = parsedMessages.filter(
        (m) => m.role === 'tool',
      ) as any[]
      const preview = parsedMessages.map((m, i) => {
        if (m.role === 'tool') {
          return {
            index: i,
            role: m.role,
            tool_call_id: (m as any).tool_call_id,
            contentLength:
              typeof m.content === 'string' ? m.content.length : 'N/A',
            contentPreview:
              typeof m.content === 'string'
                ? m.content.substring(0, 200)
                : null,
          }
        }
        return { index: i, role: m.role }
      })
      console.debug('[DEBUG] Outgoing parsedMessages preview:', {
        totalMessagesCount: parsedMessages.length,
        toolMessagesCount: toolMessages.length,
        preview,
      })
    } catch (e) {
      console.debug('[DEBUG] Failed to stringify parsedMessages for preview', e)
    }

    if (stream) {
      const params: ChatCompletionCreateParamsStreaming &
        Record<string, unknown> = {
        model: request.model,
        tools: request.tools,
        tool_choice: request.tool_choice,
        reasoning_effort: request.reasoning_effort,
        web_search_options: request.web_search_options,
        messages: parsedMessages,
        max_tokens: request.max_tokens,
        temperature: request.temperature,
        top_p: request.top_p,
        frequency_penalty: request.frequency_penalty,
        presence_penalty: request.presence_penalty,
        logit_bias: request.logit_bias,
        prediction: request.prediction,
        stream: true,
        stream_options: {
          include_usage: true,
        },
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
      messages: parsedMessages,
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
              arguments: toolCall.arguments ?? '{}',
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
        const result = {
          role: 'tool' as const,
          content: message.content,
          tool_call_id: message.tool_call.id,
        }
        console.debug('[DEBUG] parseRequestMessage for tool:', {
          tool_call_id: message.tool_call.id,
          contentLength: message.content.length,
          contentPreview: message.content.substring(0, 200),
        })
        return result
      }
    }
  }

  protected parseNonStreamingResponse(
    response: ChatCompletion,
  ): LLMResponseNonStreaming {
    return {
      id: response.id,
      choices: response.choices.map((choice) => ({
        finish_reason: choice.finish_reason,
        message: {
          content: choice.message.content,
          reasoning: extractReasoningContent(choice.message),
          role: choice.message.role,
          tool_calls: choice.message.tool_calls,
        },
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
        finish_reason: choice.finish_reason ?? null,
        delta: {
          content: choice.delta.content ?? null,
          reasoning: extractReasoningContent(choice.delta),
          role: choice.delta.role,
          tool_calls: choice.delta.tool_calls,
        },
      })),
      created: chunk.created,
      model: chunk.model,
      object: 'chat.completion.chunk',
      system_fingerprint: chunk.system_fingerprint,
      usage: chunk.usage ?? undefined,
    }
  }
}
