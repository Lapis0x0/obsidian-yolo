import type { CliAssistantBinding } from '../types'

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

export type CodexSkillProfile = Readonly<{
  id: string
  roots: readonly string[]
  skillPaths: ReadonlyMap<string, string>
}>

export type CodexHostResolver = (
  assistant?: CliAssistantBinding,
) => Promise<CodexAppServerHost>

export type CodexAppServerHostOptions = CodexProcessOptions & {
  skillProfile?: CodexSkillProfile
  createProcess?: (options: CodexProcessOptions) => Promise<CodexProcessLike>
}

/** Owns one initialized app-server process and its process-global profile. */
export class CodexAppServerHost {
  profileId: string
  skillPaths: ReadonlyMap<string, string>

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
  private skillProfile: CodexSkillProfile | undefined
  private hasThreadActivity = false

  constructor(private readonly options: CodexAppServerHostOptions) {
    this.profileId = options.skillProfile?.id ?? 'default'
    this.skillProfile = options.skillProfile
    this.skillPaths =
      options.skillProfile?.skillPaths ?? new Map<string, string>()
  }

  ensureReady(): Promise<void> {
    return this.getTransport().then(() => undefined)
  }

  async adoptSkillProfile(profile: CodexSkillProfile): Promise<void> {
    if (this.profileId !== 'default') {
      if (this.profileId !== profile.id) {
        throw new Error('A Codex Host cannot change its active Skill profile.')
      }
      return
    }
    this.profileId = profile.id
    this.skillProfile = profile
    this.skillPaths = profile.skillPaths
    if (this.transport) {
      await this.transport.request('skills/extraRoots/set', {
        extraRoots: [...profile.roots],
      })
    }
  }

  async request<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    if (
      method === 'thread/start' ||
      method === 'thread/resume' ||
      method === 'turn/start'
    ) {
      this.hasThreadActivity = true
    }
    return await (
      await this.getTransport()
    ).request<T>(method, params, timeoutMs)
  }

  canAdoptSkillProfile(): boolean {
    return this.profileId === 'default' && !this.hasThreadActivity
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
    const process = await createProcess(this.options)
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
      const roots = [...(this.skillProfile?.roots ?? [])]
      if (roots.length > 0) {
        await transport.request('skills/extraRoots/set', { extraRoots: roots })
      }
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
  private readonly hosts = new Map<string, CodexAppServerHost>()
  private readonly profilePromises = new Map<
    string,
    Promise<CodexSkillProfile>
  >()

  constructor(
    private readonly processOptions: Omit<
      CodexAppServerHostOptions,
      'skillProfile'
    >,
    private readonly resolveSkillProfile?: (
      assistant: CliAssistantBinding,
    ) => Promise<CodexSkillProfile>,
  ) {}

  readonly acquire: CodexHostResolver = async (assistant) => {
    if (!assistant) {
      const existingHost = this.hosts.values().next().value as
        | CodexAppServerHost
        | undefined
      if (existingHost) return existingHost
    }
    const profile =
      assistant && this.resolveSkillProfile
        ? await this.resolveProfile(assistant)
        : undefined
    const key = profile?.id ?? 'default'
    const existing = this.hosts.get(key)
    if (existing) return existing
    const defaultCandidate = profile ? this.hosts.get('default') : undefined
    const defaultHost = defaultCandidate?.canAdoptSkillProfile()
      ? defaultCandidate
      : undefined
    if (profile && defaultHost) {
      this.hosts.delete('default')
      this.hosts.set(key, defaultHost)
      try {
        await defaultHost.adoptSkillProfile(profile)
        return defaultHost
      } catch (error) {
        if (this.hosts.get(key) === defaultHost) this.hosts.delete(key)
        await defaultHost.dispose().catch(() => undefined)
        throw error
      }
    }
    const host = new CodexAppServerHost({
      ...this.processOptions,
      ...(profile ? { skillProfile: profile } : {}),
    })
    this.hosts.set(key, host)
    return host
  }

  async warm(assistant?: CliAssistantBinding): Promise<void> {
    await (await this.acquire(assistant)).ensureReady()
  }

  invalidateSkillProfiles(): void {
    this.profilePromises.clear()
  }

  async dispose(): Promise<void> {
    const hosts = [...this.hosts.values()]
    this.hosts.clear()
    const results = await Promise.allSettled(
      hosts.map((host) => host.dispose()),
    )
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failure) throw failure.reason
  }

  private resolveProfile(
    assistant: CliAssistantBinding,
  ): Promise<CodexSkillProfile> {
    const key = JSON.stringify(assistant)
    const existing = this.profilePromises.get(key)
    if (existing) return existing
    const promise = this.resolveSkillProfile!(assistant).catch((error) => {
      if (this.profilePromises.get(key) === promise) {
        this.profilePromises.delete(key)
      }
      throw error
    })
    this.profilePromises.set(key, promise)
    return promise
  }
}
