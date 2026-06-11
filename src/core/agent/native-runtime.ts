import { v4 as uuidv4 } from 'uuid'

import {
  ChatAssistantMessage,
  ChatConversationCompactionState,
  ChatMessage,
  ChatToolMessage,
  getLatestChatConversationCompaction,
  normalizeChatConversationCompactionState,
} from '../../types/chat'
import type { RequestMessage, RequestTool } from '../../types/llm/request'
import type { ReasoningLevel } from '../../types/reasoning'
import {
  ToolCallRequest,
  ToolCallResponseStatus,
} from '../../types/tool-call.types'
import { runWithLLMDebugTrace } from '../llm/debugCapture'

import { composeAgentInjections } from './agent-injections'
import {
  buildAutoContextCompactionNoticeMessage,
  buildCompactedConversationState,
  createConversationCompactionSummary,
  findCompactInstruction,
  findCompactToolCallId,
  getAutoContextCompactionPromptTrigger,
  getLastAssistantPromptTokens,
} from './compaction'
import { AgentLlmTurnExecutor } from './llm-turn-executor'
import { createAgentLoopWorker } from './loop-worker'
import {
  applyRepeatedToolFailureGuard,
  createRepeatedToolFailureGuardState,
} from './repeated-tool-failure-guard'
import { estimateContinuationRequestContextTokens } from './requestContextEstimate'
import { AgentRuntime } from './runtime'
import { buildSubagentParentContext } from './subagent/parent-context'
import { AgentToolGateway } from './tool-gateway'
import { shouldProceedToToolPhase } from './tool-phase'
import {
  AgentRuntimeLoopConfig,
  AgentRuntimeRunInput,
  AgentRuntimeSnapshot,
  AgentRuntimeSubscribe,
  AgentWorkerOutbound,
} from './types'

export class NativeAgentRuntime implements AgentRuntime {
  private subscribers: AgentRuntimeSubscribe[] = []
  private messages: ChatMessage[] = []
  private compactionState: ChatConversationCompactionState = []
  private pendingCompactionAnchorMessageId: string | null = null
  private runAbortController: AbortController | null = null

  constructor(private readonly loopConfig: AgentRuntimeLoopConfig) {}

  subscribe(callback: AgentRuntimeSubscribe): () => void {
    this.subscribers.push(callback)
    return () => {
      this.subscribers = this.subscribers.filter((cb) => cb !== callback)
    }
  }

  getMessages(): ChatMessage[] {
    return this.messages
  }

  getSnapshot(): AgentRuntimeSnapshot {
    return {
      messages: [...this.messages],
      compaction: [...this.compactionState],
      pendingCompactionAnchorMessageId: this.pendingCompactionAnchorMessageId,
    }
  }

  abort(): void {
    if (this.runAbortController) {
      this.runAbortController.abort()
      this.runAbortController = null
    }
  }

