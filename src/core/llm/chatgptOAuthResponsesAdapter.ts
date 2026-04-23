import type {
  ComputerTool,
  EasyInputMessage,
  FileSearchTool,
  FunctionTool,
  Response,
  ResponseCreateParams,
  ResponseInput,
  ResponseInputContent,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseOutputText,
  ResponseStreamEvent,
  ResponseTextAnnotationDeltaEvent,
  WebSearchTool,
} from 'openai/resources/responses/responses'

import {
  LLMRequestNonStreaming,
  LLMRequestStreaming,
  RequestMessage,
  RequestTool,
  RequestToolChoice,
} from '../../types/llm/request'
import {
  Annotation,
  LLMResponseNonStreaming,
  LLMResponseStreaming,
  ResponseUsage,
  ToolCall,
  ToolCallDelta,
} from '../../types/llm/response'
import { getToolCallArgumentsText } from '../../types/tool-call.types'

type ChatGPTOAuthRequest = ResponseCreateParams & Record<string, unknown>

type StreamState = {
  toolIndexByItemId: Map<string, number>
  sawToolCall: boolean
  reasoningSummaryIndices: Map<string, Set<number>>
}

type ReasoningSummaryPartAddedEvent = {
  type: 'response.reasoning_summary_part.added'
  item_id: string
  summary_index: number
}

type ReasoningSummaryTextDeltaEvent = {
  type: 'response.reasoning_summary_text.delta'
  delta: string
  item_id: string
  summary_index: number
}

type ResponsesHostedTool = WebSearchTool | FileSearchTool | ComputerTool

type ResponsesTool = FunctionTool | ResponsesHostedTool

type RawResponsesHostedTool =
  | { type: 'web_search' }
  | ({
      type: 'web_search_preview' | 'web_search_preview_2025_03_11'
    } & Partial<WebSearchTool>)
  | ({ type: 'file_search' } & Partial<FileSearchTool>)
  | ({ type: 'computer-preview' } & Partial<ComputerTool>)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isFunctionRequestTool = (value: unknown): value is RequestTool => {
  if (!isRecord(value) || value.type !== 'function') {
    return false
  }

  const fn = value.function
  return isRecord(fn) && typeof fn.name === 'string' && isRecord(fn.parameters)
}

const toHostedTool = (tool: RawResponsesHostedTool): ResponsesHostedTool => {
  if (tool.type === 'web_search') {
    return {
      type: 'web_search_preview',
    }
  }

  return tool as ResponsesHostedTool
}

const toInputContent = (
  message: Extract<RequestMessage, { role: 'user' }>,
): string | ResponseInputContent[] => {
  if (!Array.isArray(message.content)) {
    return message.content
  }

  return message.content.map((part) => {
    if (part.type === 'text') {
      return {
        type: 'input_text',
        text: part.text,
      }
    }

    return {
      type: 'input_image',
      image_url: part.image_url.url,
      detail: 'auto',
    }
  })
}

const toAssistantMessage = (
  message: Extract<RequestMessage, { role: 'assistant' }>,
): EasyInputMessage | null => {
  if (!message.content) {
    return null
  }

  return {
    role: 'assistant',
    content: message.content,
    type: 'message',
  }
}

const toFunctionCallItems = (
  message: Extract<RequestMessage, { role: 'assistant' }>,
) => {
  return (message.tool_calls ?? []).map((toolCall) => ({
    type: 'function_call' as const,
    call_id: toolCall.id,
    name: toolCall.name,
    arguments: getToolCallArgumentsText(toolCall.arguments) ?? '{}',
  }))
}

const toInputItems = (messages: RequestMessage[]): ResponseInput => {
  return messages.flatMap<ResponseInputItem>((message) => {
    switch (message.role) {
      case 'system':
        return {
          role: 'system',
          content: message.content,
          type: 'message',
        }
      case 'user':
        return {
          role: 'user',
          content: toInputContent(message),
          type: 'message',
        }
      case 'assistant': {
        const assistantMessage = toAssistantMessage(message)
        const toolCalls = toFunctionCallItems(message)
        return [...(assistantMessage ? [assistantMessage] : []), ...toolCalls]
      }
      case 'tool':
        return {
          type: 'function_call_output',
          call_id: message.tool_call.id,
          output: message.content,
        }
      default:
        throw new Error('Unsupported request message role')
    }
  })
}

