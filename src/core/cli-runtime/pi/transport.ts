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

export type PiRpcTransportOptions = {
  /**
   * Protocol version to negotiate as soon as the agent announces itself with
   * a `ready` frame. omp caps every physical stdout frame at 1 MiB and only
   * splits an oversized response into reassemblable `rpc_chunk` frames once
   * the client opts in — without this, a large `get_available_models` comes
   * back as a plain "RPC response exceeded the transport limit" failure. pi
   * has neither the cap nor a `ready` frame, so it leaves this unset.
   */
  negotiateProtocolVersion?: number
}

/** In-flight reassembly of one oversized response split across `rpc_chunk`s. */
type ChunkAssembly = {
  chunkId: string
  count: number
  byteLength: number
  nextIndex: number
  parts: Uint8Array[]
  bytes: number
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
  private readonly negotiateProtocolVersion: number | undefined
  /**
   * Commands wait for the protocol handshake to settle, so the very first
   * request cannot go out on v1 and come back truncated. Open from the start
   * when there is nothing to negotiate — pi never sends a `ready` frame, so
   * waiting for one there would wedge the transport forever.
   */
  private outboundOpen: boolean
  private readonly outboundQueue: PiRpcRecord[] = []
  private negotiationId: string | null = null
  private maxReassembledBytes: number | null = null
  private assembly: ChunkAssembly | null = null

  constructor(
    private readonly process: PiProcessLike,
    options: PiRpcTransportOptions = {},
  ) {
    this.negotiateProtocolVersion = options.negotiateProtocolVersion
    this.outboundOpen = options.negotiateProtocolVersion === undefined
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
    if (!this.outboundOpen) {
      // Held until the handshake settles, then flushed in order. A request
      // queued here keeps the timeout it was created with, so a handshake
      // that never lands surfaces as that request timing out rather than as
      // a silent hang.
      this.outboundQueue.push(record)
      return
    }
    this.process.write(`${JSON.stringify(record)}\n`)
  }

  /** Bypasses the outbound gate — this is what opens it. */
  private writeHandshake(record: PiRpcRecord): void {
    if (this.fatalError || this.disposed) return
    this.process.write(`${JSON.stringify(record)}\n`)
  }

  private openOutbound(): void {
    if (this.outboundOpen) return
    this.outboundOpen = true
    const queued = this.outboundQueue.splice(0, this.outboundQueue.length)
    for (const record of queued) {
      if (this.fatalError || this.disposed) return
      this.process.write(`${JSON.stringify(record)}\n`)
    }
  }

  /**
   * omp announces its protocol range in a `ready` frame before it processes
   * any command. Answer it with the version we want; once the response lands
   * (either way) the queued commands go out.
   */
  private handleReady(record: PiRpcRecord): void {
    const version = this.negotiateProtocolVersion
    if (version === undefined || this.negotiationId !== null) return
    const supported = record.supportedProtocolVersions
    if (typeof record.maxReassembledFrameBytes === 'number') {
      this.maxReassembledBytes = record.maxReassembledFrameBytes
    }
    if (!Array.isArray(supported) || !supported.includes(version)) {
      // An agent that does not offer the version stays on whatever it
      // announced; oversized responses will fail loudly on their own.
      this.openOutbound()
      return
    }
    this.negotiationId = `pi_proto_${this.nextId++}`
    this.writeHandshake({
      id: this.negotiationId,
      type: 'negotiate_protocol',
      protocolVersion: version,
    })
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
    this.routeRecord(value)
  }

  private routeRecord(record: PiRpcRecord): void {
    if (record.type === 'rpc_chunk') {
      this.handleChunkFrame(record)
      return
    }

    if (record.type === 'ready') {
      this.handleReady(record)
    }

    if (record.type === 'response') {
      if (typeof record.id === 'string') {
        if (record.id === this.negotiationId) {
          this.openOutbound()
          return
        }
        this.handleResponse(record.id, record)
        return
      }
      // An agent may answer without echoing the id — omp reports an unknown
      // command that way. Correlate on the command name instead so the
      // request fails with what the agent actually said, rather than sitting
      // there until its timeout.
      const id = this.findPendingIdByCommand(record.command)
      if (id !== null) this.handleResponse(id, record)
      return
    }

    for (const listener of this.eventListeners) listener(record)
  }

  /**
   * Reassembles one logical frame from the `rpc_chunk` sequence a v2 agent
   * emits for a response too large for a physical frame. The sequence is
   * uninterrupted and in order by contract, so anything that breaks it —
   * a foreign `chunkId`, a gap in `index`, shifting header values, a total
   * over the advertised reassembly ceiling — drops the whole assembly rather
   * than yielding a half-parsed object.
   */
  private handleChunkFrame(record: PiRpcRecord): void {
    const { chunkId, index, count, byteLength, data } = record
    if (
      typeof chunkId !== 'string' ||
      typeof index !== 'number' ||
      typeof count !== 'number' ||
      typeof byteLength !== 'number' ||
      typeof data !== 'string' ||
      count <= 0 ||
      index < 0 ||
      index >= count ||
      byteLength < 0
    ) {
      this.assembly = null
      return
    }

    if (index === 0) {
      this.assembly =
        this.maxReassembledBytes !== null &&
        byteLength > this.maxReassembledBytes
          ? null
          : { chunkId, count, byteLength, nextIndex: 0, parts: [], bytes: 0 }
    }

    const assembly = this.assembly
    if (
      !assembly ||
      assembly.chunkId !== chunkId ||
      assembly.count !== count ||
      assembly.byteLength !== byteLength ||
      assembly.nextIndex !== index
    ) {
      this.assembly = null
      return
    }

    const bytes = decodeBase64(data)
    if (!bytes || assembly.bytes + bytes.length > byteLength) {
      this.assembly = null
      return
    }
    assembly.parts.push(bytes)
    assembly.bytes += bytes.length
    assembly.nextIndex += 1
    if (assembly.nextIndex < count) return

    this.assembly = null
    if (assembly.bytes !== byteLength) return
    const merged = new Uint8Array(assembly.bytes)
    let offset = 0
    for (const part of assembly.parts) {
      merged.set(part, offset)
      offset += part.length
    }
    let value: unknown
    try {
      value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(merged),
      )
    } catch {
      return
    }
    // A reassembled frame is a normal frame, but never another chunk — that
    // would be a sequence nested in itself.
    if (isPlainObject(value) && value.type !== 'rpc_chunk') {
      this.routeRecord(value)
    }
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

  /**
   * The one pending request for `command`, or null when the name is absent or
   * ambiguous — a guess between two same-named requests would resolve the
   * wrong one, and waiting for the timeout is the lesser harm.
   */
  private findPendingIdByCommand(command: unknown): string | null {
    if (typeof command !== 'string') return null
    let match: string | null = null
    for (const [id, pending] of this.pending) {
      if (pending.type !== command) continue
      if (match !== null) return null
      match = id
    }
    return match
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

/**
 * `atob` yields one code unit per byte, so the copy below is the byte array
 * itself — not a re-encode. Decoding to bytes (rather than a string) is what
 * lets a multi-byte character split across two chunks survive.
 */
const decodeBase64 = (value: string): Uint8Array | null => {
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  } catch {
    return null
  }
}
