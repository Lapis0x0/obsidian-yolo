import { v4 as uuidv4 } from 'uuid'

import type { ChatContextPolicy } from '../../components/chat-view/chat-runtime-profiles'
import type {
  AssistantToolPreference,
  AssistantToolServerPreference,
} from '../../types/assistant.types'
import {
  ChatAssistantMessage,
  ChatConversationCompactionLike,
  ChatErrorDetail,
  ChatMessage,
} from '../../types/chat'
import { ChatModel } from '../../types/chat-model.types'
import type {
  NativeToolPolicy,
  RequestMessage,
  RequestTool,
} from '../../types/llm/request'
import type { ProviderExecutedToolCall } from '../../types/llm/response'
import type { ProviderSessionAccessor } from '../../types/provider-session.types'
import { LLMProvider, LLMProviderApiType } from '../../types/provider.types'
import {
  ReasoningLevel,
  resolveRequestReasoningLevel,
} from '../../types/reasoning'
import { ToolCallRequest } from '../../types/tool-call.types'
import type { ContextualInjection } from '../../utils/chat/contextual-injections'
import { ReasoningPhaseTracker } from '../../utils/chat/reasoningPhaseTracker'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { formatErrorMessageWithCauses } from '../../utils/error-message'
import { hasHostedWebSearch } from '../../utils/llm/model-tools'
import { executeSingleTurn } from '../ai/single-turn'
import { BaseLLMProvider } from '../llm/base'
import {
  createLLMDebugTrace,
  isLLMDebugCaptureEnabled,
  registerLLMDebugTraceForTurn,
  updateLLMDebugTrace,
} from '../llm/debugCapture'
import { ProviderRequestError } from '../llm/providerErrors'
import type { ResponseDeliveryMode } from '../llm/responseDeliveryMode'
import {
  LOCAL_FILE_TOOL_SHORT_NAMES,
  getLocalFileToolServerName,
} from '../mcp/localFileTools'
import { McpManager } from '../mcp/mcpManager'

import { CONTEXT_COMPACT_TOOL_NAME } from './compaction'
import {
  type ToolCapabilityMode,
  buildToolCapabilityPrompt,
} from './tool-capability-prompt'
import { selectAllowedTools } from './tool-selection'

type AgentLlmTurnExecutorInput = {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  requestContextBuilder: RequestContextBuilder
  mcpManager: McpManager
  conversationId: string
  messages: ChatMessage[]
  branchId?: string
  sourceUserMessageId?: string
  branchLabel?: string
  resumeAssistantMessage?: ChatAssistantMessage
  compaction?: ChatConversationCompactionLike | null
  enableTools: boolean
  includeBuiltinTools: boolean
  apiType?: LLMProviderApiType | null
  allowedToolNames?: string[]
  enableToolDisclosure?: boolean
  toolPreferences?: Record<string, AssistantToolPreference>
  toolServerPreferences?: Record<string, AssistantToolServerPreference>
  allowedSkillPaths?: string[]
  abortSignal?: AbortSignal
  reasoningLevel?: ReasoningLevel
  requestParams?: {
    deliveryMode?: ResponseDeliveryMode
    temperature?: number
    top_p?: number
    max_tokens?: number
    primaryRequestTimeoutMs?: number
    streamFallbackRecoveryEnabled?: boolean
  }
  contextualInjections?: ContextualInjection[]
  toolCapabilityMode?: ToolCapabilityMode
  modePersonaPrompt?: string
  modePersonaModuleId?: string
  moduleChatModeId?: string
  contextPolicy?: ChatContextPolicy
  transientRequestMessages?: RequestMessage[]
  geminiTools?: {
    useWebSearch?: boolean
    useUrlContext?: boolean
  }
  /**
   * Session handle for providers that run their own native session (see
   * `LLMOptions.session`). Supplied by the caller that owns the conversation
   * record; absent for runs with nothing to persist against.
   */
  session?: ProviderSessionAccessor
  /** See `LLMOptions.nativeToolPolicy`. */
  nativeToolPolicy?: NativeToolPolicy
  systemPromptOverride?: string
  onAssistantMessage: (message: ChatAssistantMessage) => void
  /**
   * A run of tools the provider executed inside its own runtime, at the point
   * in the answer where it happened (see `providerToolRun`). The assistant
   * message is sealed before the call and a new one is opened after it, so the
   * caller only has to place the run between them.
   *
   * Called again as the run's calls complete, with the same run — the caller
   * replaces rather than appends.
   */
  onProviderToolRun?: (calls: ProviderExecutedToolCall[]) => void
}

