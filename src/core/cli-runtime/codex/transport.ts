import type { CodexProcessLike } from './process'
import type {
  CodexNotification,
  CodexServerRequest,
  JsonRpcError,
  JsonRpcId,
} from './protocol'

type PendingRequest = {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

export type CodexNotificationListener = (
  notification: CodexNotification,
) => void
export type CodexServerRequestListener = (request: CodexServerRequest) => void
export type CodexTransportFatalListener = (error: Error) => void

export class CodexRpcTransport {
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly notificationListeners = new Set<CodexNotificationListener>()
  private readonly serverRequestListeners =
    new Set<CodexServerRequestListener>()
  private readonly fatalListeners = new Set<CodexTransportFatalListener>()
  private readonly removeLineListener: () => void
  private readonly removeExitListener: () => void
  private disposed = false
  private fatalError: Error | null = null

  constructor(private readonly process: CodexProcessLike) {
    this.removeLineListener = process.onLine((line) => this.handleLine(line))
    this.removeExitListener = process.onExit(() => {
      const stderr = process.getStderrSnapshot()
      this.fail(
        new Error(
          stderr
            ? `Codex app-server exited: ${stderr}`
            : 'Codex app-server exited.',
        ),
      )
    })
  }

  request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.fatalError) return Promise.reject(this.fatalError)
    if (this.disposed)
      return Promise.reject(new Error('Codex transport disposed.'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs
        ? globalThis.setTimeout(() => {
            this.pending.delete(id)
            reject(new Error(`Codex request timed out: ${method}`))
          }, timeoutMs)
        : null
      this.pending.set(id, {
        method,
        resolve: (result) => resolve(result as T),
        reject,
        timer,
      })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.send({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    })
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result })
  }

  respondError(
    id: JsonRpcId,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    this.send({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    })
  }

  onNotification(listener: CodexNotificationListener): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  onServerRequest(listener: CodexServerRequestListener): () => void {
    this.serverRequestListeners.add(listener)
    return () => this.serverRequestListeners.delete(listener)
  }

  onFatal(listener: CodexTransportFatalListener): () => void {
    if (this.fatalError) {
      const error = this.fatalError
      queueMicrotask(() => listener(error))
      return () => undefined
    }
    this.fatalListeners.add(listener)
    return () => this.fatalListeners.delete(listener)
  }

  getFatalError(): Error | null {
    return this.fatalError
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.removeLineListener()
    this.removeExitListener()
    this.rejectAll(new Error('Codex transport disposed.'))
    this.fatalListeners.clear()
  }

  private send(message: unknown): void {
    if (this.fatalError) throw this.fatalError
    if (this.disposed) throw new Error('Codex transport disposed.')
    this.process.write(`${JSON.stringify(message)}\n`)
  }

  private handleLine(line: string): void {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const message = value as Record<string, unknown>
    const id = message.id
    const method = message.method

    if (typeof id === 'number' && typeof method !== 'string') {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      if (pending.timer !== null) globalThis.clearTimeout(pending.timer)
      if (message.error) {
        const error = message.error as JsonRpcError
        pending.reject(new Error(`${pending.method}: ${error.message}`))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (typeof method !== 'string') return
    const params =
      message.params && typeof message.params === 'object'
        ? (message.params as Record<string, unknown>)
        : {}
    if (id === undefined) {
      for (const listener of this.notificationListeners) {
        listener({ method, params })
      }
      return
    }
    if (typeof id === 'string' || typeof id === 'number') {
      for (const listener of this.serverRequestListeners) {
        listener({ id, method, params })
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer !== null) globalThis.clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private fail(error: Error): void {
    if (this.fatalError || this.disposed) return
    this.fatalError = error
    this.rejectAll(error)
    for (const listener of this.fatalListeners) listener(error)
  }
}

export const initializeCodexTransport = async (
  transport: CodexRpcTransport,
): Promise<void> => {
  await transport.request('initialize', {
    clientInfo: { name: 'obsidian-yolo', version: '1.0.0' },
    capabilities: { experimentalApi: true },
  })
  transport.notify('initialized')
}
