import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk'

import type { ChatMessage } from '../../../types/chat'
import type {
  CliApprovalResponse,
  CliQuestionResponse,
  CliRewriteTurnInput,
  CliRuntime,
  CliRuntimeConfiguration,
  CliRuntimeConfigurationUpdate,
  CliRuntimeEvent,
  CliRuntimeEventListener,
  CliRuntimeId,
  CliRuntimeReadyInput,
  CliSessionHydration,
  CliSessionRef,
  CliTurnInput,
} from '../types'

import { AcpHost, type AcpHostOptions, type AcpHostResolver } from './host'
import {
  AcpSessionAggregator,
  buildCancelledApprovalOutcome,
  buildPendingApprovalMessages,
  resolveApprovalOptionId,
  toAcpPromptBlocks,
  upsertAcpMessage,
} from './mapping'

export type AcpCliRuntimeOptions = Readonly<{
  /** Only used by the own-host fallback below (tests, or no shared pool). */
  command?: string
  args?: string[]
  cwd: string
  env?: Record<string, string>
  clientName?: string
  resolveHost?: AcpHostResolver
  createProcess?: AcpHostOptions['createProcess']
}>

type PendingApproval = {
  options: readonly PermissionOption[]
  resolve: (response: RequestPermissionResponse) => void
}

/**
 * Generic ACP-backed `CliRuntime`. Agent-agnostic: it never checks
 * `runtimeId` against a specific agent, never imports a `hermes/*` module,
 * and gets everything agent-specific (binary discovery, launch args) through
 * the `resolveHost`/`createProcess` options its factory supplies.
 */
export class AcpCliRuntime implements CliRuntime {
  private readonly listeners = new Set<CliRuntimeEventListener>()
  private readonly aggregator = new AcpSessionAggregator()
  private readonly pendingApprovals = new Map<string, PendingApproval>()

  private host: AcpHost | null = null
  private ownsHost = false
  private detachFatal: (() => void) | null = null
  private unregisterSession: (() => void) | null = null
  private activeSessionRef: CliSessionRef | null = null
  private turnInFlight = false
  private cancelRequested = false
  private disposed = false

  constructor(
    readonly runtimeId: CliRuntimeId,
    private readonly options: AcpCliRuntimeOptions,
  ) {}

  /**
   * Read-only peek used to populate the transcript before the session is
   * bound live. ACP has no separate "read without resuming" method — loading
   * a session is what streams its history — so this uses a scoped listener
   * instead of the live one, and `ensureReady` still (re)loads the session
   * itself before the first turn. Loading history twice on the one occasion
   * a stored conversation is reopened is the accepted cost of never silently
   * skipping the load a fresh host generation needs.
   */
  async openSession(ref: CliSessionRef): Promise<CliSessionHydration> {
    if (ref.runtimeId !== this.runtimeId) {
      throw new Error(`Cannot open a non-${this.runtimeId} session.`)
    }
    const host = await this.getHost()
    if (!host.capabilities?.loadSession) {
      // Agent can't replay history; ensureReady will start a fresh session.
      return { ref, messages: [], compactionBoundaries: [] }
    }

    const aggregator = new AcpSessionAggregator('replay')
    const messages: ChatMessage[] = []
    const unregister = host.registerSession(ref.nativeSessionId, {
      onUpdate: (update) => {
        for (const message of aggregator.apply(update, this.runtimeId)) {
          upsertAcpMessage(messages, message)
        }
      },
      onRequestPermission: async () => buildCancelledApprovalOutcome(),
    })
    try {
      await host.call((connection) =>
        connection.loadSession({
          sessionId: ref.nativeSessionId,
          cwd: this.options.cwd,
          mcpServers: [],
        }),
      )
    } finally {
      unregister()
    }
    return { ref, messages, compactionBoundaries: [] }
  }

  async ensureReady(input: CliRuntimeReadyInput): Promise<void> {
    const previousHost = this.host
    const host = await this.getHost()
    if (
      this.activeSessionRef &&
      input.sessionRef?.nativeSessionId ===
        this.activeSessionRef.nativeSessionId &&
      previousHost === host
    ) {
      return
    }

    if (!input.sessionRef) {
      const response = await host.call((connection) =>
        connection.newSession({ cwd: this.options.cwd, mcpServers: [] }),
      )
      this.bindSession(host, {
        runtimeId: this.runtimeId,
        nativeSessionId: response.sessionId,
      })
      return
    }

    if (input.sessionRef.runtimeId !== this.runtimeId) {
      throw new Error(`Cannot resume a non-${this.runtimeId} session.`)
    }
    if (host.capabilities?.loadSession) {
      await host.call((connection) =>
        connection.loadSession({
          sessionId: input.sessionRef!.nativeSessionId,
          cwd: this.options.cwd,
          mcpServers: [],
        }),
      )
    }
    this.bindSession(host, input.sessionRef)
  }

  async getConfiguration(): Promise<CliRuntimeConfiguration> {
    return { models: [], modelId: null, reasoningEffort: null }
  }

  async updateConfiguration(
    _update: CliRuntimeConfigurationUpdate,
  ): Promise<CliRuntimeConfiguration> {
    // Model/reasoning selection is delegated entirely to the agent's own
    // configuration; the main-input controls are hidden via capabilities.
    return this.getConfiguration()
  }