type AgentLlmTurnExecutorOutput = {
  assistantMessage: ChatAssistantMessage
  toolCallRequests: ToolCallRequest[]
  hasAssistantOutput: boolean
  debugTraceId?: string
  /**
   * The provider-ready prefix actually sent to the model this turn, plus the
   * exact tools block. The compaction bypass reuses these byte-for-byte so its
   * out-of-band summarize request hits the same cache-warm prefix.
   */
  requestMessages: RequestMessage[]
  requestTools: RequestTool[] | undefined
  /**
   * The resolved reasoning level actually applied this turn. Replayed by the
   * compaction bypass so its request carries the same thinking config — without
   * it, Anthropic's cache key (which includes thinking config) would mismatch
   * and the cache-warm prefix would not hit.
   */
  requestReasoning: ReasoningLevel | undefined
}

export class AgentLlmTurnExecutor {
  private static readonly LOCAL_TOOL_NAMES = new Set([
    ...LOCAL_FILE_TOOL_SHORT_NAMES,
    CONTEXT_COMPACT_TOOL_NAME,
  ])

  constructor(private readonly input: AgentLlmTurnExecutorInput) {}

  async run(): Promise<AgentLlmTurnExecutorOutput> {
    const responseStart = Date.now()
    const reasoningTracker = new ReasoningPhaseTracker(responseStart)
    const model = this.input.model
    const deliveryMode = this.input.requestParams?.deliveryMode ?? 'incremental'
    const executionMode =
      this.input.providerClient.resolveResponseExecutionMode(deliveryMode)
    const assistantMessageId = this.input.resumeAssistantMessage?.id ?? uuidv4()
    const debugTrace = isLLMDebugCaptureEnabled()
      ? createLLMDebugTrace({
          assistantMessageId,
          model,
          requestKind:
            executionMode === 'non-streaming' ? 'non-streaming' : 'streaming',
        })
      : null
    if (debugTrace && this.input.sourceUserMessageId) {
      registerLLMDebugTraceForTurn({
        conversationId: this.input.conversationId,
        sourceUserMessageId: this.input.sourceUserMessageId,
        traceId: debugTrace.id,
      })
    }
    const resumedMessage = this.input.resumeAssistantMessage
    // Streaming deltas replace this reference with a new object (immutable
    // update) rather than mutating in place, so a message's identity changes
    // exactly when its content changes. Downstream state layers rely on this
    // to skip unchanged messages by reference instead of deep-comparing them.
    let assistantMessage: ChatAssistantMessage = {
      ...(resumedMessage ?? {
        role: 'assistant' as const,
        id: assistantMessageId,
        content: '',
      }),
      toolCallRequests: undefined,
      metadata: {
        ...resumedMessage?.metadata,
        model,
        usage: undefined,
        durationMs: undefined,
        generationState: 'streaming',
        errorMessage: undefined,
        llmDebugTraceId: debugTrace?.id,
        branchConversationId: this.input.conversationId,
        sourceUserMessageId:
          this.input.sourceUserMessageId ??
          resumedMessage?.metadata?.sourceUserMessageId,
        branchId: this.input.branchId ?? resumedMessage?.metadata?.branchId,
        branchModelId: model.id,
        branchLabel:
          this.input.branchLabel ??
          resumedMessage?.metadata?.branchLabel ??
          model.name ??
          model.model ??
          model.id,
      },
    }
    const initialContent = assistantMessage.content
    const initialReasoning = assistantMessage.reasoning ?? ''
    const preserveInitialReasoning = Boolean(resumedMessage)
    /**
     * How many times a provider tool run has split this turn's answer. Past
     * the first split the turn is no longer one message, so anything that
     * reasons about "the message" as a whole — the non-streaming fallbacks
     * below, and whether the turn produced output at all — has to account for
     * the sealed messages instead of only the one still open.
     */
    let splitCount = 0
    let producedAssistantOutput = false
    /**
     * Start of the message currently being written. Equal to `responseStart`
     * until a run splits the turn, after which each message is timed over its
     * own stretch — so the per-call breakdown adds back up to the turn.
     */
    let segmentStart = responseStart
    this.input.onAssistantMessage(assistantMessage)

    let turnResult: Awaited<ReturnType<typeof executeSingleTurn>>
    let requestReasoning: ReasoningLevel | undefined
    let requestMessages: RequestMessage[]
    let tools: RequestTool[] | undefined
    try {
      const toolPlanStart = Date.now()
      const allAvailableTools = this.input.enableTools
        ? await this.input.mcpManager.listAvailableTools({
            includeBuiltinTools: this.input.includeBuiltinTools,
            chatModelModalities: this.input.model.modalities,
          })
        : []
      // When the provider runs web search itself, offering ours too just gives
      // the model two interchangeable options. `web_scrape` still earns its
      // place: hosted results carry titles and URLs but no page content.
      const availableTools = hasHostedWebSearch(
        this.input.model,
        this.input.apiType,
      )
        ? allAvailableTools.filter(
            (tool) => tool.name !== this.qualifyLocalToolName('web_search'),
          )
        : allAvailableTools
      const {
        filteredTools,
        hasTools,
        hasMemoryTools,
        hasOnDemandTools,
        requestTools,
      } = await selectAllowedTools({
        availableTools,
        allowedToolNames: this.input.allowedToolNames,
        toolPreferences: this.input.toolPreferences,
        toolServerPreferences: this.input.toolServerPreferences,
        apiType: this.input.apiType,
        enableToolDisclosure: this.input.enableToolDisclosure,
        jsSandboxSettings: this.input.mcpManager.getJsSandboxSettings(),
        settings: this.input.mcpManager.getSettingsSnapshot(),
      })
      tools = requestTools
      updateLLMDebugTrace(debugTrace?.id, {
        toolPlanDurationMs: Date.now() - toolPlanStart,
      })

      const contextPreparationStart = Date.now()
      const runtimeModePrompt = buildToolCapabilityPrompt({
        mode: this.input.toolCapabilityMode ?? 'agent',
        toolNames: filteredTools.map((tool) => tool.name),
      })
      const baseRequestMessages =
        await this.input.requestContextBuilder.generateRequestMessages({
          messages: this.input.messages,
          hasTools,
          hasMemoryTools,
          hasOnDemandTools,
          model: this.input.model,
          conversationId: this.input.conversationId,
          compaction: this.input.compaction,
          contextualInjections: this.input.contextualInjections,
          runtimeModePrompt,
          modePersonaPrompt: this.input.modePersonaPrompt,
          modePersonaModuleId: this.input.modePersonaModuleId,
          moduleChatModeId: this.input.moduleChatModeId,
          contextPolicy: this.input.contextPolicy,
          systemPromptOverride: this.input.systemPromptOverride,
          systemPromptSnapshotMode: 'create',
        })
      requestMessages =
        this.input.transientRequestMessages &&
        this.input.transientRequestMessages.length > 0
          ? [...baseRequestMessages, ...this.input.transientRequestMessages]
          : baseRequestMessages
      updateLLMDebugTrace(debugTrace?.id, {
        contextPreparationDurationMs: Date.now() - contextPreparationStart,
      })

      requestReasoning = resolveRequestReasoningLevel(
        this.input.model,
        this.input.reasoningLevel,
      )
      const providerStart = Date.now()
      let recordedFirstToken = false
      /** Runs already placed in the conversation, by run id. */
      const openedToolRuns = new Set<string>()
      turnResult = await executeSingleTurn({
        providerClient: this.input.providerClient,
        model: this.input.model,
        request: {
          model: this.input.model.model,
          messages: requestMessages,
          temperature: this.input.requestParams?.temperature,
          top_p: this.input.requestParams?.top_p,
          max_tokens: this.input.requestParams?.max_tokens,
          ...(requestReasoning !== undefined
            ? { reasoningLevel: requestReasoning }
            : {}),
        },
        tools,
        signal: this.input.abortSignal,
        deliveryMode,
        primaryRequestTimeoutMs:
          this.input.requestParams?.primaryRequestTimeoutMs,
        streamFallbackRecoveryEnabled:
          this.input.requestParams?.streamFallbackRecoveryEnabled,
        geminiTools: this.input.geminiTools,
        ...(this.input.session ? { session: this.input.session } : {}),
        ...(this.input.nativeToolPolicy
          ? { nativeToolPolicy: this.input.nativeToolPolicy }
          : {}),
        debugTraceId: debugTrace?.id,
        onStreamDelta: ({ contentDelta, reasoningDelta, chunk, toolCalls }) => {
          if (reasoningDelta) reasoningTracker.observeReasoning()

          let metadata = assistantMessage.metadata
          if (contentDelta || toolCalls?.length) {
            const reasoningDurationMs = reasoningTracker.settle()
            if (reasoningDurationMs !== undefined) {
              metadata = { ...metadata, reasoningDurationMs }
            }
          }
          if (
            !recordedFirstToken &&
            (Boolean(contentDelta) ||
              Boolean(reasoningDelta) ||
              Boolean(toolCalls?.length))
          ) {
            recordedFirstToken = true
            updateLLMDebugTrace(debugTrace?.id, {
              providerFirstTokenMs: Date.now() - providerStart,
            })
          }

          const content = contentDelta
            ? assistantMessage.content + contentDelta
            : assistantMessage.content

          const reasoning =
            reasoningDelta && !preserveInitialReasoning
              ? `${assistantMessage.reasoning ?? ''}${reasoningDelta}`
              : assistantMessage.reasoning

          let toolCallRequests = assistantMessage.toolCallRequests
          if (toolCalls && toolCalls.length > 0) {
            const streamedToolCallRequests = toolCalls
              .map((toolCall) => {
                const name = toolCall.function?.name?.trim()
                if (!name) {
                  return null
                }

                const normalizedName = this.normalizeToolCallName(name)

                return {
                  id:
                    toolCall.id ??
                    `${assistantMessage.id}-stream-tool-${toolCall.index}`,
                  name: normalizedName,
                  arguments: toolCall.function?.arguments,
                  metadata: toolCall.metadata,
                }
              })
              .filter((toolCall): toolCall is NonNullable<typeof toolCall> =>
                Boolean(toolCall),
              )

            if (streamedToolCallRequests.length > 0) {
              toolCallRequests = streamedToolCallRequests
            }
          }
          if (chunk.usage) {
            metadata = { ...metadata, usage: chunk.usage }
          }
          if (chunk.choices?.[0]?.delta?.providerMetadata) {
            metadata = {
              ...metadata,
              providerMetadata: chunk.choices[0].delta.providerMetadata,
            }
          }

          // Only replace the reference when something actually changed —
          // an untouched reference tells downstream state layers this
          // message can be skipped without a deep comparison.
          if (
            content !== assistantMessage.content ||
            reasoning !== assistantMessage.reasoning ||
            toolCallRequests !== assistantMessage.toolCallRequests ||
            metadata !== assistantMessage.metadata
          ) {
            assistantMessage = {
              ...assistantMessage,
              content,
              reasoning,
              toolCallRequests,
              metadata,
            }
          }
          this.input.onAssistantMessage(assistantMessage)

          const toolRun = chunk.choices?.[0]?.delta?.providerToolRun
          if (!toolRun?.length) return
          const runId = toolRun[0].id
          if (openedToolRuns.has(runId)) {
            // The run is already in place; this only completes its calls.
            this.input.onProviderToolRun?.(toolRun)
            return
          }
          openedToolRuns.add(runId)
          // Everything streamed so far is the part of the answer that came
          // before this run. Seal it, place the run after it, and continue in
          // a new message — that ordering is the whole point of the run being
          // a positional signal rather than metadata.
          producedAssistantOutput ||= assistantMessage.content.trim().length > 0
          assistantMessage = {
            ...assistantMessage,
            metadata: {
              ...assistantMessage.metadata,
              generationState: 'completed',
              durationMs: Date.now() - segmentStart,
              ...(reasoningTracker.settle() !== undefined
                ? { reasoningDurationMs: reasoningTracker.durationMs }
                : {}),
            },
          }
          segmentStart = Date.now()
          this.input.onAssistantMessage(assistantMessage)
          this.input.onProviderToolRun?.(toolRun)
          splitCount += 1
          assistantMessage = {
            role: 'assistant',
            id: `${assistantMessageId}#${splitCount}`,
            content: '',
            metadata: {
              ...assistantMessage.metadata,
              generationState: 'streaming',
              usage: undefined,
              durationMs: undefined,
              reasoningDurationMs: undefined,
              errorMessage: undefined,
            },
          }
          this.input.onAssistantMessage(assistantMessage)
        },
      })
      if (!recordedFirstToken) {
        updateLLMDebugTrace(debugTrace?.id, {
          providerFirstTokenMs: Date.now() - providerStart,
        })
      }
    } catch (error) {
      const isAborted =
        this.input.abortSignal?.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      const errorMessage = isAborted
        ? undefined
        : formatErrorMessageWithCauses(error)
      const errorDetail: ChatErrorDetail | undefined =
        !isAborted && error instanceof ProviderRequestError
          ? {
              providerId: error.providerId,
              status: error.status,
              ...(error.responseBody
                ? { responseBody: error.responseBody }
                : {}),
            }
          : undefined

      const errorMetadata = {
        ...assistantMessage.metadata,
        ...(reasoningTracker.settle() !== undefined
          ? { reasoningDurationMs: reasoningTracker.durationMs }
          : {}),
        durationMs: Date.now() - segmentStart,
        generationState: isAborted ? ('aborted' as const) : ('error' as const),
        errorMessage,
        ...(errorDetail ? { errorDetail } : {}),
      }
      assistantMessage = { ...assistantMessage, metadata: errorMetadata }
      updateLLMDebugTrace(debugTrace?.id, {
        completedAt: Date.now(),
        durationMs: errorMetadata.durationMs,
        generationState: errorMetadata.generationState,
        errorMessage,
      })
      this.input.onAssistantMessage(assistantMessage)
      throw error
    }

    // These fallbacks fill in the answer when no delta ever arrived. A split
    // turn has deltas by definition, and its trailing message starting out
    // empty is not the same thing — appending the whole turn there would
    // repeat every sealed message.
    let finalContent = assistantMessage.content
    if (
      splitCount === 0 &&
      finalContent === initialContent &&
      turnResult.content
    ) {
      finalContent += turnResult.content
    }
    let finalReasoning = assistantMessage.reasoning
    if (
      splitCount === 0 &&
      !preserveInitialReasoning &&
      (finalReasoning ?? '') === initialReasoning &&
      turnResult.reasoning
    ) {
      finalReasoning = `${initialReasoning}${turnResult.reasoning}`
    }
    if (turnResult.reasoning) reasoningTracker.observeReasoning()
    const reasoningDurationMs = reasoningTracker.settle()

    let finalAnnotations = assistantMessage.annotations
    if (turnResult.annotations?.length) {
      const existingAnnotations = assistantMessage.annotations ?? []
      finalAnnotations = [
        ...existingAnnotations,
        ...turnResult.annotations.filter(
          (incoming) =>
            !existingAnnotations.some(
              (existing) =>
                existing.url_citation.url === incoming.url_citation.url,
            ),
        ),
      ]
    }
    const finalMetadata = {
      ...assistantMessage.metadata,
      ...(reasoningDurationMs !== undefined ? { reasoningDurationMs } : {}),
      usage: turnResult.usage ?? assistantMessage.metadata?.usage,
      durationMs: Date.now() - segmentStart,
      generationState: this.input.abortSignal?.aborted
        ? ('aborted' as const)
        : ('completed' as const),
      providerMetadata: turnResult.providerMetadata,
    }

    const toolCallRequests = turnResult.toolCalls.map((toolCall) => ({
      id: toolCall.id ?? uuidv4(),
      name: this.normalizeToolCallName(toolCall.name),
      arguments: toolCall.arguments,
      metadata: toolCall.metadata,
    }))

    assistantMessage = {
      ...assistantMessage,
      content: finalContent,
      reasoning: finalReasoning,
      annotations: finalAnnotations,
      metadata: finalMetadata,
      toolCallRequests:
        toolCallRequests.length > 0 ? toolCallRequests : undefined,
    }
    updateLLMDebugTrace(debugTrace?.id, {
      completedAt: Date.now(),
      durationMs: finalMetadata.durationMs,
      generationState: finalMetadata.generationState,
      usage: finalMetadata.usage,
      hasToolCalls: toolCallRequests.length > 0,
      toolCallNames: toolCallRequests.map((toolCall) => toolCall.name),
    })
    this.input.onAssistantMessage(assistantMessage)

    return {
      assistantMessage,
      toolCallRequests,
      hasAssistantOutput:
        producedAssistantOutput || assistantMessage.content.trim().length > 0,
      debugTraceId: debugTrace?.id,
      requestMessages,
      requestTools: tools,
      requestReasoning,
    }
  }

  private normalizeToolCallName(toolName: string): string {
    if (toolName.includes(McpManager.TOOL_NAME_DELIMITER)) {
      return toolName
    }
    if (!AgentLlmTurnExecutor.LOCAL_TOOL_NAMES.has(toolName)) {
      return toolName
    }
    return this.qualifyLocalToolName(toolName)
  }

  private qualifyLocalToolName(toolName: string): string {
    return `${getLocalFileToolServerName()}${McpManager.TOOL_NAME_DELIMITER}${toolName}`
  }
}
