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

self.onmessage = (event) => {
  const message = event.data
  try {
    switch (message.type) {
      case 'start': {
        if (!message.hasTools) {
          emit({ type: 'done', runId: message.runId, reason: 'no_tools' })
          return
        }
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
        if (!message.hasToolCalls) {
          emit({ type: 'done', runId: message.runId, reason: 'completed' })
          return
        }
        emit({ type: 'tool_phase', runId: message.runId })
        return
      }
      case 'tool_result': {
        if (!state || state.runId !== message.runId) return
        if (state.aborted) {
          emit({ type: 'done', runId: message.runId, reason: 'aborted' })
          return
        }
        if (message.hasPendingTools) {
          emit({ type: 'done', runId: message.runId, reason: 'completed' })
          return
        }
        if (state.iteration >= state.maxIterations) {
          emit({ type: 'done', runId: message.runId, reason: 'max_iterations' })
          return
        }
        emit({
          type: 'llm_request',
          runId: message.runId,
          iteration: state.iteration + 1,
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
        if (!message.hasTools) {
          this.emit({
            type: 'done',
            runId: message.runId,
            reason: 'no_tools',
          })
          return
        }

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
        if (!message.hasToolCalls) {
          this.emit({ type: 'done', runId: message.runId, reason: 'completed' })
          return
        }
        this.emit({ type: 'tool_phase', runId: message.runId })
        return
      }
      case 'tool_result': {
        if (!this.state || this.state.runId !== message.runId) return
        if (this.state.aborted) {
          this.emit({ type: 'done', runId: message.runId, reason: 'aborted' })
          return
        }

        if (message.hasPendingTools) {
          this.emit({ type: 'done', runId: message.runId, reason: 'completed' })
          return
        }

        if (this.state.iteration >= this.state.maxIterations) {
          this.emit({
            type: 'done',
            runId: message.runId,
            reason: 'max_iterations',
          })
          return
        }

        this.emit({
          type: 'llm_request',
          runId: message.runId,
          iteration: this.state.iteration + 1,
        })
      }
    }
  }

  private emit(message: AgentWorkerOutbound): void {
    this.subscribers.forEach((cb) => cb(message))
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
      subscribers.forEach((cb) => cb(event.data))
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