const toInstructions = (messages: RequestMessage[]): string => {
  return messages
    .filter(
      (message): message is Extract<RequestMessage, { role: 'system' }> =>
        message.role === 'system',
    )
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join('\n\n')
}

const toTools = (
  tools?: unknown,
): ResponseCreateParams['tools'] | undefined => {
  if (!Array.isArray(tools)) {
    return undefined
  }

  if (tools.length === 0) {
    return undefined
  }

  const mappedTools: ResponsesTool[] = []

  for (const tool of tools) {
    if (isFunctionRequestTool(tool)) {
      mappedTools.push({
        type: 'function',
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        strict: false,
      })
      continue
    }

    if (isRecord(tool) && typeof tool.type === 'string') {
      switch (tool.type) {
        case 'web_search':
        case 'web_search_preview':
        case 'web_search_preview_2025_03_11':
        case 'file_search':
        case 'computer-preview':
          mappedTools.push(toHostedTool(tool as RawResponsesHostedTool))
          continue
      }
    }
  }

  return mappedTools.length > 0 ? mappedTools : undefined
}

const toToolChoice = (
  toolChoice?: RequestToolChoice,
): ChatGPTOAuthRequest['tool_choice'] => {
  if (!toolChoice) {
    return undefined
  }

  if (typeof toolChoice === 'string') {
    return toolChoice
  }

  return {
    type: 'function',
    name: toolChoice.function.name,
  }
}

const toUsage = (
  usage:
    | {
        input_tokens: number
        output_tokens: number
        total_tokens: number
      }
    | null
    | undefined,
): ResponseUsage | undefined => {
  if (!usage) {
    return undefined
  }

  // Responses API exposes cache hits on `input_tokens_details.cached_tokens`.
  // Type is narrowed above for the fields we require; the cache field is an
  // optional extension, so we reach through at runtime.
  const cached = (
    usage as unknown as {
      input_tokens_details?: { cached_tokens?: number | null } | null
    }
  ).input_tokens_details?.cached_tokens

  const result: ResponseUsage = {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
  }
  if (cached !== undefined && cached !== null && cached > 0) {
    result.cache_read_input_tokens = cached
  }
  return result
}

const toAnnotation = (
  annotation:
    | ResponseOutputText['annotations'][number]
    | ResponseTextAnnotationDeltaEvent['annotation'],
): Annotation | null => {
  if (annotation.type !== 'url_citation') {
    return null
  }

  return {
    type: 'url_citation',
    url_citation: {
      url: annotation.url,
      title: annotation.title,
      start_index: annotation.start_index,
      end_index: annotation.end_index,
    },
  }
}

const toToolCall = (
  item: Extract<ResponseOutputItem, { type: 'function_call' }>,
): ToolCall => ({
  id: item.call_id,
  type: 'function',
  function: {
    name: item.name,
    arguments: item.arguments,
  },
})

const getFinishReason = (
  response: Response,
  sawToolCall: boolean,
): string | null => {
  if (sawToolCall) {
    return 'tool_calls'
  }
  if (response.status === 'incomplete') {
    return 'length'
  }
  return 'stop'
}

