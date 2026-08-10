import {
  CodexAppServerProcess,
  type CodexProcessLike,
  type CodexProcessOptions,
} from './process'
import type {
  CodexNotification,
  CodexServerRequest,
  JsonRpcId,
} from './protocol'
import { CodexRpcTransport, initializeCodexTransport } from './transport'

export type CodexHostResolver = () => Promise<CodexAppServerHost>

export type CodexAppServerHostOptions = CodexProcessOptions & {
  createProcess?: (options: CodexProcessOptions) => Promise<CodexProcessLike>
  /**
   * Re-resolves launch options right before each process spawn, so a CLI
   * installed or a path override changed after startup is picked up on the
   * next attempt without restarting Obsidian.
   */
  resolveProcessOptions?: () => Promise<CodexProcessOptions>
}

/** Owns one initialized app-server process shared by independent threads. */
export class CodexAppServerHost {
  private process: CodexProcessLike | null = null
  private transport: CodexRpcTransport | null = null
  private transportPromise: Promise<CodexRpcTransport> | null = null
  private readonly notificationListeners = new Set<
    (notification: CodexNotification) => void
  >()
  private readonly serverRequestListeners = new Set<
    (request: CodexServerRequest) => void
  >()
  private readonly fatalListeners = new Set<(error: Error) => void>()
  private disposed = false
  constructor(private readonly options: CodexAppServerHostOptions) {}

  ensureReady(): Promise<void> {
    return this.getTransport().then(() => undefined)
  }

  async request<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    return await (
      await this.getTransport()
    ).request<T>(method, params, timeoutMs)
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.transport?.respond(id, result)
  }

  respondError(
    id: JsonRpcId,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    this.transport?.respondError(id, code, message, data)
  }

  onNotification(
    listener: (notification: CodexNotification) => void,
  ): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  onServerRequest(listener: (request: CodexServerRequest) => void): () => void {
    this.serverRequestListeners.add(listener)
    return () => this.serverRequestListeners.delete(listener)
  }

  onFatal(listener: (error: Error) => void): () => void {
    this.fatalListeners.add(listener)
    return () => this.fatalListeners.delete(listener)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const process = this.process
    this.process = null
    this.transport?.dispose()
    this.transport = null
    this.notificationListeners.clear()
    this.serverRequestListeners.clear()
    this.fatalListeners.clear()
    if (process) await process.shutdown()
  }

  private async getTransport(): Promise<CodexRpcTransport> {
    if (this.disposed) throw new Error('Codex app-server host is disposed.')
    if (this.transport) return this.transport
    if (this.transportPromise) return this.transportPromise
    const promise = this.createTransport()
    this.transportPromise = promise
    try {
      return await promise
    } finally {
      if (this.transportPromise === promise) this.transportPromise = null
    }
  }

  private async createTransport(): Promise<CodexRpcTransport> {
    const createProcess =
      this.options.createProcess ??
      ((options: CodexProcessOptions) => CodexAppServerProcess.start(options))
    const processOptions = this.options.resolveProcessOptions
      ? { ...this.options, ...(await this.options.resolveProcessOptions()) }
      : this.options
    const process = await createProcess(processOptions)
    this.process = process
    const transport = new CodexRpcTransport(process)
    transport.onFatal((error) => this.handleFatal(transport, process, error))
    transport.onNotification((notification) => {
      for (const listener of this.notificationListeners) listener(notification)
    })
    transport.onServerRequest((request) => {
      for (const listener of this.serverRequestListeners) listener(request)
    })
    try {
      await initializeCodexTransport(transport)
      const fatalError = transport.getFatalError()
      if (fatalError) throw fatalError
      this.transport = transport
      return transport
    } catch (error) {
      transport.dispose()
      if (this.process === process) {
        this.process = null
        await process.shutdown()
      }
      throw error
    }
  }

  private handleFatal(
    transport: CodexRpcTransport,
    process: CodexProcessLike,
    error: Error,
  ): void {
    if (this.transport !== transport && this.process !== process) return
    if (this.transport === transport) this.transport = null
    if (this.process === process) this.process = null
    transport.dispose()
    void process.shutdown().catch(() => undefined)
    if (!this.disposed) {
      for (const listener of this.fatalListeners) listener(error)
    }
  }
}

export class CodexAppServerHostPool {
  private host: CodexAppServerHost | null = null

  constructor(private readonly processOptions: CodexAppServerHostOptions) {}

  readonly acquire: CodexHostResolver = async () => {
    this.host ??= new CodexAppServerHost(this.processOptions)
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
