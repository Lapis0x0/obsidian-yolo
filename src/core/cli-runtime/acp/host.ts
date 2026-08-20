/* eslint-disable @typescript-eslint/no-deprecated -- `ClientSideConnection` is the SDK's stable single-class
   client-side facade; the newer `client()`/context-builder API adds session-management helpers this host doesn't
   need, since orchestration already lives in `AcpCliRuntime`. See phase1-acp-hermes.md's SDK-adoption decision. */
import type {
  AgentCapabilities,
  Client,
  ClientSideConnection,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
} from '@agentclientprotocol/sdk'

import { buildCancelledApprovalOutcome } from './mapping'
import {
  AcpChildProcess,
  type AcpProcessLike,
  type AcpProcessOptions,
} from './process'
import { createAcpStream } from './transport'

export type AcpHostResolver = () => Promise<AcpHost>

/** One live ACP session's live-update sink, registered while it is bound. */
export type AcpSessionHandlers = Readonly<{
  onUpdate(update: SessionUpdate): void
  onRequestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse>
}>

export type AcpHostOptions = Readonly<{
  runtimeId: AcpProcessOptions['runtimeId']
  clientName: string
  /** Re-resolved right before each spawn so a later install/path-override change is picked up. */
  resolveProcessOptions: () => Promise<Omit<AcpProcessOptions, 'runtimeId'>>
  createProcess?: (options: AcpProcessOptions) => Promise<AcpProcessLike>
}>

/**
 * Owns one initialized ACP connection (one subprocess, one JSON-RPC
 * connection) shared by every session multiplexed over it — mirrors
 * `codex/host.ts`'s pooled app-server process, adapted to the ACP SDK's
 * typed `ClientSideConnection` instead of a hand-rolled request map.
 */
export class AcpHost {
  private process: AcpProcessLike | null = null
  private connection: ClientSideConnection | null = null
  private connectPromise: Promise<ClientSideConnection> | null = null
  private agentCapabilities: AgentCapabilities | undefined
  private readonly sessionHandlers = new Map<string, AcpSessionHandlers>()
  private readonly fatalListeners = new Set<(error: Error) => void>()
  private fatalError: Error | null = null
  private disposed = false

  constructor(private readonly options: AcpHostOptions) {}

  get capabilities(): AgentCapabilities | undefined {
    return this.agentCapabilities
  }

  /** Registers the live sink for one session id; returns the unregister function. */
  registerSession(sessionId: string, handlers: AcpSessionHandlers): () => void {
    this.sessionHandlers.set(sessionId, handlers)
    return () => {
      if (this.sessionHandlers.get(sessionId) === handlers) {
        this.sessionHandlers.delete(sessionId)
      }
    }
  }

  onFatal(listener: (error: Error) => void): () => void {
    if (this.fatalError) {
      const error = this.fatalError
      queueMicrotask(() => listener(error))
      return () => undefined
    }
    this.fatalListeners.add(listener)
    return () => this.fatalListeners.delete(listener)
  }

  async ensureReady(): Promise<void> {
    await this.getConnection()
  }

  /**
   * Runs one connection-bound call. The SDK rejects any in-flight call on its
   * own once the underlying stream closes (subprocess exit/crash), so no
   * extra fatal-race wrapper is needed here.
   */
  async call<T>(
    fn: (connection: ClientSideConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.getConnection()
    return fn(connection)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const process = this.process
    this.process = null
    this.connection = null
    this.sessionHandlers.clear()
    this.fatalListeners.clear()
    if (process) await process.shutdown()
  }

  private async getConnection(): Promise<ClientSideConnection> {
    if (this.disposed) throw new Error('ACP host is disposed.')
    if (this.connection) return this.connection
    if (this.connectPromise) return this.connectPromise
    const promise = this.connect()
    this.connectPromise = promise
    try {
      return await promise
    } finally {
      if (this.connectPromise === promise) this.connectPromise = null
    }
  }

  private async connect(): Promise<ClientSideConnection> {
    const sdk = await import('@agentclientprotocol/sdk')
    const createProcess =
      this.options.createProcess ??
      ((opts: AcpProcessOptions) => AcpChildProcess.start(opts))
    const processOptions: AcpProcessOptions = {
      runtimeId: this.options.runtimeId,
      ...(await this.options.resolveProcessOptions()),
    }
    if (this.disposed) throw new Error('ACP host is disposed.')
    const process = await createProcess(processOptions)
    if (this.disposed) {
      // `dispose()` ran while the process was spawning and found nothing to
      // shut down (`this.process` was still null at that point) — this
      // continuation owns cleanup instead of publishing a leaked process.
      await process.shutdown()
      throw new Error('ACP host is disposed.')
    }
    this.process = process
    process.onExit(() => {
      const stderr = process.getStderrSnapshot()
      this.handleFatal(
        new Error(
          stderr
            ? `${this.options.runtimeId} ACP process exited: ${stderr}`
            : `${this.options.runtimeId} ACP process exited.`,
        ),
      )
    })

    try {
      const stream = await createAcpStream(process)
      if (this.disposed) throw new Error('ACP host is disposed.')
      const connection = new sdk.ClientSideConnection(
        () => this.createClient(),
        stream,
      )
      const init = await connection.initialize({
        protocolVersion: sdk.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: this.options.clientName, version: '1.0.0' },
      })
      if (this.disposed) throw new Error('ACP host is disposed.')
      this.agentCapabilities = init.agentCapabilities
      this.connection = connection
      // A successful (re)connect supersedes any earlier fatal state.
      this.fatalError = null
      return connection
    } catch (error) {
      this.process = null
      await process.shutdown()
      throw error
    }
  }

