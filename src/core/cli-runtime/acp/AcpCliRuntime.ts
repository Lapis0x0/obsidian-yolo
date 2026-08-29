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
  CliRuntimeModel,
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
  extractAcpSessionModelState,
  mapAcpTurnUsage,
  mapAcpUsageUpdate,
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
  /**
   * Agent-provided manual-compaction slash command (see
   * `AcpAgentProfile.compactCommand`). Absent means the connected agent has
   * no such affordance and `compact()` throws.
   */
  compactCommand?: string
  /**
   * Optional recovery for when resuming a stored session fails to load
   * (e.g. the process/place it lived in is no longer reachable).
   * `AcpCliRuntime` has no notion of what `resolveHost` here represents (a
   * Hermes profile, etc) — it only knows that when `loadSession` throws, it
   * can ask this for a different host and start a fresh session there
   * instead of failing outright. Supplied by the owning factory (e.g.
   * `hermes/factory.ts`, which points it at the default-profile host).
   */
  sessionRecovery?: Readonly<{ resolveHost: AcpHostResolver }>
  /**
   * Paired with `resolveHost`/`sessionRecovery.resolveHost` for pooled
   * hosts: called once during `dispose()` to release every reference this
   * runtime instance acquired, so a shared pool (e.g. Hermes's per-profile
   * `AcpHostPool`) can reclaim hosts once nothing still binds them. No-op
   * when hosts are not pooled (`resolveHost` absent).
   */
  releaseHost?: () => void
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
  private models: CliRuntimeModel[] = []
  private modelId: string | null = null
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
   *
   * `ref` is always a session to resume (there is no "start fresh" call
   * here), so resolving/readying the host is inside the same recovery net as
   * `loadSession` below: the most common trigger for recovery is a deleted
   * Hermes profile, and `hermes -p <deleted> acp` exits *before* the ACP
   * handshake completes — i.e. `getHost()` itself throws, not `loadSession`.
   * A recovery failure still propagates as-is; only `sessionRecovery` being
   * absent (a runtime with no fallback) rethrows the original error.
   */
  async openSession(ref: CliSessionRef): Promise<CliSessionHydration> {
    if (ref.runtimeId !== this.runtimeId) {
      throw new Error(`Cannot open a non-${this.runtimeId} session.`)
    }
    let host: AcpHost
    try {
      host = await this.getHost()
    } catch (error) {
      if (!this.options.sessionRecovery) throw error
      return this.recoverSession(ref)
    }
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
      const response = await host.call((connection) =>
        connection.loadSession({
          sessionId: ref.nativeSessionId,
          cwd: this.options.cwd,
          mcpServers: [],
        }),
      )
      this.captureModelState(response)
    } catch (error) {
      unregister()
      if (!this.options.sessionRecovery) throw error
      return this.recoverSession(ref)
    }
    unregister()
    return { ref, messages, compactionBoundaries: [] }
  }

  async ensureReady(input: CliRuntimeReadyInput): Promise<void> {
    const previousHost = this.host
    let host: AcpHost
    try {
      host = await this.getHost()
    } catch (error) {
      // A brand-new session (no `sessionRef`) has nothing to recover into —
      // only a resume in progress falls back to `sessionRecovery`. Same
      // trigger as `openSession`'s doc comment: the host can fail before an
      // ACP session is even in play (e.g. a deleted Hermes profile's process
      // exiting pre-handshake).
      if (!input.sessionRef || !this.options.sessionRecovery) throw error
      await this.bindRecoveredSession(input.sessionRef)
      return
    }
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
      this.captureModelState(response)
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
      try {
        const response = await host.call((connection) =>
          connection.loadSession({
            sessionId: input.sessionRef!.nativeSessionId,
            cwd: this.options.cwd,
            mcpServers: [],
          }),
        )
        this.captureModelState(response)
      } catch (error) {
        if (!this.options.sessionRecovery) throw error
        await this.bindRecoveredSession(input.sessionRef)
        return
      }
    }
    this.bindSession(host, input.sessionRef)
  }

  async getConfiguration(
    cachedModels?: readonly CliRuntimeModel[],
  ): Promise<CliRuntimeConfiguration> {
    const models = this.models.length ? this.models : [...(cachedModels ?? [])]
    return { models, modelId: this.modelId, reasoningEffort: null }
  }

  async updateConfiguration(
    update: CliRuntimeConfigurationUpdate,
  ): Promise<CliRuntimeConfiguration> {
    // Model selection goes through ACP's `session/set_model` extension when
    // the agent reported a model list; reasoning has no ACP surface, so that
    // part of the update is ignored. A `null` modelId means "keep the agent's
    // own selection" — the protocol has no way to unset a model.
    const modelId = update.modelId
    if (modelId && modelId !== this.modelId && this.activeSessionRef) {
      const host = await this.getHost()
      const sessionId = this.activeSessionRef.nativeSessionId
      await host.call((connection) =>
        connection.request('session/set_model', { sessionId, modelId }),
      )
      this.modelId = modelId
    }
    return this.getConfiguration()
  }

  private captureModelState(response: unknown): void {
    const state = extractAcpSessionModelState(response)
    if (!state) return
    this.models = state.models
    this.modelId = state.currentModelId ?? this.modelId
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
    const startedAt = Date.now()
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
      // Before the terminal run state, which closes the turn's metrics window.
      // ACP has no turn-duration field, so it is measured around the prompt
      // call the same way Codex measures its own.
      this.emit({
        type: 'turn_metrics',
        durationMs: Math.max(0, Date.now() - startedAt),
        ...(result.usage ? { usage: mapAcpTurnUsage(result.usage) } : {}),
      })
      this.emit({
        type: 'run_state',
        state: aborted ? 'aborted' : 'completed',
      })
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

  /**
   * ACP has no dedicated compaction call, so this sends the agent's
   * compaction slash command (`AcpAgentProfile.compactCommand`, e.g.
   * Hermes's `/compress`) as an ordinary `session/prompt`. The live
   * aggregator already suppresses the resulting `user_message_chunk` echo
   * (see `mapping.ts`), so this never renders as a user turn; the agent's
   * text reply — success summary or failure reason — still renders as a
   * normal assistant message.
   *
   * Hermes reports no structured compaction event, only prose whose wording
   * may change at any time, so this never parses the reply to judge success.
   * It synthesizes `compaction_boundary` once the round trip resolves
   * without throwing; a failed compression still draws the divider, with
   * the reason left visible in the reply above it.
   */
  async compact(): Promise<void> {
    if (!this.activeSessionRef) {
      throw new Error(`${this.runtimeId} runtime is not ready.`)
    }
    const compactCommand = this.options.compactCommand
    if (!compactCommand) {
      throw new Error(`${this.runtimeId} does not support compaction.`)
    }
    const host = await this.getHost()
    const sessionId = this.activeSessionRef.nativeSessionId
    this.aggregator.beginTurn()
    await host.call((connection) =>
      connection.prompt({
        sessionId,
        prompt: toAcpPromptBlocks(compactCommand),
      }),
    )
    this.emit({
      type: 'compaction_boundary',
      boundary: {
        id: `${this.runtimeId}-compact-${Date.now()}`,
        trigger: 'manual',
      },
    })
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
    if (host) {
      if (this.ownsHost) await host.dispose()
      else this.options.releaseHost?.()
    }
    this.listeners.clear()
  }

  private emit(event: CliRuntimeEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private bindSession(
    host: AcpHost,
    ref: CliSessionRef,
    fallbackFrom?: CliSessionRef,
  ): void {
    this.unregisterSession?.()
    this.aggregator.reset()
    this.activeSessionRef = ref
    this.unregisterSession = host.registerSession(ref.nativeSessionId, {
      onUpdate: (update) => {
        // Carries context pressure rather than transcript content, so it never
        // reaches the message aggregator.
        if (update.sessionUpdate === 'usage_update') {
          const usage = mapAcpUsageUpdate(update)
          if (usage) this.emit({ type: 'context_usage', usage })
          return
        }
        for (const message of this.aggregator.apply(update, this.runtimeId)) {
          this.emit({ type: 'message_upsert', message })
        }
      },
      onRequestPermission: (request) => this.handleRequestPermission(request),
    })
    this.emit({
      type: 'session_bound',
      ref,
      ...(fallbackFrom ? { fallbackFrom } : {}),
    })
  }

  /**
   * `openSession`'s recovery path: the requested session's host is
   * unreachable, so this tries `sessionRecovery.resolveHost()` and starts a
   * brand-new session there instead. The candidate host only becomes
   * `this.host` (via `attachHost`) once starting that session actually
   * succeeds — `host.call()` already readies the connection on its own, so
   * nothing here needs to touch runtime state before that succeeds. A
   * candidate that itself fails to produce a session must leave `this.host`,
   * its fatal listener, and any live session binding exactly as they were:
   * publishing a broken host as the primary one would strand a retry on it
   * instead of letting it re-resolve (and reuse, if still good) the original
   * host.
   */
  private async recoverSession(
    requestedRef: CliSessionRef,
  ): Promise<CliSessionHydration> {
    const host = await this.options.sessionRecovery!.resolveHost()
    const response = await host.call((connection) =>
      connection.newSession({ cwd: this.options.cwd, mcpServers: [] }),
    )
    await this.attachHost(host, false)
    this.captureModelState(response)
    const ref: CliSessionRef = {
      runtimeId: this.runtimeId,
      nativeSessionId: response.sessionId,
    }
    return {
      ref,
      messages: [],
      compactionBoundaries: [],
      sessionFallback: { requestedRef },
    }
  }

  /** `ensureReady`'s recovery path: same idea as `recoverSession`, but binds the fresh session live instead of returning a read-only peek. */
  private async bindRecoveredSession(
    requestedRef: CliSessionRef,
  ): Promise<void> {
    const host = await this.options.sessionRecovery!.resolveHost()
    const response = await host.call((connection) =>
      connection.newSession({ cwd: this.options.cwd, mcpServers: [] }),
    )
    await this.attachHost(host, false)
    this.captureModelState(response)
    this.bindSession(
      host,
      { runtimeId: this.runtimeId, nativeSessionId: response.sessionId },
      requestedRef,
    )
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
    if (this.host) {
      await this.host.ensureReady()
      return this.host
    }
    const host = this.options.resolveHost
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
    return this.attachHost(host, !this.options.resolveHost)
  }

  /**
   * Publishes `host` as `this.host` (unless it already is) and readies it.
   * Shared by `getHost()` and the `sessionRecovery` fallback paths so a
   * switch to a different host is picked up by every subsequent call
   * (`sendTurn`, `cancel`, ...), not just the one that triggered the switch.
   */
  private async attachHost(host: AcpHost, ownsHost: boolean): Promise<AcpHost> {
    if (this.host !== host) {
      this.detachFatal?.()
      this.host = host
      this.ownsHost = ownsHost
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
