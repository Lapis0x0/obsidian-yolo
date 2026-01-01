import { v4 as uuidv4 } from 'uuid'

import { BaseLLMProvider } from '../../core/llm/base'
import { McpManager } from '../../core/mcp/mcpManager'
import { ChatMessage, ChatToolMessage } from '../../types/chat'
import { ChatModel } from '../../types/chat-model.types'
import { RequestTool } from '../../types/llm/request'
import {
  Annotation,
  LLMResponseStreaming,
  ToolCallDelta,
} from '../../types/llm/response'
import { LLMProvider } from '../../types/provider.types'
import {
  ToolCallRequest,
  ToolCallResponseStatus,
} from '../../types/tool-call.types'

import { fetchAnnotationTitles } from './fetch-annotation-titles'
import { PromptGenerator } from './promptGenerator'

export type ResponseGeneratorParams = {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  messages: ChatMessage[]
  conversationId: string
  enableTools: boolean
  maxAutoIterations: number
  promptGenerator: PromptGenerator
  mcpManager: McpManager
  abortSignal?: AbortSignal
  firstTokenTimeoutMs?: number
  requestParams?: {
    stream?: boolean
    temperature?: number
    top_p?: number
  }
  maxContextOverride?: number
  geminiTools?: {
    useWebSearch?: boolean
    useUrlContext?: boolean
  }
}

export class ResponseGenerator {
  private readonly providerClient: BaseLLMProvider<LLMProvider>
  private readonly model: ChatModel
  private readonly conversationId: string
  private readonly enableTools: boolean
  private readonly promptGenerator: PromptGenerator
  private readonly mcpManager: McpManager
  private readonly abortSignal?: AbortSignal
  private readonly firstTokenTimeoutMs?: number
  private readonly receivedMessages: ChatMessage[]
  private readonly maxAutoIterations: number
  private readonly requestParams?: {
    stream?: boolean
    temperature?: number
    top_p?: number
  }
  private readonly maxContextOverride?: number
  private readonly geminiTools?: {
    useWebSearch?: boolean
    useUrlContext?: boolean
  }

  private responseMessages: ChatMessage[] = [] // Response messages that are generated after the initial messages
  private subscribers: ((messages: ChatMessage[]) => void)[] = []

  constructor(params: ResponseGeneratorParams) {
    this.providerClient = params.providerClient
    this.model = params.model
    this.conversationId = params.conversationId
    this.enableTools = params.enableTools
    this.maxAutoIterations = Math.max(1, params.maxAutoIterations) // Ensure maxAutoIterations is at least 1
    this.receivedMessages = params.messages
    this.promptGenerator = params.promptGenerator
    this.mcpManager = params.mcpManager
    this.abortSignal = params.abortSignal
    this.firstTokenTimeoutMs = params.firstTokenTimeoutMs
    this.requestParams = params.requestParams
    this.maxContextOverride = params.maxContextOverride
    this.geminiTools = params.geminiTools
  }

  public subscribe(callback: (messages: ChatMessage[]) => void) {
    this.subscribers.push(callback)

    return () => {
      this.subscribers = this.subscribers.filter((cb) => cb !== callback)
    }
  }

