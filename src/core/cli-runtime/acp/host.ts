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

export class AcpHostPool {
  private host: AcpHost | null = null

  constructor(private readonly options: AcpHostOptions) {}

  readonly acquire: AcpHostResolver = async () => {
    this.host ??= new AcpHost(this.options)
    return this.host
  }

  async warm(): Promise<void> {
    await (await this.acquire()).ensureReady()
  }

  async dispose(): Promise<void> {
    const host = this.host
    this.host = null
    if (host) await host.dispose()
  }
}
