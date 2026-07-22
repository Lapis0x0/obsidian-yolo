import { DEFAULT_MODEL_REQUEST_TIMEOUT_MS } from '../../settings/schema/setting.types'
import { ChatModel } from '../../types/chat-model.types'
import {
  LLMRequestBase,
  RequestTool,
  RequestToolChoice,
} from '../../types/llm/request'
import {
  Annotation,
  LLMResponseStreaming,
  ProviderMetadata,
  ResponseUsage,
} from '../../types/llm/response'
import { LLMProvider } from '../../types/provider.types'
import {
  type ToolCallArgumentDiagnostics,
  type ToolCallArguments,
  getToolCallArgumentsObject,
} from '../../types/tool-call.types'
import { createToolCallArguments } from '../../utils/chat/tool-arguments'
import { BaseLLMProvider } from '../llm/base'
import {
  bindLLMDebugTraceToSignal,
  runWithLLMDebugTrace,
} from '../llm/debugCapture'
import { applyLightweightRequestPolicy } from '../llm/lightweight-request-policy'
import { ModelRequestTimeoutError } from '../llm/requestPolicy'
import { ResponseDeliveryMode } from '../llm/responseDeliveryMode'
import { isLocalFsWriteToolName } from '../mcp/localFileTools'

import { markRequestErrorNonRetryable } from './requestRetry'
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
      argumentDiagnostics?: ToolCallArgumentDiagnostics
    }
  }[]
}

