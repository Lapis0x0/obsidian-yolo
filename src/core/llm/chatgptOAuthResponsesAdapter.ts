import type {
  EasyInputMessage,
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
} from 'openai/resources/responses/responses'

import {
  LLMRequest,
  LLMRequestNonStreaming,
  LLMRequestStreaming,
  RequestMessage,
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

const toTools = (tools?: LLMRequest['tools']): FunctionTool[] | undefined => {
  if (!tools || tools.length === 0) {
    return undefined
  }

  return tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: false,
  }))
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

  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
  }
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
  buildRequest(request: LLMRequestNonStreaming): ChatGPTOAuthRequest
  buildRequest(request: LLMRequestStreaming): ChatGPTOAuthRequest
  buildRequest(request: LLMRequest): ChatGPTOAuthRequest {
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
    }

    if (Object.keys(reasoning).length > 0) {
      body.reasoning = reasoning
    }

    for (const [key, value] of Object.entries(requestRecord)) {
      if (
        value === undefined ||
        key === 'messages' ||
        key === 'tools' ||
        key === 'tool_choice' ||
        key === 'max_tokens' ||
        key === 'reasoning_effort' ||
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
}