  async run(input: AgentRuntimeRunInput): Promise<void> {
    const requestMessages = input.requestMessages ?? input.messages
    this.compactionState = normalizeChatConversationCompactionState(
      input.compaction,
    )
    this.pendingCompactionAnchorMessageId = null
    const localAbortController = new AbortController()
    this.runAbortController = localAbortController

    const abortSignal = this.mergeAbortSignals(
      input.abortSignal,
      localAbortController.signal,
    )

    if (this.shouldUseSingleTurnFastPath()) {
      try {
        await this.runSingleTurnFastPath(input, abortSignal)
      } finally {
        if (this.runAbortController === localAbortController) {
          this.runAbortController = null
        }
      }
      return
    }

    const toolGateway = new AgentToolGateway(input.mcpManager, {
      toolsEnabled: this.loopConfig.enableTools,
      allowedToolNames: input.allowedToolNames,
      enableToolDisclosure: input.enableToolDisclosure,
      toolPreferences: input.toolPreferences,
      workspaceScope: input.workspaceScope,
      allowedSkillPaths: input.allowedSkillPaths,
      apiType: input.apiType,
      runContext: input.runContext,
      subagentParentContext: input.systemPromptOverride
        ? undefined
        : buildSubagentParentContext(input, this.loopConfig),
      isSubagentChildRun: Boolean(input.systemPromptOverride),
      toolApprovalConversationId: input.toolApprovalConversationId,
      blockedCommandPrefixes: input.blockedCommandPrefixes,
      bypassToolApproval: input.bypassToolApproval,
    })
    const worker = createAgentLoopWorker()
    const runId = uuidv4()

    let pendingToolMessageId: string | null = null
    let pendingToolCallCount = 0
    let currentDebugTraceId: string | undefined
    // Per-turn cache-warm prefix + tools the executor actually sent, plus the
    // `this.messages` boundary before this turn's LLM request. The compaction
    // bypass reuses these to build a byte-identical out-of-band request.
    let currentTurnRequestMessages: RequestMessage[] = []
    let currentTurnRequestTools: RequestTool[] | undefined
    let currentTurnRequestReasoning: ReasoningLevel | undefined
    let currentTurnMessageBoundary = 0
    let runSettled = false
    let workerTaskQueue = Promise.resolve()
    let abortListener: (() => void) | null = null
    let repeatedToolFailureGuardState = createRepeatedToolFailureGuardState()
    const promptedAutoCompactionAssistantMessageIds = new Set<string>()

    const runCompletion = new Promise<void>((resolve, reject) => {
      const handleWorkerMessage = (message: AgentWorkerOutbound): void => {
        if (message.runId !== runId) {
          return
        }

        workerTaskQueue = workerTaskQueue
          .then(async () => {
            switch (message.type) {
              case 'llm_request': {
                if (abortSignal.aborted) {
                  worker.postMessage({ type: 'abort', runId })
                  return
                }

                if (input.drainPendingUserMessages) {
                  const injected = input.drainPendingUserMessages()
                  if (injected.length > 0) {
                    for (const injectedMessage of injected) {
                      this.messages.push(injectedMessage)
                    }
                    this.notifySubscribers()
                  }
                }

                const conversationMessages = [
                  ...requestMessages,
                  ...this.messages,
                ]
                const autoContextCompactionNotice =
                  this.buildAutoContextCompactionNotice({
                    input,
                    messages: conversationMessages,
                    promptedAssistantMessageIds:
                      promptedAutoCompactionAssistantMessageIds,
                  })

                const llmTurnExecutor = new AgentLlmTurnExecutor({
                  providerClient: input.providerClient,
                  model: input.model,
                  requestContextBuilder: input.requestContextBuilder,
                  mcpManager: input.mcpManager,
                  conversationId: input.conversationId,
                  messages: conversationMessages,
                  branchId: input.branchId,
                  sourceUserMessageId: input.sourceUserMessageId,
                  branchLabel: input.branchLabel,
                  compaction: this.compactionState,
                  enableTools: this.loopConfig.enableTools,
                  includeBuiltinTools: this.loopConfig.includeBuiltinTools,
                  apiType: input.apiType,
                  allowedToolNames: input.allowedToolNames,
                  enableToolDisclosure: input.enableToolDisclosure,
                  toolPreferences: input.toolPreferences,
                  allowedSkillPaths: input.allowedSkillPaths,
                  abortSignal,
                  reasoningLevel: input.reasoningLevel,
                  requestParams: input.requestParams,
                  contextualInjections: composeAgentInjections({
                    baseInjections: input.contextualInjections,
                    messages: conversationMessages,
                  }),
                  runtimeModePrompt: input.runtimeModePrompt,
                  transientRequestMessages: autoContextCompactionNotice
                    ? [autoContextCompactionNotice]
                    : undefined,
                  geminiTools: input.geminiTools,
                  systemPromptOverride: input.systemPromptOverride,
                  onAssistantMessage: (assistantMessage) => {
                    this.upsertAssistantMessage(assistantMessage)
                    this.notifySubscribers()
                  },
                })

                // Record the boundary before the LLM request: messages added
                // after this point (this turn's assistant + tool) are the
                // compaction `turnMessages`.
                currentTurnMessageBoundary = this.messages.length

                const turnResult = await llmTurnExecutor.run()
                pendingToolMessageId = null
                pendingToolCallCount = turnResult.toolCallRequests.length
                currentDebugTraceId = turnResult.debugTraceId
                currentTurnRequestMessages = turnResult.requestMessages
                currentTurnRequestTools = turnResult.requestTools
                currentTurnRequestReasoning = turnResult.requestReasoning

                worker.postMessage({
                  type: 'llm_result',
                  runId,
                  hasToolCalls: shouldProceedToToolPhase(turnResult),
                  hasAssistantOutput: turnResult.hasAssistantOutput,
                })
                return
              }
              case 'tool_phase': {
                if (abortSignal.aborted) {
                  worker.postMessage({ type: 'abort', runId })
                  return
                }

                const toolCallRequests =
                  this.getLatestToolCallRequests(pendingToolCallCount)
                const initialToolMessage = toolGateway.createToolMessage({
                  toolCallRequests,
                  conversationId: input.conversationId,
                  branchId: input.branchId,
                  sourceUserMessageId: input.sourceUserMessageId,
                  branchModelId: input.model.id,
                  branchLabel:
                    input.branchLabel ??
                    input.model.name ??
                    input.model.model ??
                    input.model.id,
                })
                pendingToolMessageId = initialToolMessage.id

                this.messages.push(initialToolMessage)
                this.notifySubscribers()

                const completedToolMessage = await runWithLLMDebugTrace(
                  currentDebugTraceId,
                  () =>
                    toolGateway.executeAutoToolCalls({
                      toolMessage: initialToolMessage,
                      conversationId: input.conversationId,
                      conversationMessages: [
                        ...requestMessages,
                        ...this.messages,
                      ],
                      conversationCompaction: this.compactionState,
                      signal: abortSignal,
                      chatModelId: input.model.id,
                      debugTraceId: currentDebugTraceId,
                    }),
                )
                const guardedToolResult = applyRepeatedToolFailureGuard({
                  state: repeatedToolFailureGuardState,
                  toolMessage: completedToolMessage,
                })
                repeatedToolFailureGuardState = guardedToolResult.state
                const guardedToolMessage = guardedToolResult.toolMessage

                this.replaceToolMessage(guardedToolMessage)
                this.notifySubscribers()

                const compactToolCallId =
                  findCompactToolCallId(guardedToolMessage)
                if (compactToolCallId) {
                  this.pendingCompactionAnchorMessageId = guardedToolMessage.id
                  this.notifySubscribers()

                  const conversationMessages = [
                    ...requestMessages,
                    ...this.messages,
                  ]

                  // This turn's new assistant + tool messages (incl. the
                  // context_compact call/result), converted with the same
                  // parsing as the main request pipeline.
                  const turnMessages =
                    input.requestContextBuilder.parseTurnMessagesToRequestMessages(
                      this.messages.slice(currentTurnMessageBoundary),
                    )
                  const focusInstruction =
                    findCompactInstruction(completedToolMessage)

                  console.debug('[YOLO][Compact] compact trigger detected', {
                    conversationId: input.conversationId,
                    triggerToolCallId: compactToolCallId,
                    messageCount: conversationMessages.length,
                    prefixMessageCount: currentTurnRequestMessages.length,
                    turnMessageCount: turnMessages.length,
                  })

                  try {
                    const summary = await createConversationCompactionSummary({
                      providerClient: input.providerClient,
                      model: input.model,
                      requestMessages: currentTurnRequestMessages,
                      turnMessages,
                      focusInstruction,
                      tools: currentTurnRequestTools,
                      reasoningLevel: currentTurnRequestReasoning,
                      debugTraceId: currentDebugTraceId,
                    })
                    const nextCompaction =
                      await buildCompactedConversationState({
                        messages: conversationMessages,
                        summary,
                        summaryModelId: input.model.id,
                      })
                    if (nextCompaction) {
                      try {
                        nextCompaction.estimatedNextContextTokens =
                          await estimateContinuationRequestContextTokens({
                            requestContextBuilder: input.requestContextBuilder,
                            mcpManager: input.mcpManager,
                            model: input.model,
                            messages: conversationMessages,
                            conversationId: input.conversationId,
                            compaction: nextCompaction,
                            enableTools: this.loopConfig.enableTools,
                            includeBuiltinTools:
                              this.loopConfig.includeBuiltinTools,
                            apiType: input.apiType,
                            allowedToolNames: input.allowedToolNames,
                            enableToolDisclosure: input.enableToolDisclosure,
                            toolPreferences: input.toolPreferences,
                            contextualInjections: composeAgentInjections({
                              baseInjections: input.contextualInjections,
                              messages: conversationMessages,
                            }),
                            runtimeModePrompt: input.runtimeModePrompt,
                          })
                      } catch (error) {
                        console.warn(
                          '[YOLO][Compact] failed to estimate continuation context tokens',
                          error,
                        )
                      }
                      const preCompactionTokens =
                        getLastAssistantPromptTokens(conversationMessages)
                      if (
                        typeof preCompactionTokens === 'number' &&
                        typeof nextCompaction.estimatedNextContextTokens ===
                          'number'
                      ) {
                        const saved =
                          preCompactionTokens -
                          nextCompaction.estimatedNextContextTokens
                        if (saved > 0) {
                          nextCompaction.estimatedTokensSaved = saved
                        }
                      }
                    }
                    this.compactionState = nextCompaction
                      ? [...this.compactionState, nextCompaction]
                      : this.compactionState
                    this.pendingCompactionAnchorMessageId = null
                    this.notifySubscribers()
                  } catch (error) {
                    this.pendingCompactionAnchorMessageId = null
                    this.notifySubscribers()
                    throw error
                  }

                  const latestCompaction = getLatestChatConversationCompaction(
                    this.compactionState,
                  )
                  console.debug('[YOLO][Compact] compact state ready', {
                    conversationId: input.conversationId,
                    anchorMessageId: latestCompaction?.anchorMessageId,
                    triggerToolCallId: latestCompaction?.triggerToolCallId,
                  })

                  worker.postMessage({
                    type: 'tool_result',
                    runId,
                    hasPendingTools: false,
                    forceStopReason: guardedToolResult.forceStopReason,
                  })
                  return
                }

                worker.postMessage({
                  type: 'tool_result',
                  runId,
                  hasPendingTools:
                    toolGateway.hasPendingToolCalls(guardedToolMessage),
                  forceStopReason: guardedToolResult.forceStopReason,
                })
                return
              }
              case 'done': {
                runSettled = true
                resolve()
                return
              }
              case 'error': {
                runSettled = true
                reject(new Error(message.error))
                return
              }
            }
          })
          .catch((error: unknown) => {
            if (runSettled) {
              return
            }
            runSettled = true
            reject(
              error instanceof Error
                ? error
                : new Error(
                    typeof error === 'string' ? error : 'Unknown runtime error',
                  ),
            )
          })
      }

      worker.subscribe(handleWorkerMessage)

      abortListener = () => {
        worker.postMessage({ type: 'abort', runId })
        if (pendingToolMessageId) {
          this.markToolMessageAborted(pendingToolMessageId)
          this.notifySubscribers()
        }
      }
      abortSignal.addEventListener('abort', abortListener, { once: true })

      worker.postMessage({
        type: 'start',
        runId,
        maxIterations: this.loopConfig.maxAutoIterations,
      })
    })

    try {
      await runCompletion
    } finally {
      if (abortListener) {
        abortSignal.removeEventListener('abort', abortListener)
      }
      worker.terminate()
      if (this.runAbortController === localAbortController) {
        this.runAbortController = null
      }
    }
  }