type StreamedToolCall = {
  index: number
  id?: string
  type?: 'function'
  metadata?: {
    thoughtSignature?: string
    argumentDiagnostics?: ToolCallArgumentDiagnostics
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
  /**
   * Override the tool-choice policy. When omitted, defaults to `'auto'` if
   * `tools` are present (else `undefined`). Compaction passes `'none'` to keep
   * the tools block in the cache-warm prefix while forbidding tool calls.
   */
  tool_choice?: RequestToolChoice
  signal?: AbortSignal
  deliveryMode?: ResponseDeliveryMode
  primaryRequestTimeoutMs?: number
  streamFallbackRecoveryEnabled?: boolean
  geminiTools?: {
    useWebSearch?: boolean
    useUrlContext?: boolean
  }
  debugTraceId?: string
  /**
   * `standard` (default): forward the model as-configured, including any
   * hosted tools, reasoning, and custom-parameter injections.
   * `lightweight`: apply the lightweight request policy for one-shot helper
   * calls (title generation, tab completion, short summaries) that
   * should not inherit hosted tools or heavyweight model customizations.
   */
  purpose?: 'standard' | 'lightweight'
  /**
   * `configured` (default): let the provider adapter translate the model's
   * reasoning configuration.
   * `omit`: send no YOLO-generated reasoning parameters and leave the
   * provider/model on its native default behavior.
   */
  reasoningPolicy?: 'configured' | 'omit'
  onStreamDelta?: (delta: {
    contentDelta: string
    reasoningDelta: string
    chunk: LLMResponseStreaming
    toolCalls?: StreamedToolCall[]
  }) => void
}

const DEFAULT_PRIMARY_REQUEST_TIMEOUT_MS = DEFAULT_MODEL_REQUEST_TIMEOUT_MS
const TOOL_ARGUMENT_RETRY_HINT =
  'The previous streaming response produced empty or placeholder tool-call arguments. Retry with complete, valid JSON tool_call arguments. Keep each tool_call argument object small; prefer narrower file edits or smaller parameter payloads instead of sending huge file contents in one call.'

const normalizeToolName = (toolName: string): string => {
  if (!toolName.includes('__')) {
    return toolName
  }
  const parts = toolName.split('__')
  return parts[parts.length - 1] ?? toolName
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

const isValidFsEditArgs = (args: Record<string, unknown>): boolean => {
  if (!isStringField(args, 'newText')) {
    return false
  }
  const hasOldText = args.oldText !== undefined && args.oldText !== null
  const hasLineRange =
    (args.startLine !== undefined && args.startLine !== null) ||
    (args.endLine !== undefined && args.endLine !== null)

  // Exact-text mode: oldText alone.
  if (hasOldText && !hasLineRange) {
    return isNonEmptyStringField(args, 'oldText')
  }
  // Line-range mode: startLine + endLine alone.
  if (hasLineRange && !hasOldText) {
    return (
      isPositiveIntegerField(args, 'startLine') &&
      isPositiveIntegerField(args, 'endLine')
    )
  }
  // Both groups or neither group is invalid.
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
    return isValidFsEditArgs(args)
  }

  if (normalizedToolName === 'fs_write') {
    return isStringField(args, 'path') && isStringField(args, 'content')
  }

  if (normalizedToolName === 'fs_delete') {
    return (
      isStringField(args, 'path') && isOptionalBooleanField(args, 'recursive')
    )
  }

  if (normalizedToolName === 'fs_create_dir') {
    return isStringField(args, 'path')
  }

  if (normalizedToolName === 'fs_move') {
    return isStringField(args, 'oldPath') && isStringField(args, 'newPath')
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

const hasSuspiciousEmptyToolArguments = (
  toolCalls: SingleTurnExecutionResult['toolCalls'],
): boolean => {
  return toolCalls.some((toolCall) => {
    const args = toolCall.arguments
    if (!args) {
      return true
    }
    if (args.kind === 'partial') {
      return args.rawText.trim().length === 0
    }
    return Object.keys(args.value).length === 0
  })
}

const logStreamingRecoverTriggered = ({
  reason,
  finishReason,
  toolCalls,
  error,
}: {
  reason: 'empty_tool_args' | 'invalid_write_args' | 'stream_protocol_error'
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
  tool_choice,
  signal,
  deliveryMode = 'incremental',
  primaryRequestTimeoutMs = DEFAULT_PRIMARY_REQUEST_TIMEOUT_MS,
  streamFallbackRecoveryEnabled = true,
  geminiTools,
  debugTraceId,
  purpose = 'standard',
  reasoningPolicy = 'configured',
  onStreamDelta,
}: SingleTurnExecutionInput): Promise<SingleTurnExecutionResult> {
  const resolvedToolChoice: RequestToolChoice | undefined =
    tool_choice ?? (tools ? 'auto' : undefined)
  const isLightweight = purpose === 'lightweight'
  const baseProviderOptions = { geminiTools }
  const effectivePolicy = isLightweight
    ? applyLightweightRequestPolicy({
        model,
        options: baseProviderOptions,
      })
    : { model, options: baseProviderOptions }
  const effectiveModel =
    reasoningPolicy === 'omit'
      ? { ...effectivePolicy.model, reasoningType: undefined }
      : effectivePolicy.model
  const effectiveRequest =
    reasoningPolicy === 'omit'
      ? { ...request, reasoningLevel: undefined }
      : request
  const effectiveProviderOptions = effectivePolicy.options
  const executionMode =
    providerClient.resolveResponseExecutionMode(deliveryMode)
  const withDebugTrace = <T>(run: () => Promise<T>): Promise<T> =>
    runWithLLMDebugTrace(debugTraceId, run)
  const createRequestWithSystemHint = (
    systemHint: string | undefined,
  ): LLMRequestBase => {
    if (!systemHint) {
      return effectiveRequest
    }
    const [firstMessage, ...restMessages] = effectiveRequest.messages
    if (firstMessage?.role === 'system') {
      return {
        ...effectiveRequest,
        messages: [
          {
            ...firstMessage,
            content: `${firstMessage.content}\n\n${systemHint}`,
          },
          ...restMessages,
        ],
      }
    }
    return {
      ...effectiveRequest,
      messages: [
        { role: 'system', content: systemHint },
        ...effectiveRequest.messages,
      ],
    }
  }
  const runNonStreaming = async (options?: {
    systemHint?: string
  }): Promise<SingleTurnExecutionResult> => {
    const requestController = new AbortController()
    const handleRequestAbort = () => requestController.abort()
    if (signal?.aborted) {
      requestController.abort()
    } else {
      signal?.addEventListener('abort', handleRequestAbort, { once: true })
    }
    bindLLMDebugTraceToSignal(debugTraceId, requestController.signal)

    try {
      const response = await withDebugTrace(() =>
        providerClient.generateResponse(
          effectiveModel,
          {
            ...createRequestWithSystemHint(options?.systemHint),
            tools,
            tool_choice: resolvedToolChoice,
            stream: false,
          },
          {
            signal: requestController.signal,
            debugTraceId,
            geminiTools: effectiveProviderOptions.geminiTools,
          },
        ),
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
                arguments: createToolCallArguments(
                  toolCall.function?.arguments,
                  { allowPartial: true },
                ),
                metadata: toolCall.metadata,
              }
            })
            .filter((toolCall): toolCall is NonNullable<typeof toolCall> =>
              Boolean(toolCall),
            ) ?? [],
      }
    } finally {
      signal?.removeEventListener('abort', handleRequestAbort)
    }
  }

  if (executionMode === 'non-streaming') {
    return runNonStreaming()
  }

  const isBufferedStreaming = executionMode === 'buffered-streaming'
  const streamController = new AbortController()
  bindLLMDebugTraceToSignal(debugTraceId, streamController.signal)
  let rejectBufferedInterruption: ((error: Error) => void) | undefined
  const bufferedInterruption = new Promise<never>((_, reject) => {
    rejectBufferedInterruption = reject
  })
  const createAbortError = (): Error => {
    const error = new Error('Aborted')
    error.name = 'AbortError'
    return error
  }
  const handleAbort = () => {
    streamController.abort()
    if (isBufferedStreaming) {
      rejectBufferedInterruption?.(createAbortError())
    }
  }
  if (signal?.aborted) {
    handleAbort()
  } else {
    signal?.addEventListener('abort', handleAbort, { once: true })
  }

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
      if (isBufferedStreaming) {
        rejectBufferedInterruption?.(
          new ModelRequestTimeoutError(primaryRequestTimeoutMs),
        )
      }
    }, primaryRequestTimeoutMs)

    const consumeStream = withDebugTrace(async () => {
      const streamIterator = await providerClient.streamResponse(
        effectiveModel,
        {
          ...effectiveRequest,
          tools,
          tool_choice: resolvedToolChoice,
          stream: true,
        },
        {
          signal: streamController.signal,
          debugTraceId,
          geminiTools: effectiveProviderOptions.geminiTools,
        },
      )

      for await (const chunk of streamIterator) {
        if (!hasReceivedFirstChunk) {
          hasReceivedFirstChunk = true
          if (!isBufferedStreaming) {
            clearTimeoutId()
          }
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

        if (!isBufferedStreaming) {
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
      }
    })
    await (isBufferedStreaming
      ? Promise.race([consumeStream, bufferedInterruption])
      : consumeStream)

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
        const shouldAttachDiagnostics =
          Boolean(toolCall.metadata) ||
          toolCall.diagnostics.parseState !== 'valid' ||
          toolCall.diagnostics.rawArgsLength === 0
        return {
          id: toolCall.id,
          name,
          arguments: toolCall.function?.arguments,
          metadata: shouldAttachDiagnostics
            ? {
                ...toolCall.metadata,
                argumentDiagnostics: {
                  ...toolCall.diagnostics,
                  finishReason,
                  timedOut,
                  aborted: signal?.aborted ?? false,
                  deliveryMode,
                },
              }
            : undefined,
        }
      })
      .filter((toolCall): toolCall is NonNullable<typeof toolCall> =>
        Boolean(toolCall),
      )

    const hasInvalidWriteArgs =
      hasInvalidWriteToolArguments(streamedToolCallList)
    const hasEmptyToolArgs =
      hasSuspiciousEmptyToolArguments(streamedToolCallList)

    let finalToolCalls: SingleTurnExecutionResult['toolCalls'] =
      streamedToolCallList
    let finalFinishReason: SingleTurnExecutionResult['finishReason'] =
      finishReason ?? undefined
    let finalProviderMetadata: ProviderMetadata | undefined = providerMetadata

    if (
      !isBufferedStreaming &&
      streamFallbackRecoveryEnabled &&
      (hasInvalidWriteArgs || hasEmptyToolArgs)
    ) {
      const recoveryReason = hasEmptyToolArgs
        ? 'empty_tool_args'
        : 'invalid_write_args'
      logStreamingRecoverTriggered({
        reason: recoveryReason,
        finishReason,
        toolCalls: streamedToolCallList,
      })
      try {
        const nonStreamingResult = await runNonStreaming({
          systemHint: hasEmptyToolArgs ? TOOL_ARGUMENT_RETRY_HINT : undefined,
        })
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

    // Guard against silent failures: if the stream completed without
    // producing any content, reasoning, or tool calls, the response is
    // effectively empty.  This typically indicates a misconfigured base URL
    // (e.g. missing `/v1`) where the proxy returns a valid but contentless
    // SSE stream.  Throw so the agent layer can surface an error message
    // instead of showing the user a blank bubble.
    if (
      !content &&
      !reasoning &&
      finalToolCalls.length === 0 &&
      !finalFinishReason &&
      !signal?.aborted
    ) {
      throw new Error(
        'No content received from the model — verify the API base URL (e.g. the `/v1` suffix) and that the endpoint returns a non-empty SSE stream.',
      )
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
    if (isBufferedStreaming) {
      throw markRequestErrorNonRetryable(error)
    }
    const message =
      error instanceof Error ? error.message : String(error ?? 'Unknown error')
    const shouldFallback =
      (timedOut && !(signal?.aborted ?? false)) ||
      /protocol error|unexpected EOF|incomplete envelope/i.test(message)
    if (!streamFallbackRecoveryEnabled || !shouldFallback) {
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