  public async run() {
    for (let i = 0; i < this.maxAutoIterations; i++) {
      const { toolCallRequests } = await this.streamSingleResponse()
      if (toolCallRequests.length === 0) {
        return
      }

      const toolMessage: ChatToolMessage = {
        role: 'tool' as const,
        id: uuidv4(),
        toolCalls: toolCallRequests.map((toolCall) => ({
          request: toolCall,
          response: {
            status: this.mcpManager.isToolExecutionAllowed({
              requestToolName: toolCall.name,
              conversationId: this.conversationId,
            })
              ? ToolCallResponseStatus.Running
              : ToolCallResponseStatus.PendingApproval,
          },
        })),
      }

      this.updateResponseMessages((messages) => [...messages, toolMessage])

      await Promise.all(
        toolMessage.toolCalls
          .filter(
            (toolCall) =>
              toolCall.response.status === ToolCallResponseStatus.Running,
          )
          .map(async (toolCall) => {
            const response = await this.mcpManager.callTool({
              name: toolCall.request.name,
              args: toolCall.request.arguments,
              id: toolCall.request.id,
              signal: this.abortSignal,
            })
            this.updateResponseMessages((messages) =>
              messages.map((message) =>
                message.id === toolMessage.id && message.role === 'tool'
                  ? {
                      ...message,
                      toolCalls: message.toolCalls?.map((tc) =>
                        tc.request.id === toolCall.request.id
                          ? {
                              ...tc,
                              response,
                            }
                          : tc,
                      ),
                    }
                  : message,
              ),
            )
          }),
      )

      const updatedToolMessage = this.responseMessages.find(
        (message) => message.id === toolMessage.id && message.role === 'tool',
      ) as ChatToolMessage | undefined
      if (
        !updatedToolMessage?.toolCalls?.every((toolCall) =>
          [
            ToolCallResponseStatus.Success,
            ToolCallResponseStatus.Error,
          ].includes(toolCall.response.status),
        )
      ) {
        // Exit the auto-iteration loop if any tool call hasn't completed
        // Only 'success' or 'error' states are considered complete
        return
      }
    }
  }

