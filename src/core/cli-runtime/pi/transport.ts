import type { PiProcessLike } from './process'

export type PiRpcRecord = Record<string, unknown>
export type PiRpcEventListener = (event: PiRpcRecord) => void
export type PiRpcFatalListener = (error: Error) => void

const DEFAULT_TIMEOUT_MS = 30_000

type PendingRequest = {
  type: string
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

export class PiRpcTransportDisposedError extends Error {
  constructor(message = 'pi RPC transport disposed') {
    super(message)
    this.name = 'PiRpcTransportDisposedError'
  }
}

export class PiRpcResponseError extends Error {
  constructor(
    readonly commandType: string,
    message: string,
  ) {
    super(message)
    this.name = 'PiRpcResponseError'
  }
}

/**
 * JSON-RPC-over-stdio-JSONL transport for `pi --mode rpc`.
 *
 * Framing rule (per pi's own docs): split incoming bytes on `\n` **only**
 * and strip one trailing `\r`. Never delegate to `readline` or a generic
 * line-terminator regex — JSON string values can legally contain literal
 * U+2028/U+2029 (`JSON.stringify` does not escape them), and anything that
 * treats those as line breaks will corrupt a frame mid-string.
 *
 * Requests: `{ id, type, ...payload }`.
 * Responses: `{ type: 'response', command, success, data?, error?, id }` —
 * the payload is read from `data` only (never a `result` field), and
 * `success === false` reads the message from `error`.
 * Every other line is broadcast to event listeners as-is.
 */
export class PiRpcTransport {
  private buffer = ''
  private nextId = 1
  private disposed = false
  private fatalError: Error | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private readonly eventListeners = new Set<PiRpcEventListener>()
  private readonly fatalListeners = new Set<PiRpcFatalListener>()
  private readonly removeDataListener: () => void
  private readonly removeExitListener: () => void

  constructor(private readonly process: PiProcessLike) {
    this.removeDataListener = process.onData((chunk) => this.handleChunk(chunk))
    this.removeExitListener = process.onExit(() => {
      const stderr = process.getStderrSnapshot()
      this.fail(
        new Error(
          stderr ? `pi process exited: ${stderr}` : 'pi process exited.',
        ),
      )
    })
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  getFatalError(): Error | null {
    return this.fatalError
  }

  request<T = unknown>(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    if (this.fatalError) return Promise.reject(this.fatalError)
    if (this.disposed) {
      return Promise.reject(new PiRpcTransportDisposedError())
    }
    const id = `pi_req_${this.nextId++}`
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? globalThis.setTimeout(() => {
              this.pending.delete(id)
              reject(
                new Error(`pi request timed out: ${type} (${timeoutMs}ms)`),
              )
            }, timeoutMs)
          : null
      this.pending.set(id, {
        type,
        resolve: (data) => resolve(data as T),
        reject,
        timer,
      })
      try {
        this.writeRecord({ id, type, ...payload })
      } catch (error) {
        this.pending.delete(id)
        if (timer !== null) globalThis.clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Fire-and-forget command (no `id`, no response tracking) — e.g. `abort`. */
  send(record: PiRpcRecord): void {
    if (this.disposed) return
    this.writeRecord(record)
  }

  onEvent(listener: PiRpcEventListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onFatal(listener: PiRpcFatalListener): () => void {
    if (this.fatalError) {
      const error = this.fatalError
      queueMicrotask(() => listener(error))
      return () => undefined
    }
    this.fatalListeners.add(listener)
    return () => this.fatalListeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.removeDataListener()
    this.removeExitListener()
    this.rejectAllPending(new PiRpcTransportDisposedError())
    this.eventListeners.clear()
    this.fatalListeners.clear()
  }

  private writeRecord(record: PiRpcRecord): void {
    if (this.fatalError) throw this.fatalError
    if (this.disposed) throw new PiRpcTransportDisposedError()
    this.process.write(`${JSON.stringify(record)}\n`)
  }

  private handleChunk(chunk: string): void {
    this.buffer += chunk
    while (true) {
      const newlineIndex = this.buffer.indexOf('\n')
      if (newlineIndex < 0) return
      let line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length > 0) this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return
    }
    if (!isPlainObject(value)) return

    if (value.type === 'response' && typeof value.id === 'string') {
      this.handleResponse(value.id, value)
      return
    }

    for (const listener of this.eventListeners) listener(value)
  }

  private handleResponse(id: string, record: PiRpcRecord): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (pending.timer !== null) globalThis.clearTimeout(pending.timer)

    if (record.success === false) {
      const message =
        typeof record.error === 'string'
          ? record.error
          : `pi command failed: ${pending.type}`
      pending.reject(new PiRpcResponseError(pending.type, message))
      return
    }

    pending.resolve(record.data)
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer !== null) globalThis.clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private fail(error: Error): void {
    if (this.fatalError || this.disposed) return
    this.fatalError = error
    this.rejectAllPending(error)
    for (const listener of this.fatalListeners) listener(error)
  }
}

const isPlainObject = (value: unknown): value is PiRpcRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