export class ChatGPTOAuthResponsesAdapter {
  buildRequest(
    request: LLMRequestNonStreaming | LLMRequestStreaming,
  ): ChatGPTOAuthRequest {
    const instructions = toInstructions(request.messages)
    const body: ChatGPTOAuthRequest = {
      model: request.model,
      instructions: instructions || 'You are a helpful assistant.',
      input: toInputItems(
        request.messages.filter((message) => message.role !== 'system'),
      ),
      tools: toTools(request.tools),
      tool_choice: toToolChoice(request.tool_choice),
      max_output_tokens: request.max_tokens,
      temperature: request.temperature,
      top_p: request.top_p,
      parallel_tool_calls: true,
      stream: request.stream === true,
      store: false,
    }

    const requestRecord = request as Record<string, unknown>
    const reasoning =
      request.reasoning && typeof request.reasoning === 'object'
        ? { ...request.reasoning }
        : {}

    if (request.reasoning_effort) {
      reasoning.effort = request.reasoning_effort
      reasoning.summary = 'auto'
    }

    if (Object.keys(reasoning).length > 0) {
      body.reasoning = reasoning
    }

    if (reasoning.effort) {
      body.include = [
        'reasoning.encrypted_content',
      ] as unknown as ResponseCreateParams['include']
    }

    for (const [key, value] of Object.entries(requestRecord)) {
      if (
        value === undefined ||
        key === 'messages' ||
        key === 'tools' ||
        key === 'tool_choice' ||
        key === 'max_tokens' ||
        key === 'reasoning_effort' ||
        key === 'reasoningLevel' ||
        key === 'stream'
      ) {
        continue
      }

      if (key in body) {
        continue
      }

      body[key] = value
    }

    return body
  }

