import { ChatModel } from '../../types/chat-model.types'
import { LLMRequestBase, RequestTool } from '../../types/llm/request'
import {
  Annotation,
  LLMResponseStreaming,
  ResponseUsage,
  ToolCallDelta,
} from '../../types/llm/response'
import { LLMProvider } from '../../types/provider.types'
import {
  extractTopLevelJsonObjects,
  mergeStreamingToolArguments,
  parseJsonObjectText,
} from '../../utils/chat/tool-arguments'
import { BaseLLMProvider } from '../llm/base'
import { isLocalFsWriteToolName } from '../mcp/localFileTools'

export type SingleTurnExecutionResult = {
  content: string
  reasoning?: string
  annotations?: Annotation[]
  usage?: ResponseUsage
  finishReason?: string | null
  toolCalls: {
    id?: string
    name: string
    arguments?: string
    metadata?: {
      thoughtSignature?: string
    }
  }[]
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
    toolCalls?: ToolCallDelta[]
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
    const operations = args.operations
    return (
      Array.isArray(operations) &&
      operations.length > 0 &&
      operations.every((operation) => isValidFsEditOperation(operation))
    )
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

const normalizeToolArguments = (rawArguments?: string): string | undefined => {
  if (!rawArguments) {
    return undefined
  }

  const trimmed = rawArguments.trim()
  if (trimmed.length === 0) {
    return undefined
  }

  const parsed = parseJsonObjectText(trimmed)
  if (parsed) {
    return JSON.stringify(parsed)
  }

  const recoveredObjects = extractTopLevelJsonObjects(trimmed)
  if (recoveredObjects.length > 0) {
    return JSON.stringify(recoveredObjects[recoveredObjects.length - 1])
  }

  return rawArguments
}

const hasInvalidWriteToolArguments = (
  toolCalls: SingleTurnExecutionResult['toolCalls'],
): boolean => {
  return toolCalls.some((toolCall) => {
    if (!isLocalFsWriteToolName(toolCall.name)) {
      return false
    }
    if (!toolCall.arguments) {
      return true
    }
    const parsed = parseJsonObjectText(toolCall.arguments)
    if (!parsed) {
      return true
    }
    return !isValidWriteToolArguments({
      toolName: toolCall.name,
      args: parsed,
    })
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
              arguments: normalizeToolArguments(toolCall.function?.arguments),
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
  let streamedToolCalls: Record<number, ToolCallDelta> = {}

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
      if (delta?.annotations) {
        annotations = mergeAnnotations(annotations, delta.annotations)
      }
      if (chunkToolCalls) {
        streamedToolCalls = mergeToolCallDeltas(
          chunkToolCalls,
          streamedToolCalls,
        )
      }

      const streamedToolCallList = Object.values(streamedToolCalls)

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

    const streamedToolCallList = Object.values(streamedToolCalls)
      .map((toolCall) => {
        const name = toolCall.function?.name?.trim()
        if (!name) {
          return null
        }
        return {
          id: toolCall.id,
          name,
          arguments: normalizeToolArguments(toolCall.function?.arguments),
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

    if (hasInvalidWriteToolArguments(streamedToolCallList)) {
      const streamedNonWriteToolCalls = streamedToolCallList.filter(
        (toolCall) => !isLocalFsWriteToolName(toolCall.name),
      )
      try {
        const nonStreamingResult = await runNonStreaming()
        if (!hasInvalidWriteToolArguments(nonStreamingResult.toolCalls)) {
          finalToolCalls = nonStreamingResult.toolCalls
          finalFinishReason = nonStreamingResult.finishReason
        } else {
          finalToolCalls = streamedNonWriteToolCalls
        }
      } catch {
        // Never execute invalid streamed write tool arguments.
        finalToolCalls = streamedNonWriteToolCalls
      }
    }

    return {
      content,
      reasoning: reasoning || undefined,
      annotations,
      usage,
      finishReason: finalFinishReason,
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
    return runNonStreaming()
  } finally {
    clearTimeoutId()
    signal?.removeEventListener('abort', handleAbort)
  }
}

function mergeToolCallDeltas(
  next: ToolCallDelta[],
  prev: Record<number, ToolCallDelta>,
): Record<number, ToolCallDelta> {
  const merged = { ...prev }
  for (const toolCall of next) {
    const { index } = toolCall
    if (!merged[index]) {
      merged[index] = toolCall
      continue
    }

    const mergedCall: ToolCallDelta = {
      index,
      id: merged[index].id ?? toolCall.id,
      type: merged[index].type ?? toolCall.type,
      metadata: merged[index].metadata ?? toolCall.metadata,
    }

    if (merged[index].function || toolCall.function) {
      const existingArgs = merged[index].function?.arguments
      const newArgs = toolCall.function?.arguments
      mergedCall.function = {
        name: merged[index].function?.name ?? toolCall.function?.name,
        arguments: mergeStreamingToolArguments({ existingArgs, newArgs }),
      }
    }

    merged[index] = mergedCall
  }
  return merged
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