  private createClient(): Client {
    return {
      requestPermission: async (params) => {
        const handlers = this.sessionHandlers.get(params.sessionId)
        if (!handlers) return buildCancelledApprovalOutcome()
        return handlers.onRequestPermission(params)
      },
      sessionUpdate: async (params) => {
        this.sessionHandlers.get(params.sessionId)?.onUpdate(params.update)
      },
    }
  }

  private handleFatal(error: Error): void {
    if (this.fatalError || this.disposed) return
    this.fatalError = error
    this.connection = null
    this.sessionHandlers.clear()
    for (const listener of this.fatalListeners) listener(error)
  }
}
/* eslint-enable @typescript-eslint/no-deprecated */

type AcpHostPoolEntry = {
  host: AcpHost
  refCount: number
}

/**
 * Keyed, reference-counted pool of `AcpHost`s. One key holds one live
 * subprocess+connection, shared by every caller currently holding a
 * reference to it; the host is disposed once the last reference is
 * released. Agent-agnostic: the key is an opaque string chosen entirely by
 * the caller (e.g. `hermes/factory.ts` keys by Hermes profile id) — this
 * pool has no notion of what it represents.
 *
 * Keying replaces the single shared host this pool used to hand out
 * unconditionally: two callers that need genuinely different agent
 * processes (e.g. two Hermes profiles open in different surfaces at once)
 * must not be forced to share one, since disposing it to switch would sever
 * whichever turn the other caller had in flight.
 */
export class AcpHostPool {
  private readonly entries = new Map<string, AcpHostPoolEntry>()

  constructor(
    private readonly createOptions: (key: string) => AcpHostOptions,
  ) {}

  /** Resolves `key`'s host, creating it on first use, and increments its reference count. */
  acquire = async (key: string): Promise<AcpHost> => {
    const entry = this.getOrCreateEntry(key)
    entry.refCount += 1
    return entry.host
  }

  /**
   * Releases one reference acquired via `acquire(key)`. Disposes and evicts
   * `key`'s host once no reference remains. A mismatched or already-released
   * key is a no-op (dispose() calling this defensively, or a runtime that
   * never actually acquired a host).
   */
  release(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.refCount -= 1
    if (entry.refCount > 0) return
    this.entries.delete(key)
    void entry.host.dispose()
  }

  /**
   * Ensures `key`'s host exists and is connected, without acquiring a
   * reference to it. A warmed host has no owner yet, so this must not go
   * through `acquire`/`release`: bumping and immediately dropping the
   * reference count would dispose the freshly-started process the instant
   * `warm()` returns, defeating the point of warming it up. The host stays
   * in the pool, unowned (`refCount: 0`), until a real `acquire()` claims it
   * or `dispose()` tears the whole pool down.
   */
  async warm(key: string): Promise<void> {
    const entry = this.getOrCreateEntry(key)
    await entry.host.ensureReady()
  }

  async dispose(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.allSettled(entries.map((entry) => entry.host.dispose()))
  }

  private getOrCreateEntry(key: string): AcpHostPoolEntry {
    const existing = this.entries.get(key)
    if (existing) return existing
    const created: AcpHostPoolEntry = {
      host: new AcpHost(this.createOptions(key)),
      refCount: 0,
    }
    this.entries.set(key, created)
    return created
  }
}
