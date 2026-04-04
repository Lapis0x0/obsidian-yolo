import { v4 as uuidv4 } from 'uuid'

import {
  ChatAssistantMessage,
  ChatConversationCompactionState,
  ChatMessage,
  ChatToolMessage,
  getLatestChatConversationCompaction,
  normalizeChatConversationCompactionState,
} from '../../types/chat'
import {
  ToolCallRequest,
  ToolCallResponseStatus,
} from '../../types/tool-call.types'

import {
  buildCompactedConversationState,
  createConversationCompactionSummary,
  findCompactToolCallId,
} from './compaction'
import { AgentLlmTurnExecutor } from './llm-turn-executor'
import { createAgentLoopWorker } from './loop-worker'
import { estimateContinuationRequestContextTokens } from './requestContextEstimate'
import { AgentRuntime } from './runtime'
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
      toolPreferences: input.toolPreferences,
      allowedSkillIds: input.allowedSkillIds,
      allowedSkillNames: input.allowedSkillNames,
    })
    const worker = createAgentLoopWorker()
    const runId = uuidv4()

    let pendingToolMessageId: string | null = null
    let pendingToolCallCount = 0
    let runSettled = false
    let workerTaskQueue = Promise.resolve()
    let abortListener: (() => void) | null = null

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

                const llmTurnExecutor = new AgentLlmTurnExecutor({
                  providerClient: input.providerClient,
                  model: input.model,
                  requestContextBuilder: input.requestContextBuilder,
                  mcpManager: input.mcpManager,
                  conversationId: input.conversationId,
                  messages: [...requestMessages, ...this.messages],
                  branchId: input.branchId,
                  sourceUserMessageId: input.sourceUserMessageId,
                  branchLabel: input.branchLabel,
                  compaction: this.compactionState,
                  enableTools: this.loopConfig.enableTools,
                  includeBuiltinTools: this.loopConfig.includeBuiltinTools,
                  allowedToolNames: input.allowedToolNames,
                  allowedSkillIds: input.allowedSkillIds,
                  allowedSkillNames: input.allowedSkillNames,
                  abortSignal,
                  reasoningLevel: input.reasoningLevel,
                  requestParams: input.requestParams,
                  maxContextOverride: input.maxContextOverride,
                  currentFileContextMode: input.currentFileContextMode,
                  currentFileOverride: input.currentFileOverride,
                  geminiTools: input.geminiTools,
                  onAssistantMessage: (assistantMessage) => {
                    this.upsertAssistantMessage(assistantMessage)
                    this.notifySubscribers()
                  },
                })

                const turnResult = await llmTurnExecutor.run()
                pendingToolMessageId = null
                pendingToolCallCount = turnResult.toolCallRequests.length

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

                const completedToolMessage =
                  await toolGateway.executeAutoToolCalls({
                    toolMessage: initialToolMessage,
                    conversationId: input.conversationId,
                    conversationMessages: [
                      ...requestMessages,
                      ...this.messages,
                    ],
                    signal: abortSignal,
                  })

                this.replaceToolMessage(completedToolMessage)
                this.notifySubscribers()

                const compactToolCallId =
                  findCompactToolCallId(completedToolMessage)
                if (
                  compactToolCallId &&
                  input.compactionProviderClient &&
                  input.compactionModel
                ) {
                  this.pendingCompactionAnchorMessageId =
                    completedToolMessage.id
                  this.notifySubscribers()

                  const conversationMessages = [
                    ...requestMessages,
                    ...this.messages,
                  ]

                  console.debug('[YOLO][Compact] compact trigger detected', {
                    conversationId: input.conversationId,
                    triggerToolCallId: compactToolCallId,
                    messageCount: conversationMessages.length,
                  })

                  try {
                    const summary = await createConversationCompactionSummary({
                      providerClient: input.compactionProviderClient,
                      model: input.compactionModel,
                      messages: conversationMessages,
                    })
                    const nextCompaction = buildCompactedConversationState({
                      messages: conversationMessages,
                      summary,
                      summaryModelId: input.compactionModel.id,
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
                            allowedToolNames: input.allowedToolNames,
                            allowedSkillIds: input.allowedSkillIds,
                            allowedSkillNames: input.allowedSkillNames,
                            maxContextOverride: input.maxContextOverride,
                            currentFileContextMode:
                              input.currentFileContextMode,
                            currentFileOverride: input.currentFileOverride,
                          })
                      } catch (error) {
                        console.warn(
                          '[YOLO][Compact] failed to estimate continuation context tokens',
                          error,
                        )
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
                  })
                  return
                }

                worker.postMessage({
                  type: 'tool_result',
                  runId,
                  hasPendingTools:
                    toolGateway.hasPendingToolCalls(completedToolMessage),
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
      allowedToolNames: input.allowedToolNames,
      allowedSkillIds: input.allowedSkillIds,
      allowedSkillNames: input.allowedSkillNames,
      abortSignal,
      reasoningLevel: input.reasoningLevel,
      requestParams: input.requestParams,
      maxContextOverride: input.maxContextOverride,
      currentFileContextMode: input.currentFileContextMode,
      currentFileOverride: input.currentFileOverride,
      geminiTools: input.geminiTools,
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