  private async streamSingleResponse(): Promise<{
    toolCallRequests: ToolCallRequest[]
  }> {
    const availableTools = this.enableTools
      ? await this.mcpManager.listAvailableTools()
      : []
    const hasTools = availableTools.length > 0

    const requestMessages = await this.promptGenerator.generateRequestMessages({
      messages: [...this.receivedMessages, ...this.responseMessages],
      hasTools,
      maxContextOverride: this.maxContextOverride,
      model: this.model,
    })

    // Set tools to undefined when no tools are available since some providers
    // reject empty tools arrays.
    const tools: RequestTool[] | undefined =
      availableTools.length > 0
        ? availableTools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: {
                ...tool.inputSchema,
                properties: tool.inputSchema.properties ?? {},
              },
            },
          }))
        : undefined

    const shouldStream = this.requestParams?.stream ?? true

    const runNonStreaming = async (): Promise<{
      toolCallRequests: ToolCallRequest[]
    }> => {
      const response = await this.providerClient.generateResponse(
        this.model,
        {
          model: this.model.model,
          messages: requestMessages,
          tools,
          stream: false,
          temperature: this.requestParams?.temperature,
          top_p: this.requestParams?.top_p,
        },
        {
          signal: this.abortSignal,
          geminiTools: this.geminiTools,
        },
      )

      // Ensure assistant message exists and populate content and metadata
      this.responseMessages.push({
        role: 'assistant',
        content: response.choices[0]?.message?.content ?? '',
        id: uuidv4(),
        metadata: {
          model: this.model,
          usage: response.usage,
        },
      })
      const responseMessageId = this.responseMessages.at(-1)!.id

      // Merge annotations (if any)
      const annotations = response.choices[0]?.message?.annotations
      if (annotations) {
        this.updateResponseMessages((messages) =>
          messages.map((message) =>
            message.id === responseMessageId && message.role === 'assistant'
              ? {
                  ...message,
                  annotations,
                }
              : message,
          ),
        )
      }

      // Tool call requests from non-streaming response
      const toolCallRequests = (response.choices[0]?.message?.tool_calls ?? [])
        .map((toolCall): ToolCallRequest | null => {
          if (!toolCall.function?.name) return null
          const base: ToolCallRequest = {
            id: toolCall.id ?? uuidv4(),
            name: toolCall.function.name,
          }
          return toolCall.function.arguments
            ? { ...base, arguments: toolCall.function.arguments }
            : base
        })
        .filter((t): t is ToolCallRequest => t !== null)

      // Update assistant message with toolCallRequests
      this.updateResponseMessages((messages) =>
        messages.map((message) =>
          message.id === responseMessageId && message.role === 'assistant'
            ? {
                ...message,
                toolCallRequests:
                  toolCallRequests.length > 0 ? toolCallRequests : undefined,
              }
            : message,
        ),
      )

      return { toolCallRequests }
    }

    if (!shouldStream) {
      // Non-streaming path
      return runNonStreaming()
    }

    // Streaming path (with fallback on protocol/EOF errors)
    let responseIterable: AsyncIterable<LLMResponseStreaming>
    let streamAbortController: AbortController | null = null
    let abortListener: (() => void) | null = null
    const firstTokenTimeoutMs =
      typeof this.firstTokenTimeoutMs === 'number'
        ? this.firstTokenTimeoutMs
        : null
    const shouldUseFirstTokenTimeout =
      firstTokenTimeoutMs !== null && firstTokenTimeoutMs > 0
    try {
      const signal = shouldUseFirstTokenTimeout
        ? (() => {
            streamAbortController = new AbortController()
            if (this.abortSignal) {
              if (this.abortSignal.aborted) {
                streamAbortController.abort()
              } else {
                const onAbort = () => streamAbortController?.abort()
                this.abortSignal.addEventListener('abort', onAbort, {
                  once: true,
                })
                abortListener = onAbort
              }
            }
            return streamAbortController.signal
          })()
        : this.abortSignal
      responseIterable = await this.providerClient.streamResponse(
        this.model,
        {
          model: this.model.model,
          messages: requestMessages,
          tools,
          stream: true,
          temperature: this.requestParams?.temperature,
          top_p: this.requestParams?.top_p,
        },
        {
          signal,
          geminiTools: this.geminiTools,
        },
      )
    } catch (error) {
      if (abortListener && this.abortSignal) {
        this.abortSignal.removeEventListener('abort', abortListener)
      }
      const msg = String(error?.message ?? '')
      const shouldFallback =
        /protocol error|unexpected EOF|incomplete envelope/i.test(msg)
      if (shouldFallback) {
        return runNonStreaming()
      }
      throw error
    }

    // Create a new assistant message for the response if it doesn't exist
    if (this.responseMessages.at(-1)?.role !== 'assistant') {
      this.responseMessages.push({
        role: 'assistant',
        content: '',
        id: uuidv4(),
        metadata: {
          model: this.model,
        },
      })
    }
    const lastMessage = this.responseMessages.at(-1)
    if (lastMessage?.role !== 'assistant') {
      throw new Error('Last message is not an assistant message')
    }
    const responseMessageId = lastMessage.id
    let responseToolCalls: Record<number, ToolCallDelta> = {}
    const cleanupAbortListener = () => {
      if (abortListener && this.abortSignal) {
        this.abortSignal.removeEventListener('abort', abortListener)
      }
    }
    try {
      if (shouldUseFirstTokenTimeout && streamAbortController) {
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null
        const iterator = responseIterable[Symbol.asyncIterator]()
        const timeoutPromise = new Promise<{ timeout: true }>((resolve) => {
          timeoutHandle = setTimeout(
            () => resolve({ timeout: true }),
            firstTokenTimeoutMs,
          )
        })
        const firstResult = await Promise.race([
          iterator.next(),
          timeoutPromise,
        ])
        if ('timeout' in firstResult) {
          streamAbortController.abort()
          if (timeoutHandle) clearTimeout(timeoutHandle)
          cleanupAbortListener()
          return runNonStreaming()
        }
        if (timeoutHandle) clearTimeout(timeoutHandle)
        if (!firstResult.done) {
          const { updatedToolCalls } = this.processChunk(
            firstResult.value,
            responseMessageId,
            responseToolCalls,
          )
          responseToolCalls = updatedToolCalls
        }
        for await (const chunk of {
          [Symbol.asyncIterator]: () => iterator,
        }) {
          const { updatedToolCalls } = this.processChunk(
            chunk,
            responseMessageId,
            responseToolCalls,
          )
          responseToolCalls = updatedToolCalls
        }
      } else {
        for await (const chunk of responseIterable) {
          const { updatedToolCalls } = this.processChunk(
            chunk,
            responseMessageId,
            responseToolCalls,
          )
          responseToolCalls = updatedToolCalls
        }
      }
    } finally {
      cleanupAbortListener()
    }
    const toolCallRequests: ToolCallRequest[] = Object.values(responseToolCalls)
      .map((toolCall) => {
        // filter out invalid tool calls without a name
        if (!toolCall.function?.name) {
          return null
        }
        return {
          id: toolCall.id ?? uuidv4(),
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        }
      })
      .filter((toolCall) => toolCall !== null)

    this.updateResponseMessages((messages) =>
      messages.map((message) =>
        message.id === responseMessageId && message.role === 'assistant'
          ? {
              ...message,
              toolCallRequests:
                toolCallRequests.length > 0 ? toolCallRequests : undefined,
            }
          : message,
      ),
    )
    return {
      toolCallRequests: toolCallRequests,
    }
  }

  private processChunk(
    chunk: LLMResponseStreaming,
    responseMessageId: string,
    responseToolCalls: Record<number, ToolCallDelta>,
  ): {
    updatedToolCalls: Record<number, ToolCallDelta>
  } {
    const content = chunk.choices[0]?.delta?.content ?? ''
    const reasoning = chunk.choices[0]?.delta?.reasoning
    const toolCalls = chunk.choices[0]?.delta?.tool_calls
    const annotations = chunk.choices[0]?.delta?.annotations

    const updatedToolCalls = toolCalls
      ? this.mergeToolCallDeltas(toolCalls, responseToolCalls)
      : responseToolCalls

    if (annotations) {
      // For annotations with empty titles, fetch the title of the URL and update the chat messages
      fetchAnnotationTitles(annotations, (url, title) => {
        this.updateResponseMessages((messages) =>
          messages.map((message) =>
            message.id === responseMessageId && message.role === 'assistant'
              ? {
                  ...message,
                  annotations: message.annotations?.map((a) =>
                    a.type === 'url_citation' && a.url_citation.url === url
                      ? {
                          ...a,
                          url_citation: {
                            ...a.url_citation,
                            title: title ?? undefined,
                          },
                        }
                      : a,
                  ),
                }
              : message,
          ),
        )
      })
    }

    this.updateResponseMessages((messages) =>
      messages.map((message) =>
        message.id === responseMessageId && message.role === 'assistant'
          ? {
              ...message,
              content: message.content + content,
              reasoning: reasoning
                ? (message.reasoning ?? '') + reasoning
                : message.reasoning,
              annotations: this.mergeAnnotations(
                message.annotations,
                annotations,
              ),
              metadata: {
                ...message.metadata,
                usage: chunk.usage ?? message.metadata?.usage,
              },
            }
          : message,
      ),
    )

    return {
      updatedToolCalls,
    }
  }

  private updateResponseMessages(
    updaterFunction: (messages: ChatMessage[]) => ChatMessage[],
  ) {
    this.responseMessages = updaterFunction(this.responseMessages)
    this.notifySubscribers(this.responseMessages)
  }

  private notifySubscribers(messages: ChatMessage[]) {
    this.subscribers.forEach((callback) => callback(messages))
  }

  private mergeToolCallDeltas(
    toolCalls: ToolCallDelta[],
    existingToolCalls: Record<number, ToolCallDelta>,
  ): Record<number, ToolCallDelta> {
    const merged = { ...existingToolCalls }

    for (const toolCall of toolCalls) {
      const { index } = toolCall

      if (!merged[index]) {
        merged[index] = toolCall
        continue
      }

      const mergedToolCall: ToolCallDelta = {
        index,
        id: merged[index].id ?? toolCall.id,
        type: merged[index].type ?? toolCall.type,
      }

      if (merged[index].function || toolCall.function) {
        const existingArgs = merged[index].function?.arguments
        const newArgs = toolCall.function?.arguments

        mergedToolCall.function = {
          name: merged[index].function?.name ?? toolCall.function?.name,
          arguments:
            existingArgs || newArgs
              ? [existingArgs ?? '', newArgs ?? ''].join('')
              : undefined,
        }
      }

      merged[index] = mergedToolCall
    }

    return merged
  }

  private mergeAnnotations(
    prevAnnotations?: Annotation[],
    newAnnotations?: Annotation[],
  ): Annotation[] | undefined {
    if (!prevAnnotations) return newAnnotations
    if (!newAnnotations) return prevAnnotations

    const mergedAnnotations = [...prevAnnotations]
    for (const newAnnotation of newAnnotations) {
      if (
        !mergedAnnotations.find(
          (annotation) =>
            annotation.url_citation.url === newAnnotation.url_citation.url,
        )
      ) {
        mergedAnnotations.push(newAnnotation)
      }
    }
    return mergedAnnotations
  }
}
