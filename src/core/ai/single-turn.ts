import { ChatModel } from '../../types/chat-model.types'
import { LLMRequestBase, RequestTool } from '../../types/llm/request'
import {
  Annotation,
  LLMResponseStreaming,
  ProviderMetadata,
  ResponseUsage,
} from '../../types/llm/response'
import { LLMProvider } from '../../types/provider.types'
import {
  type ToolCallArguments,
  getToolCallArgumentsObject,
} from '../../types/tool-call.types'
import {
  createToolCallArguments,
} from '../../utils/chat/tool-arguments'
import { BaseLLMProvider } from '../llm/base'
import { isLocalFsWriteToolName } from '../mcp/localFileTools'
import {
  ToolCallAccumulator,
  createCanonicalToolEventsFromDeltas,
} from './toolCallAccumulator'

export type SingleTurnExecutionResult = {
  content: string
  reasoning?: string
  annotations?: Annotation[]
  usage?: ResponseUsage
  finishReason?: string | null
  providerMetadata?: ProviderMetadata
  toolCalls: {
    id?: string
    name: string
    arguments?: ToolCallArguments
    metadata?: {
      thoughtSignature?: string
    }
  }[]
}

type StreamedToolCall = {
  index: number
  id?: string
  type?: 'function'
  metadata?: {
    thoughtSignature?: string
  }
  function?: {
    name?: string
    arguments?: ToolCallArguments
  }
}

type SingleTurnExecutionInput = {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  request: LLMRequestBase
  tools?: RequestTool[]
  signal?: AbortSignal
  stream?: boolean
  firstTokenTimeoutMs?: number
  geminiTools?: {
    useWebSearch?: boolean
    useUrlContext?: boolean
  }
  onStreamDelta?: (delta: {
    contentDelta: string
    reasoningDelta: string
    chunk: LLMResponseStreaming
    toolCalls?: StreamedToolCall[]
  }) => void
}

const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 12000

