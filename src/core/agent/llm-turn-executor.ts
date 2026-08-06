import { v4 as uuidv4 } from 'uuid'

import type {
  AssistantToolPreference,
  AssistantToolServerPreference,
} from '../../types/assistant.types'
import {
  ChatAssistantMessage,
  ChatConversationCompactionLike,
  ChatMessage,
} from '../../types/chat'
import { ChatModel } from '../../types/chat-model.types'
import type { RequestMessage, RequestTool } from '../../types/llm/request'
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
import { executeSingleTurn } from '../ai/single-turn'
import { BaseLLMProvider } from '../llm/base'
import {
  createLLMDebugTrace,
  isLLMDebugCaptureEnabled,
  registerLLMDebugTraceForTurn,
  updateLLMDebugTrace,
} from '../llm/debugCapture'
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
  transientRequestMessages?: RequestMessage[]
  geminiTools?: {
    useWebSearch?: boolean
    useUrlContext?: boolean
  }
  systemPromptOverride?: string
  onAssistantMessage: (message: ChatAssistantMessage) => void
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
    const assistantMessage: ChatAssistantMessage = {
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
    this.input.onAssistantMessage(assistantMessage)

    let turnResult: Awaited<ReturnType<typeof executeSingleTurn>>
    let requestReasoning: ReasoningLevel | undefined
    let requestMessages: RequestMessage[]
    let tools: RequestTool[] | undefined
    try {
      const toolPlanStart = Date.now()
      const availableTools = this.input.enableTools
        ? await this.input.mcpManager.listAvailableTools({
            includeBuiltinTools: this.input.includeBuiltinTools,
            chatModelModalities: this.input.model.modalities,
          })
        : []
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
        debugTraceId: debugTrace?.id,
        onStreamDelta: ({ contentDelta, reasoningDelta, chunk, toolCalls }) => {
          if (reasoningDelta) reasoningTracker.observeReasoning()
          if (contentDelta || toolCalls?.length) {
            const reasoningDurationMs = reasoningTracker.settle()
            if (reasoningDurationMs !== undefined) {
              assistantMessage.metadata = {
                ...assistantMessage.metadata,
                reasoningDurationMs,
              }
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
          if (contentDelta) {
            assistantMessage.content += contentDelta
          }
          if (reasoningDelta && !preserveInitialReasoning) {
            assistantMessage.reasoning = `${assistantMessage.reasoning ?? ''}${reasoningDelta}`
          }
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
              assistantMessage.toolCallRequests = streamedToolCallRequests
            }
          }
          if (chunk.usage) {
            assistantMessage.metadata = {
              ...assistantMessage.metadata,
              usage: chunk.usage,
            }
          }
          if (chunk.choices?.[0]?.delta?.providerMetadata) {
            assistantMessage.metadata = {
              ...assistantMessage.metadata,
              providerMetadata: chunk.choices[0].delta.providerMetadata,
            }
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

      assistantMessage.metadata = {
        ...assistantMessage.metadata,
        ...(reasoningTracker.settle() !== undefined
          ? { reasoningDurationMs: reasoningTracker.durationMs }
          : {}),
        durationMs: Date.now() - responseStart,
        generationState: isAborted ? 'aborted' : 'error',
        errorMessage,
      }
      updateLLMDebugTrace(debugTrace?.id, {
        completedAt: Date.now(),
        durationMs: assistantMessage.metadata.durationMs,
        generationState: assistantMessage.metadata.generationState,
        errorMessage,
      })
      this.input.onAssistantMessage(assistantMessage)
      throw error
    }

    if (assistantMessage.content === initialContent && turnResult.content) {
      assistantMessage.content += turnResult.content
    }
    if (
      !preserveInitialReasoning &&
      (assistantMessage.reasoning ?? '') === initialReasoning &&
      turnResult.reasoning
    ) {
      assistantMessage.reasoning = `${initialReasoning}${turnResult.reasoning}`
    }
    if (turnResult.reasoning) reasoningTracker.observeReasoning()
    const reasoningDurationMs = reasoningTracker.settle()

    if (turnResult.annotations?.length) {
      const existingAnnotations = assistantMessage.annotations ?? []
      assistantMessage.annotations = [
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
    assistantMessage.metadata = {
      ...assistantMessage.metadata,
      ...(reasoningDurationMs !== undefined ? { reasoningDurationMs } : {}),
      usage: turnResult.usage ?? assistantMessage.metadata?.usage,
      durationMs: Date.now() - responseStart,
      generationState: this.input.abortSignal?.aborted
        ? 'aborted'
        : 'completed',
      providerMetadata: turnResult.providerMetadata,
    }

    const toolCallRequests = turnResult.toolCalls.map((toolCall) => ({
      id: toolCall.id ?? uuidv4(),
      name: this.normalizeToolCallName(toolCall.name),
      arguments: toolCall.arguments,
      metadata: toolCall.metadata,
    }))

    assistantMessage.toolCallRequests =
      toolCallRequests.length > 0 ? toolCallRequests : undefined
    updateLLMDebugTrace(debugTrace?.id, {
      completedAt: Date.now(),
      durationMs: assistantMessage.metadata.durationMs,
      generationState: assistantMessage.metadata.generationState,
      usage: assistantMessage.metadata.usage,
      hasToolCalls: toolCallRequests.length > 0,
      toolCallNames: toolCallRequests.map((toolCall) => toolCall.name),
    })
    this.input.onAssistantMessage(assistantMessage)

    return {
      assistantMessage,
      toolCallRequests,
      hasAssistantOutput: assistantMessage.content.trim().length > 0,
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
    return `${getLocalFileToolServerName()}${McpManager.TOOL_NAME_DELIMITER}${toolName}`
  }
}