  private shouldUseSingleTurnFastPath(): boolean {
    return (
      !this.loopConfig.enableTools && this.loopConfig.maxAutoIterations <= 1
    )
  }

  private buildAutoContextCompactionNotice({
    input,
    messages,
    promptedAssistantMessageIds,
  }: {
    input: AgentRuntimeRunInput
    messages: ChatMessage[]
    promptedAssistantMessageIds: Set<string>
  }): RequestMessage | null {
    if (!this.loopConfig.enableTools || !input.autoContextCompaction) {
      return null
    }

    const trigger = getAutoContextCompactionPromptTrigger({
      messages,
      chatOptions: input.autoContextCompaction.chatOptions,
      maxContextTokens: input.autoContextCompaction.maxContextTokens,
      compactionState: this.compactionState,
      promptedAssistantMessageIds,
    })
    if (!trigger) {
      return null
    }

    promptedAssistantMessageIds.add(trigger.assistantMessage.id)
    return buildAutoContextCompactionNoticeMessage({
      trigger,
      chatOptions: input.autoContextCompaction.chatOptions,
    })
  }

  private async runSingleTurnFastPath(
    input: AgentRuntimeRunInput,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const llmTurnExecutor = new AgentLlmTurnExecutor({
      providerClient: input.providerClient,
      model: input.model,
      requestContextBuilder: input.requestContextBuilder,
      mcpManager: input.mcpManager,
      conversationId: input.conversationId,
      messages: [
        ...(input.requestMessages ?? input.messages),
        ...this.messages,
      ],
      enableTools: false,
      includeBuiltinTools: false,
      apiType: input.apiType,
      allowedToolNames: input.allowedToolNames,
      toolPreferences: input.toolPreferences,
      allowedSkillPaths: input.allowedSkillPaths,
      abortSignal,
      reasoningLevel: input.reasoningLevel,
      requestParams: input.requestParams,
      contextualInjections: input.contextualInjections,
      runtimeModePrompt: input.runtimeModePrompt,
      geminiTools: input.geminiTools,
      systemPromptOverride: input.systemPromptOverride,
      onAssistantMessage: (assistantMessage) => {
        this.upsertAssistantMessage(assistantMessage)
        this.notifySubscribers()
      },
    })

    await llmTurnExecutor.run()
  }