const normalizeToolName = (toolName: string): string => {
  if (!toolName.includes('__')) {
    return toolName
  }
  const parts = toolName.split('__')
  return parts[parts.length - 1] ?? toolName
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const isStringField = (args: Record<string, unknown>, key: string): boolean => {
  return typeof args[key] === 'string'
}

const isNonEmptyStringField = (
  args: Record<string, unknown>,
  key: string,
): boolean => {
  const value = args[key]
  return typeof value === 'string' && value.length > 0
}

const isOptionalBooleanField = (
  args: Record<string, unknown>,
  key: string,
): boolean => {
  const value = args[key]
  return value === undefined || typeof value === 'boolean'
}

const isPositiveIntegerField = (
  args: Record<string, unknown>,
  key: string,
): boolean => {
  const value = args[key]
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

const isValidFsEditOperation = (value: unknown): boolean => {
  if (!isObjectRecord(value)) {
    return false
  }
  const operationType = value.type
  if (operationType === 'replace') {
    return (
      isNonEmptyStringField(value, 'oldText') && isStringField(value, 'newText')
    )
  }
  if (operationType === 'insert_after') {
    return (
      isNonEmptyStringField(value, 'anchor') && isStringField(value, 'content')
    )
  }
  if (operationType === 'replace_lines') {
    return (
      isPositiveIntegerField(value, 'startLine') &&
      isPositiveIntegerField(value, 'endLine') &&
      isStringField(value, 'newText')
    )
  }
  if (operationType === 'append') {
    return isStringField(value, 'content')
  }
  return false
}

const isValidWriteToolArguments = ({
  toolName,
  args,
}: {
  toolName: string
  args: Record<string, unknown>
}): boolean => {
  const normalizedToolName = normalizeToolName(toolName)

  if (normalizedToolName === 'fs_edit') {
    if (!isStringField(args, 'path')) {
      return false
    }
    return isValidFsEditOperation(args.operation)
  }

  if (normalizedToolName === 'fs_create_file') {
    return (
      isStringField(args, 'path') &&
      isStringField(args, 'content') &&
      isOptionalBooleanField(args, 'dryRun')
    )
  }

  if (normalizedToolName === 'fs_delete_file') {
    return isStringField(args, 'path') && isOptionalBooleanField(args, 'dryRun')
  }

  if (normalizedToolName === 'fs_create_dir') {
    return isStringField(args, 'path') && isOptionalBooleanField(args, 'dryRun')
  }

  if (normalizedToolName === 'fs_delete_dir') {
    return (
      isStringField(args, 'path') &&
      isOptionalBooleanField(args, 'recursive') &&
      isOptionalBooleanField(args, 'dryRun')
    )
  }

  if (normalizedToolName === 'fs_move') {
    return (
      isStringField(args, 'oldPath') &&
      isStringField(args, 'newPath') &&
      isOptionalBooleanField(args, 'dryRun')
    )
  }

  return true
}

const hasInvalidWriteToolArguments = (
  toolCalls: SingleTurnExecutionResult['toolCalls'],
): boolean => {
  return toolCalls.some((toolCall) => {
    if (!isLocalFsWriteToolName(toolCall.name)) {
      return false
    }
    const parsed = getToolCallArgumentsObject(toolCall.arguments)
    if (!parsed) {
      return true
    }
    return !isValidWriteToolArguments({
      toolName: toolCall.name,
      args: parsed,
    })
  })
}

const logStreamingRecoverTriggered = ({
  reason,
  finishReason,
  toolCalls,
  error,
}: {
  reason: 'invalid_write_args' | 'stream_protocol_error'
  finishReason?: string | null
  toolCalls?: SingleTurnExecutionResult['toolCalls']
  error?: string
}): void => {
  console.warn('[YOLO] Streaming tool-call recovery triggered.', {
    reason,
    finishReason: finishReason ?? null,
    toolNames: (toolCalls ?? []).map((toolCall) => toolCall.name),
    error,
  })
}

export async function executeSingleTurn({
  providerClient,
  model,
  request,
  tools,
  signal,
  stream = true,
  firstTokenTimeoutMs = DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
  geminiTools,
  onStreamDelta,
}: SingleTurnExecutionInput): Promise<SingleTurnExecutionResult> {
  const runNonStreaming = async (): Promise<SingleTurnExecutionResult> => {
    const response = await providerClient.generateResponse(
      model,
      {
        ...request,
        tools,
        tool_choice: tools ? 'auto' : undefined,
        stream: false,
      },
      {
        signal,
        geminiTools,
      },
    )

    return {
      content: response.choices?.[0]?.message?.content ?? '',
      reasoning: response.choices?.[0]?.message?.reasoning ?? undefined,
      annotations: response.choices?.[0]?.message?.annotations,
      usage: response.usage,
      finishReason: response.choices?.[0]?.finish_reason,
      providerMetadata: response.choices?.[0]?.message?.providerMetadata,
      toolCalls:
        response.choices?.[0]?.message?.tool_calls
          ?.map((toolCall) => {
            const name = toolCall.function?.name?.trim()
            if (!name) {
              return null
            }
            return {
              id: toolCall.id,
              name,
              arguments: createToolCallArguments(toolCall.function?.arguments),
              metadata: toolCall.metadata,
            }
          })
          .filter((toolCall): toolCall is NonNullable<typeof toolCall> =>
            Boolean(toolCall),
          ) ?? [],
    }
  }

  if (!stream) {
    return runNonStreaming()
  }

  const streamController = new AbortController()
  const handleAbort = () => streamController.abort()
  signal?.addEventListener('abort', handleAbort, { once: true })

  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let timedOut = false
  let hasReceivedFirstChunk = false
  let content = ''
  let reasoning = ''
  let annotations: Annotation[] | undefined
  let usage: ResponseUsage | undefined
  let finishReason: string | null = null
  let providerMetadata: ProviderMetadata | undefined
  const turnKey = `single-turn:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const toolCallAccumulator = new ToolCallAccumulator(turnKey)

  const clearTimeoutId = () => {
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
  }

  try {
    timeoutId = setTimeout(() => {
      timedOut = true
      streamController.abort()
    }, firstTokenTimeoutMs)

    const streamIterator = await providerClient.streamResponse(
      model,
      {
        ...request,
        tools,
        tool_choice: tools ? 'auto' : undefined,
        stream: true,
      },
      {
        signal: streamController.signal,
        geminiTools,
      },
    )

    for await (const chunk of streamIterator) {
      if (!hasReceivedFirstChunk) {
        hasReceivedFirstChunk = true
        clearTimeoutId()
      }
      if (signal?.aborted) {
        break
      }

      const delta = chunk?.choices?.[0]?.delta
      const contentDelta = delta?.content ?? ''
      const reasoningDelta = delta?.reasoning ?? ''
      const chunkFinishReason = chunk?.choices?.[0]?.finish_reason
      if (chunkFinishReason) {
        finishReason = chunkFinishReason
      }
      const chunkToolCalls = delta?.tool_calls

      if (contentDelta) {
        content += contentDelta
      }
      if (reasoningDelta) {
        reasoning += reasoningDelta
      }
      if (chunk.usage) {
        usage = chunk.usage
      }
      if (delta?.providerMetadata) {
        providerMetadata = mergeProviderMetadata(
          providerMetadata,
          delta.providerMetadata,
        )
      }
      if (delta?.annotations) {
        annotations = mergeAnnotations(annotations, delta.annotations)
      }
      if (chunkToolCalls) {
        toolCallAccumulator.applyAll(
          createCanonicalToolEventsFromDeltas({
            turnKey,
            provider: 'openai-chat',
            deltas: chunkToolCalls,
            receivedAt: Date.now(),
          }),
        )
      }
      if (
        chunkFinishReason === 'tool_calls' ||
        chunkFinishReason === 'function_call'
      ) {
        const receivedAt = Date.now()
        toolCallAccumulator.sealOpenCalls('turn_handoff', receivedAt)
        toolCallAccumulator.handoff('tool_calls_finish', receivedAt)
      }

      const streamedToolCallList = toolCallAccumulator.getSnapshots()

      onStreamDelta?.({
        contentDelta,
        reasoningDelta,
        chunk,
        toolCalls:
          streamedToolCallList.length > 0
            ? streamedToolCallList.sort((a, b) => a.index - b.index)
            : undefined,
      })
    }

    const streamEndedAt = Date.now()
    toolCallAccumulator.sealOpenCalls('stream_end', streamEndedAt)
    toolCallAccumulator.handoff('stream_end', streamEndedAt)

    const streamedToolCallList = toolCallAccumulator
      .getSnapshots()
      .map((toolCall) => {
        const name = toolCall.function?.name?.trim()
        if (!name) {
          return null
        }
        return {
          id: toolCall.id,
          name,
          arguments:
            toolCall.function?.arguments?.kind === 'complete'
              ? toolCall.function.arguments
              : undefined,
          metadata: toolCall.metadata,
        }
      })
      .filter((toolCall): toolCall is NonNullable<typeof toolCall> =>
        Boolean(toolCall),
      )

    let finalToolCalls: SingleTurnExecutionResult['toolCalls'] =
      streamedToolCallList
    let finalFinishReason: SingleTurnExecutionResult['finishReason'] =
      finishReason ?? undefined
    let finalProviderMetadata: ProviderMetadata | undefined = providerMetadata

    if (hasInvalidWriteToolArguments(streamedToolCallList)) {
      logStreamingRecoverTriggered({
        reason: 'invalid_write_args',
        finishReason,
        toolCalls: streamedToolCallList,
      })
      try {
        const nonStreamingResult = await runNonStreaming()
        if (nonStreamingResult.toolCalls.length > 0) {
          finalToolCalls = nonStreamingResult.toolCalls
          finalFinishReason = nonStreamingResult.finishReason
          finalProviderMetadata =
            nonStreamingResult.providerMetadata ?? finalProviderMetadata
        }
      } catch {
        // Preserve invalid tool calls so they can surface as explicit errors
        // instead of silently disappearing from the conversation.
      }
    }

    return {
      content,
      reasoning: reasoning || undefined,
      annotations,
      usage,
      finishReason: finalFinishReason,
      providerMetadata: finalProviderMetadata,
      toolCalls: finalToolCalls,
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error ?? 'Unknown error')
    const shouldFallback =
      (timedOut && !(signal?.aborted ?? false)) ||
      /protocol error|unexpected EOF|incomplete envelope/i.test(message)
    if (!shouldFallback) {
      throw error
    }
    logStreamingRecoverTriggered({
      reason: 'stream_protocol_error',
      finishReason,
      error: message,
    })
    return runNonStreaming()
  } finally {
    clearTimeoutId()
    signal?.removeEventListener('abort', handleAbort)
  }
}

function mergeProviderMetadata(
  prev: ProviderMetadata | undefined,
  next: ProviderMetadata,
): ProviderMetadata {
  return {
    gemini:
      prev?.gemini || next.gemini
        ? {
            parts: [
              ...(prev?.gemini?.parts ?? []),
              ...(next.gemini?.parts ?? []),
            ],
          }
        : undefined,
  }
}

function mergeAnnotations(
  prevAnnotations: Annotation[] | undefined,
  nextAnnotations: Annotation[],
): Annotation[] {
  if (!prevAnnotations || prevAnnotations.length === 0) {
    return [...nextAnnotations]
  }

  const merged = [...prevAnnotations]
  for (const incoming of nextAnnotations) {
    const hasSameUrl = merged.some(
      (item) => item.url_citation.url === incoming.url_citation.url,
    )
    if (!hasSameUrl) {
      merged.push(incoming)
    }
  }

  return merged
}
