import { decideAfterLlmResult, decideAfterToolResult } from './loop-decision'
import { AgentWorkerInbound, AgentWorkerOutbound } from './types'

type WorkerSubscriber = (message: AgentWorkerOutbound) => void

type WorkerBridge = {
  postMessage: (message: AgentWorkerInbound) => void
  subscribe: (callback: WorkerSubscriber) => () => void
  terminate: () => void
}

type LoopState = {
  runId: string
  iteration: number
  maxIterations: number
  aborted: boolean
}

const WORKER_SCRIPT = `
const createState = (runId, maxIterations) => ({
  runId,
  iteration: 0,
  maxIterations: Math.max(1, maxIterations),
  aborted: false,
})

let state = null

const emit = (msg) => {
  self.postMessage(msg)
}

const decideAfterLlmResult = ({ hasToolCalls }) => {
  if (hasToolCalls) {
    return { type: 'tool_phase' }
  }
  return { type: 'done', reason: 'completed' }
}

const decideAfterToolResult = ({ hasPendingTools, iteration, maxIterations }) => {
  if (hasPendingTools) {
    return { type: 'done', reason: 'completed' }
  }
  if (iteration >= maxIterations) {
    return { type: 'done', reason: 'max_iterations' }
  }
  return { type: 'llm_request', nextIteration: iteration + 1 }
}

self.onmessage = (event) => {
  const message = event.data
  try {
    switch (message.type) {
      case 'start': {
        state = createState(message.runId, message.maxIterations)
        emit({ type: 'llm_request', runId: message.runId, iteration: 1 })
        return
      }
      case 'abort': {
        if (!state || state.runId !== message.runId) return
        state.aborted = true
        emit({ type: 'done', runId: message.runId, reason: 'aborted' })
        return
      }
      case 'llm_result': {
        if (!state || state.runId !== message.runId) return
        if (state.aborted) {
          emit({ type: 'done', runId: message.runId, reason: 'aborted' })
          return
        }
        state.iteration += 1
        const decision = decideAfterLlmResult({
          hasToolCalls: message.hasToolCalls,
          hasAssistantOutput: message.hasAssistantOutput,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
        })
        if (decision.type === 'tool_phase') {
          emit({ type: 'tool_phase', runId: message.runId })
          return
        }
        if (decision.type === 'done') {
          emit({ type: 'done', runId: message.runId, reason: decision.reason })
          return
        }
        emit({
          type: 'llm_request',
          runId: message.runId,
          iteration: decision.nextIteration,
        })
        return
      }
      case 'tool_result': {
        if (!state || state.runId !== message.runId) return
        if (state.aborted) {
          emit({ type: 'done', runId: message.runId, reason: 'aborted' })
          return
        }
        const decision = decideAfterToolResult({
          hasPendingTools: message.hasPendingTools,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
        })
        if (decision.type === 'done') {
          emit({ type: 'done', runId: message.runId, reason: decision.reason })
          return
        }
        emit({
          type: 'llm_request',
          runId: message.runId,
          iteration: decision.nextIteration,
        })
      }
    }
  } catch (error) {
    emit({
      type: 'error',
      runId: message && message.runId ? message.runId : 'unknown',
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
`

class AgentLoopWorkerDriver {
  private state: LoopState | null = null
  private subscribers = new Set<WorkerSubscriber>()

  subscribe(callback: WorkerSubscriber): () => void {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }

  postMessage(message: AgentWorkerInbound): void {
    try {
      this.handleMessage(message)
    } catch (error) {
      this.emit({
        type: 'error',
        runId: 'runId' in message ? message.runId : 'unknown',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  terminate(): void {
    this.subscribers.clear()
    this.state = null
  }

  private handleMessage(message: AgentWorkerInbound): void {
    switch (message.type) {
      case 'start': {
        this.state = {
          runId: message.runId,
          iteration: 0,
          maxIterations: Math.max(1, message.maxIterations),
          aborted: false,
        }
        this.emit({ type: 'llm_request', runId: message.runId, iteration: 1 })
        return
      }
      case 'abort': {
        if (this.state?.runId !== message.runId) return
        this.state.aborted = true
        this.emit({ type: 'done', runId: message.runId, reason: 'aborted' })
        return
      }
      case 'llm_result': {
        if (!this.state || this.state.runId !== message.runId) return
        if (this.state.aborted) {
          this.emit({ type: 'done', runId: message.runId, reason: 'aborted' })
          return
        }
        this.state.iteration += 1
        const decision = decideAfterLlmResult({
          hasToolCalls: message.hasToolCalls,
          hasAssistantOutput: message.hasAssistantOutput,
          iteration: this.state.iteration,
          maxIterations: this.state.maxIterations,
        })
        if (decision.type === 'tool_phase') {
          this.emit({ type: 'tool_phase', runId: message.runId })
          return
        }
        if (decision.type === 'done') {
          this.emit({
            type: 'done',
            runId: message.runId,
            reason: decision.reason,
          })
          return
        }
        this.emit({
          type: 'llm_request',
          runId: message.runId,
          iteration: decision.nextIteration,
        })
        return
      }
      case 'tool_result': {
        if (!this.state || this.state.runId !== message.runId) return
        if (this.state.aborted) {
          this.emit({ type: 'done', runId: message.runId, reason: 'aborted' })
          return
        }

        const decision = decideAfterToolResult({
          hasPendingTools: message.hasPendingTools,
          iteration: this.state.iteration,
          maxIterations: this.state.maxIterations,
        })

        if (decision.type === 'done') {
          this.emit({
            type: 'done',
            runId: message.runId,
            reason: decision.reason,
          })
          return
        }

        this.emit({
          type: 'llm_request',
          runId: message.runId,
          iteration: decision.nextIteration,
        })
      }
    }
  }

  private emit(message: AgentWorkerOutbound): void {
    this.subscribers.forEach((cb) => {
      cb(message)
    })
  }
}

const createWebWorkerBridge = (): WorkerBridge | null => {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined') {
    return null
  }

  const blob = new Blob([WORKER_SCRIPT], {
    type: 'application/javascript',
  })
  const url = URL.createObjectURL(blob)

  try {
    const worker = new Worker(url)
    const subscribers = new Set<WorkerSubscriber>()

    worker.onmessage = (event: MessageEvent<AgentWorkerOutbound>) => {
      subscribers.forEach((cb) => {
        cb(event.data)
      })
    }

    return {
      postMessage: (message) => worker.postMessage(message),
      subscribe: (callback) => {
        subscribers.add(callback)
        return () => subscribers.delete(callback)
      },
      terminate: () => {
        subscribers.clear()
        worker.terminate()
        URL.revokeObjectURL(url)
      },
    }
  } catch {
    URL.revokeObjectURL(url)
    return null
  }
}

export const createAgentLoopWorker = (): WorkerBridge => {
  const webWorkerBridge = createWebWorkerBridge()
  if (webWorkerBridge) {
    return webWorkerBridge
  }

  const driver = new AgentLoopWorkerDriver()
  return {
    postMessage: (message) => driver.postMessage(message),
    subscribe: (callback) => driver.subscribe(callback),
    terminate: () => driver.terminate(),
  }
}
