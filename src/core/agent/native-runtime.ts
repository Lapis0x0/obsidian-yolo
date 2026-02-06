import { v4 as uuidv4 } from 'uuid'

import { ChatMessage } from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { ResponseGenerator } from '../../utils/chat/responseGenerator'

import { createAgentLoopWorker } from './loop-worker'
import { AgentRuntime } from './runtime'
import { AgentToolGateway } from './tool-gateway'
import {
  AgentRuntimeLoopConfig,
  AgentRuntimeRunInput,
  AgentRuntimeSubscribe,
} from './types'

export class NativeAgentRuntime implements AgentRuntime {
  private subscribers: AgentRuntimeSubscribe[] = []
  private messages: ChatMessage[] = []
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

  abort(): void {
    if (this.runAbortController) {
      this.runAbortController.abort()
      this.runAbortController = null
    }
  }

  async run(input: AgentRuntimeRunInput): Promise<void> {
    const toolGateway = new AgentToolGateway(input.mcpManager)
    const worker = createAgentLoopWorker()
    const runId = uuidv4()

    const localAbortController = new AbortController()
    this.runAbortController = localAbortController

    const abortSignal = this.mergeAbortSignals(
      input.abortSignal,
      localAbortController.signal,
    )

    const unsubscribeWorker = worker.subscribe((msg) => {
      if (msg.type === 'error') {
        console.error('[AgentRuntime] loop worker error:', msg.error)
      }
    })

    const responseGenerator = new ResponseGenerator({
      providerClient: input.providerClient,
      model: input.model,
      messages: input.messages,
      conversationId: input.conversationId,
      enableTools: this.loopConfig.enableTools,
      maxAutoIterations: this.loopConfig.maxAutoIterations,
      promptGenerator: input.promptGenerator,
      mcpManager: input.mcpManager,
      includeBuiltinTools: this.loopConfig.includeBuiltinTools,
      abortSignal,
      reasoningLevel: input.reasoningLevel,
      requestParams: input.requestParams,
      maxContextOverride: input.maxContextOverride,
      geminiTools: input.geminiTools,
    })

    const unsubscribe = responseGenerator.subscribe((messages) => {
      this.messages = messages
      this.notifySubscribers(messages)
    })

    try {
      const tools = await toolGateway.listTools({
        includeBuiltinTools: this.loopConfig.includeBuiltinTools,
      })
      worker.postMessage({
        type: 'start',
        runId,
        maxIterations: this.loopConfig.maxAutoIterations,
        hasTools: tools.length > 0,
      })

      await responseGenerator.run()

      const hasPendingTools = this.messages.some(
        (message) =>
          message.role === 'tool' &&
          message.toolCalls.some((toolCall) =>
            [
              ToolCallResponseStatus.PendingApproval,
              ToolCallResponseStatus.Running,
            ].includes(toolCall.response.status),
          ),
      )

      worker.postMessage({
        type: 'tool_result',
        runId,
        hasPendingTools,
      })
    } finally {
      unsubscribe()
      unsubscribeWorker()
      worker.terminate()
      if (this.runAbortController === localAbortController) {
        this.runAbortController = null
      }
    }
  }

  private notifySubscribers(messages: ChatMessage[]): void {
    this.subscribers.forEach((callback) => callback(messages))
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