  async sendTurn(input: CliTurnInput): Promise<void> {
    if (!this.activeSessionRef) {
      throw new Error(`${this.runtimeId} runtime is not ready.`)
    }
    if (
      input.sessionRef &&
      input.sessionRef.nativeSessionId !== this.activeSessionRef.nativeSessionId
    ) {
      throw new Error(
        `${this.runtimeId} session must be resumed with ensureReady before sending.`,
      )
    }
    const host = await this.getHost()
    const sessionId = this.activeSessionRef.nativeSessionId
    this.cancelRequested = false
    this.aggregator.beginTurn()
    this.emit({ type: 'run_state', state: 'running' })
    this.turnInFlight = true
    try {
      const result = await host.call((connection) =>
        connection.prompt({
          sessionId,
          prompt: toAcpPromptBlocks(input.content),
        }),
      )
      this.turnInFlight = false
      // `cancel()` may have already resolved a pending approval as
      // cancelled and raced the agent to `end_turn` before `session/cancel`
      // was processed — once cancellation was requested for this turn, its
      // outcome can only be `aborted`, regardless of what `stopReason` the
      // (possibly racing) prompt response reports.
      const aborted = this.cancelRequested || result.stopReason === 'cancelled'
      this.emit({
        type: 'run_state',
        state: aborted ? 'aborted' : 'completed',
      })
      if (result.usage) {
        this.emit({
          type: 'turn_metrics',
          usage: {
            prompt_tokens: result.usage.inputTokens,
            completion_tokens: result.usage.outputTokens,
            total_tokens: result.usage.totalTokens,
          },
        })
      }
    } catch (error) {
      this.turnInFlight = false
      throw error
    }
  }

  async rewriteTurn(_input: CliRewriteTurnInput): Promise<void> {
    throw new Error(
      `${this.runtimeId} does not support rewriting a sent message.`,
    )
  }

  async cancel(): Promise<void> {
    if (!this.activeSessionRef) return
    // Set before releasing pending approvals: an agent that reacts to the
    // cancelled approval by finishing the prompt with a non-`cancelled`
    // `stopReason` must still have this turn resolve as `aborted`, not race
    // `sendTurn()` to `completed`.
    this.cancelRequested = true
    for (const pending of this.pendingApprovals.values()) {
      pending.resolve(buildCancelledApprovalOutcome())
    }
    this.pendingApprovals.clear()
    if (!this.turnInFlight) return
    const host = await this.getHost()
    const sessionId = this.activeSessionRef.nativeSessionId
    await host.call((connection) => connection.cancel({ sessionId }))
  }

  async respondApproval(response: CliApprovalResponse): Promise<boolean> {
    const pending = this.pendingApprovals.get(response.requestId)
    if (!pending) return false
    this.pendingApprovals.delete(response.requestId)
    const optionId = resolveApprovalOptionId(pending.options, response.decision)
    pending.resolve(
      optionId
        ? { outcome: { outcome: 'selected', optionId } }
        : buildCancelledApprovalOutcome(),
    )
    return true
  }

  async respondQuestion(_response: CliQuestionResponse): Promise<boolean> {
    return false
  }

  subscribe(listener: CliRuntimeEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unregisterSession?.()
    this.unregisterSession = null
    this.detachFatal?.()
    this.detachFatal = null
    for (const pending of this.pendingApprovals.values()) {
      pending.resolve(buildCancelledApprovalOutcome())
    }
    this.pendingApprovals.clear()
    const host = this.host
    this.host = null
    if (host && this.ownsHost) await host.dispose()
    this.listeners.clear()
  }

  private emit(event: CliRuntimeEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private bindSession(host: AcpHost, ref: CliSessionRef): void {
    this.unregisterSession?.()
    this.aggregator.reset()
    this.activeSessionRef = ref
    this.unregisterSession = host.registerSession(ref.nativeSessionId, {
      onUpdate: (update) => {
        for (const message of this.aggregator.apply(update, this.runtimeId)) {
          this.emit({ type: 'message_upsert', message })
        }
      },
      onRequestPermission: (request) => this.handleRequestPermission(request),
    })
    this.emit({ type: 'session_bound', ref })
  }

  private async handleRequestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const [assistant, tool] = buildPendingApprovalMessages(
      request,
      this.runtimeId,
    )
    this.emit({ type: 'message_upsert', message: assistant })
    this.emit({ type: 'message_upsert', message: tool })
    this.emit({ type: 'run_state', state: 'waiting_for_approval' })
    return new Promise<RequestPermissionResponse>((resolve) => {
      this.pendingApprovals.set(request.toolCall.toolCallId, {
        options: request.options,
        resolve,
      })
    })
  }

  private async getHost(): Promise<AcpHost> {
    if (this.disposed) {
      throw new Error(`${this.runtimeId} CLI runtime has been disposed.`)
    }
    const host = this.host
      ? this.host
      : this.options.resolveHost
        ? await this.options.resolveHost()
        : new AcpHost({
            runtimeId: this.runtimeId,
            clientName: this.options.clientName ?? 'obsidian-yolo',
            resolveProcessOptions: async () => ({
              command: this.options.command ?? '',
              args: this.options.args ?? [],
              cwd: this.options.cwd,
              env: this.options.env,
            }),
            createProcess: this.options.createProcess,
          })
    if (this.host !== host) {
      this.detachFatal?.()
      this.host = host
      this.ownsHost = !this.options.resolveHost
      this.detachFatal = host.onFatal((error) => this.handleHostFatal(error))
    }
    await host.ensureReady()
    return host
  }

  private handleHostFatal(error: Error): void {
    this.unregisterSession?.()
    this.unregisterSession = null
    this.activeSessionRef = null
    this.turnInFlight = false
    for (const pending of this.pendingApprovals.values()) {
      pending.resolve(buildCancelledApprovalOutcome())
    }
    this.pendingApprovals.clear()
    if (!this.disposed) {
      this.emit({ type: 'run_state', state: 'error', error: error.message })
    }
  }
}