  private notifySubscribers(): void {
    const snapshot = this.getSnapshot()
    this.subscribers.forEach((callback) => {
      callback(snapshot)
    })
  }

  private upsertAssistantMessage(message: ChatAssistantMessage): void {
    const existingIndex = this.messages.findIndex(
      (item) => item.id === message.id,
    )
    if (existingIndex >= 0) {
      this.messages[existingIndex] = message
      return
    }
    this.messages.push(message)
  }

  private getLatestToolCallRequests(expectedCount: number): ToolCallRequest[] {
    if (expectedCount <= 0) {
      return []
    }

    for (let index = this.messages.length - 1; index >= 0; index--) {
      const candidate = this.messages[index]
      if (candidate.role !== 'assistant') {
        continue
      }

      const requests = candidate.toolCallRequests ?? []
      if (requests.length === 0) {
        return []
      }
      if (requests.length !== expectedCount) {
        return requests
      }
      return requests
    }

    return []
  }

  private replaceToolMessage(message: ChatToolMessage): void {
    const index = this.messages.findIndex((item) => item.id === message.id)
    if (index === -1) {
      this.messages.push(message)
      return
    }
    this.messages[index] = message
  }

  private markToolMessageAborted(toolMessageId: string): void {
    const index = this.messages.findIndex(
      (message) => message.id === toolMessageId,
    )
    if (index === -1) {
      return
    }
    const message = this.messages[index]
    if (message.role !== 'tool') {
      return
    }
    this.messages[index] = {
      ...message,
      toolCalls: message.toolCalls.map((toolCall) =>
        toolCall.response.status === ToolCallResponseStatus.Running
          ? {
              ...toolCall,
              response: { status: ToolCallResponseStatus.Aborted },
            }
          : toolCall,
      ),
    }
  }

  private mergeAbortSignals(
    externalSignal: AbortSignal | undefined,
    localSignal: AbortSignal,
  ): AbortSignal {
    if (!externalSignal) {
      return localSignal
    }
    const controller = new AbortController()

    const tryAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort()
      }
    }

    if (externalSignal.aborted || localSignal.aborted) {
      tryAbort()
      return controller.signal
    }

    externalSignal.addEventListener('abort', tryAbort, { once: true })
    localSignal.addEventListener('abort', tryAbort, { once: true })

    return controller.signal
  }
}