  parseResponse(response: Response): LLMResponseNonStreaming {
    const messages = response.output.filter(
      (item): item is Extract<ResponseOutputItem, { type: 'message' }> =>
        item.type === 'message',
    )
    const toolCalls = response.output
      .filter(
        (
          item,
        ): item is Extract<ResponseOutputItem, { type: 'function_call' }> =>
          item.type === 'function_call',
      )
      .map(toToolCall)
    const reasoningText = response.output
      .filter(
        (item): item is Extract<ResponseOutputItem, { type: 'reasoning' }> =>
          item.type === 'reasoning',
      )
      .flatMap((item) => item.summary.map((summary) => summary.text))
      .join('\n')
    const contentParts = messages.flatMap((message) => message.content)
    const text = contentParts
      .map((part) => {
        if (part.type === 'output_text') {
          return part.text
        }
        if (part.type === 'refusal') {
          return part.refusal
        }
        return ''
      })
      .join('')
    const annotations = contentParts
      .flatMap((part) => {
        if (part.type !== 'output_text') {
          return []
        }
        return part.annotations
      })
      .map(toAnnotation)
      .filter((annotation): annotation is Annotation => Boolean(annotation))

    return {
      id: response.id,
      created: response.created_at,
      model: response.model,
      object: 'chat.completion',
      choices: [
        {
          finish_reason: getFinishReason(response, toolCalls.length > 0),
          message: {
            role: 'assistant',
            content: text || null,
            ...(reasoningText ? { reasoning: reasoningText } : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            ...(annotations.length > 0 ? { annotations } : {}),
          },
        },
      ],
      usage: toUsage(response.usage),
    }
  }

  *parseStreamEvent(
    event: ResponseStreamEvent,
    state: StreamState,
  ): Generator<LLMResponseStreaming> {
    const reasoningPart = this.getReasoningSummaryPartAdded(event)
    if (reasoningPart) {
      const indices =
        state.reasoningSummaryIndices.get(reasoningPart.itemId) ??
        new Set<number>()
      const isNewPart = !indices.has(reasoningPart.summaryIndex)
      indices.add(reasoningPart.summaryIndex)
      state.reasoningSummaryIndices.set(reasoningPart.itemId, indices)

      if (isNewPart && reasoningPart.summaryIndex > 0) {
        yield this.createChunk(reasoningPart.itemId, {
          reasoning: '\n\n',
        })
      }
      return
    }

    const reasoningDelta = this.getReasoningSummaryTextDelta(event)
    if (reasoningDelta) {
      yield this.createChunk(reasoningDelta.itemId, {
        reasoning: reasoningDelta.delta,
      })
      return
    }

    switch (event.type) {
      case 'response.output_text.delta': {
        yield this.createChunk(event.item_id, {
          content: event.delta,
        })
        return
      }
      case 'response.refusal.delta': {
        yield this.createChunk(event.item_id, {
          content: event.delta,
        })
        return
      }
      case 'response.output_text.annotation.added': {
        const annotation = toAnnotation(event.annotation)
        if (!annotation) {
          return
        }
        yield this.createChunk(event.item_id, {
          annotations: [annotation],
        })
        return
      }
      case 'response.output_item.added': {
        if (event.item.type !== 'function_call') {
          return
        }

        const toolIndex = state.toolIndexByItemId.size
        const itemId = event.item.id ?? event.item.call_id
        state.toolIndexByItemId.set(itemId, toolIndex)
        state.sawToolCall = true
        yield this.createChunk(itemId, {
          tool_calls: [
            {
              index: toolIndex,
              id: event.item.call_id,
              type: 'function',
              function: {
                name: event.item.name,
                arguments: '',
              },
            },
          ],
        })
        return
      }
      case 'response.function_call_arguments.delta': {
        const toolIndex = state.toolIndexByItemId.get(event.item_id)
        if (toolIndex === undefined) {
          return
        }
        yield this.createChunk(event.item_id, {
          tool_calls: [
            {
              index: toolIndex,
              function: {
                arguments: event.delta,
              },
            },
          ],
        })
        return
      }
      case 'response.output_item.done': {
        if (event.item.type === 'reasoning') {
          const reasoning = event.item.summary
            .map((summary) => summary.text)
            .join('\n')
          if (reasoning) {
            yield this.createChunk(event.item.id, { reasoning })
          }
          return
        }

        if (event.item.type === 'function_call') {
          const itemId = event.item.id ?? event.item.call_id
          if (!state.toolIndexByItemId.has(itemId)) {
            const toolIndex = state.toolIndexByItemId.size
            state.toolIndexByItemId.set(itemId, toolIndex)
            state.sawToolCall = true
            yield this.createChunk(itemId, {
              tool_calls: [
                {
                  index: toolIndex,
                  id: event.item.call_id,
                  type: 'function',
                  function: {
                    name: event.item.name,
                    arguments: event.item.arguments,
                  },
                },
              ],
            })
          }
          return
        }

        return
      }
      case 'response.completed': {
        yield {
          id: event.response.id,
          created: event.response.created_at,
          model: event.response.model,
          object: 'chat.completion.chunk',
          choices: [
            {
              finish_reason: getFinishReason(event.response, state.sawToolCall),
              delta: {},
            },
          ],
          usage: toUsage(event.response.usage),
        }
        return
      }
      case 'response.incomplete': {
        yield {
          id: event.response.id,
          created: event.response.created_at,
          model: event.response.model,
          object: 'chat.completion.chunk',
          choices: [
            {
              finish_reason: 'length',
              delta: {},
            },
          ],
          usage: toUsage(event.response.usage),
        }
        return
      }
      case 'response.failed': {
        throw new Error(
          event.response.error?.message ?? 'ChatGPT OAuth response failed',
        )
      }
      case 'error': {
        throw new Error(event.message)
      }
      default:
        return
    }
  }

  createStreamState(): StreamState {
    return {
      toolIndexByItemId: new Map(),
      sawToolCall: false,
      reasoningSummaryIndices: new Map(),
    }
  }

  private createChunk(
    id: string,
    delta: {
      content?: string
      reasoning?: string
      annotations?: Annotation[]
      tool_calls?: ToolCallDelta[]
    },
  ): LLMResponseStreaming {
    return {
      id,
      model: 'chatgpt-oauth',
      object: 'chat.completion.chunk',
      choices: [
        {
          finish_reason: null,
          delta,
        },
      ],
    }
  }

  private getReasoningSummaryTextDelta(
    event: ResponseStreamEvent,
  ): { itemId: string; delta: string } | null {
    const value = event as unknown as Partial<ReasoningSummaryTextDeltaEvent>
    if (
      value.type === 'response.reasoning_summary_text.delta' &&
      typeof value.item_id === 'string' &&
      typeof value.delta === 'string'
    ) {
      return {
        itemId: value.item_id,
        delta: value.delta,
      }
    }

    return null
  }

  private getReasoningSummaryPartAdded(
    event: ResponseStreamEvent,
  ): { itemId: string; summaryIndex: number } | null {
    const value = event as unknown as Partial<ReasoningSummaryPartAddedEvent>
    if (
      value.type === 'response.reasoning_summary_part.added' &&
      typeof value.item_id === 'string' &&
      typeof value.summary_index === 'number'
    ) {
      return {
        itemId: value.item_id,
        summaryIndex: value.summary_index,
      }
    }

    return null
  }
}
