import type { App } from 'obsidian'

import { loadDesktopNodeModule } from '../../../utils/platform/desktopNodeModule'
import { getCliPathOverride } from '../cli-path-override'
import { loadLoginShellEnvironment } from '../login-shell-env'
import { includeActiveCliModel } from '../model-catalog'
import type {
  CliApprovalResponse,
  CliPermissionProfileUpdate,
  CliQuestionResponse,
  CliRewriteTurnInput,
  CliRuntime,
  CliRuntimeConfiguration,
  CliRuntimeConfigurationUpdate,
  CliRuntimeEvent,
  CliRuntimeEventListener,
  CliRuntimeModel,
  CliRuntimeReadyInput,
  CliSessionHydration,
  CliSessionRef,
  CliTurnInput,
} from '../types'

import {
  type PiMappingState,
  buildPiForkSessionContent,
  collectPiForkRawEntries,
  createPiMappingState,
  decodePiModelId,
  extractPiContextWindow,
  extractPiCurrentModelState,
  extractPiSessionIdentity,
  getPiTerminalErrorMessage,
  isPiAgentSettled,
  mapPiEntriesToHydration,
  mapPiEvent,
  mapPiModels,
  resetPiMappingState,
  resolvePiRewriteCheckpoint,
  toPiPrompt,
} from './mapping'
import { PiSubprocess } from './process'
import { resolvePiCommand } from './resolve-command'
import type { PiRpcRecord } from './transport'
import { PiRpcTransport } from './transport'

export type PiCliRuntimeOptions = {
  app: App
  vaultPath: string
}

type PiProcessHandle = {
  process: PiSubprocess
  transport: PiRpcTransport
}

const NOT_FOUND_MESSAGE =
  'pi CLI was not found on this device. Install pi (npm i -g @earendil-works/pi-cli, package name may vary), or set a custom CLI path in Settings → Agent, then retry.'

/**
 * Native RPC runtime for `pi --mode rpc` (stdio JSONL).
 *
 * Unlike Claude/Codex/Hermes, pi has no pooled host: a pi session is bound
 * to the process at launch via `--session <target>`, so there is nothing to
 * multiplex across conversations in one process. Each `PiCliRuntime`
 * instance owns at most one *active* process (spawned by `ensureReady`,
 * torn down and respawned whenever the target session changes) and may
 * additionally spin up short-lived, self-disposing processes for
 * session-independent queries (`listModels`, `openSession`) when no active
 * process is available yet.
 */
export class PiCliRuntime implements CliRuntime {
  readonly runtimeId = 'pi' as const

  private activeHandle: PiProcessHandle | null = null
  private detachActiveListeners: (() => void) | null = null
  private boundTargetKey: string | null = null
  private activeSessionRef: CliSessionRef | null = null
  private sessionBound = false
  private receivedFirstEvent = false
  private bindAttemptInFlight: Promise<void> | null = null
  private turnTerminalEmitted = true
  private cancelRequested = false
  private contextWindowHint: number | null = null
  private readonly mappingState: PiMappingState = createPiMappingState()
  private readonly listeners = new Set<CliRuntimeEventListener>()
  private models: CliRuntimeModel[] | null = null
  private modelId: string | null = null
  private modelRestoreAttempted = false
  private reasoningEffort: string | null = null
  private appliedModelId: string | null = null
  private appliedThinkingLevel: string | null = null
  private sentUserMessageIds: string[] = []
  private disposed = false

  constructor(private readonly options: PiCliRuntimeOptions) {}

  async ensureReady(input: CliRuntimeReadyInput): Promise<void> {
    if (this.disposed) throw new Error('pi CLI runtime has been disposed.')
    const targetKey = input.sessionRef
      ? (input.sessionRef.sessionPathHint ?? input.sessionRef.nativeSessionId)
      : null
    if (
      this.activeHandle &&
      !this.activeHandle.transport.isDisposed &&
      this.boundTargetKey === targetKey
    ) {
      return
    }

    await this.shutdownActiveHandle()
    this.sentUserMessageIds = []
    const handle = await this.startProcessHandle(targetKey)
    if (this.disposed) {
      // `dispose()` ran while the process was spawning and found nothing to
      // shut down (`activeHandle` was still null at that point) — this
      // continuation owns cleanup instead of publishing a leaked process.
      await this.disposeProcessHandle(handle)
      throw new Error('pi CLI runtime has been disposed.')
    }
    this.activeHandle = handle
    this.boundTargetKey = targetKey
    this.sessionBound = false
    this.activeSessionRef = null
    this.receivedFirstEvent = false
    this.appliedModelId = null
    this.appliedThinkingLevel = null
    this.attachActiveListeners(handle)

    // Resuming a known session: pi should already know its identity, so
    // bind synchronously rather than waiting on the first event.
    if (targetKey) await this.attemptBindSession()
  }

  async openSession(ref: CliSessionRef): Promise<CliSessionHydration> {
    if (ref.runtimeId !== 'pi') throw new Error('Cannot open a non-pi session.')
    const target = ref.sessionPathHint ?? ref.nativeSessionId
    const handle = await this.startProcessHandle(target)
    try {
      const response = await handle.transport.request('get_entries', {})
      const { messages, compactionBoundaries } =
        mapPiEntriesToHydration(response)
      return { ref, messages, compactionBoundaries }
    } finally {
      await this.disposeProcessHandle(handle)
    }
  }

  async listModels(): Promise<CliRuntimeModel[]> {
    if (this.models) return this.models
    const models = await this.withQueryHandle(async (transport) => {
      // Piggyback the current-model restoration on the same (possibly
      // throwaway) query process: catalog warm-up is the host's first pi
      // contact, and knowing "which model will actually run" is as much a
      // part of warming the picker as the list itself.
      if (this.modelId === null && !this.modelRestoreAttempted) {
        await this.restoreCurrentModelFromTransport(transport)
      }
      return transport.request('get_available_models', {}).then(mapPiModels)
    })
    this.models = models
    return models
  }

  async getConfiguration(
    cachedModels?: readonly CliRuntimeModel[],
  ): Promise<CliRuntimeConfiguration> {
    if (this.modelId === null && !this.modelRestoreAttempted) {
      await this.restoreCurrentModelFromState()
    }
    const models = includeActiveCliModel(
      cachedModels?.length ? cachedModels : await this.listModels(),
      this.modelId,
    )
    return {
      models,
      modelId: this.modelId,
      reasoningEffort: this.reasoningEffort,
    }
  }

  /**
   * Seeds `modelId`/`reasoningEffort` (and marks them already-applied) from
   * pi's own `get_state`. There is deliberately no catalog fallback: pi's
   * catalog is the full provider list in alphabetical order, so "first entry"
   * is an arbitrary model — selecting it here would both display the wrong
   * model and actively `set_model` to it on the next turn. When pi can't
   * report a current model yet (unreachable, or freshly installed with no
   * auth), `modelId` stays null — no `set_model` is sent and pi keeps its own
   * default — and the restore latch stays unset so the next
   * `getConfiguration()` retries once pi is configured.
   */
  private async restoreCurrentModelFromState(): Promise<void> {
    await this.withQueryHandle((transport) =>
      this.restoreCurrentModelFromTransport(transport),
    ).catch(() => {
      // pi unreachable right now — retry on the next getConfiguration().
    })
  }

  private async restoreCurrentModelFromTransport(
    transport: PiRpcTransport,
  ): Promise<void> {
    try {
      const current = await transport
        .request('get_state', {})
        .then(extractPiCurrentModelState)
      if (!current) return
      this.modelRestoreAttempted = true
      if (this.modelId !== null) return
      this.modelId = current.modelId
      this.appliedModelId = current.modelId
      if (current.thinkingLevel) {
        this.reasoningEffort ??= current.thinkingLevel
        this.appliedThinkingLevel = current.thinkingLevel
      }
    } catch {
      // pi unreachable right now — retry on the next getConfiguration().
    }
  }

  async updateConfiguration(
    update: CliRuntimeConfigurationUpdate,
  ): Promise<CliRuntimeConfiguration> {
    if ('modelId' in update) this.modelId = update.modelId ?? null
    if ('reasoningEffort' in update) {
      this.reasoningEffort = update.reasoningEffort ?? null
    }
    return this.getConfiguration()
  }

  /**
   * No-op: pi has no native approval gate to hot-reconfigure (only a coarse
   * `--tools` allowlist, deliberately not implemented in v1 — see master
   * decision record), so the product's chat-mode/yolo toggle has nothing to
   * apply here.
   */
  async updatePermissionProfile(
    _update: CliPermissionProfileUpdate,
  ): Promise<void> {}

  async sendTurn(input: CliTurnInput): Promise<void> {
    if (this.disposed) throw new Error('pi CLI runtime has been disposed.')
    if (
      input.sessionRef &&
      (!this.activeSessionRef ||
        input.sessionRef.nativeSessionId !==
          this.activeSessionRef.nativeSessionId)
    ) {
      throw new Error(
        'pi session must be resumed with ensureReady before sending.',
      )
    }
    const handle = this.activeHandle
    if (!handle) throw new Error('pi runtime is not ready.')

    resetPiMappingState(this.mappingState)
    this.turnTerminalEmitted = false
    this.cancelRequested = false
    this.emit({ type: 'run_state', state: 'running' })

    try {
      await this.applySelectedModel(handle)
      await this.applySelectedThinkingLevel(handle)
      const { message, images } = toPiPrompt(input.content)
      await handle.transport.request('prompt', {
        message,
        ...(images.length > 0 ? { images } : {}),
      })
      if (input.userMessageId) {
        this.sentUserMessageIds = [
          ...this.sentUserMessageIds,
          input.userMessageId,
        ]
      }
    } catch (error) {
      this.turnTerminalEmitted = true
      const messageText = error instanceof Error ? error.message : String(error)
      this.emit({ type: 'run_state', state: 'error', error: messageText })
      throw error
    }

    // `prompt`'s response only acknowledges acceptance — it does not imply a
    // session exists yet for a brand-new conversation. The caller checks
    // `sessionRef` immediately after this resolves, so binding must complete
    // (or be given a real chance to) before returning, not merely be kicked
    // off in the background.
    if (!this.sessionBound) await this.attemptBindSession()
  }

  async rewriteTurn(input: CliRewriteTurnInput): Promise<void> {
    if (this.disposed) throw new Error('pi CLI runtime has been disposed.')
    if (!this.activeHandle || !this.activeSessionRef) {
      throw new Error('pi runtime is not ready.')
    }
    const activeRef = this.activeSessionRef
    const sameSession =
      input.sessionRef.nativeSessionId === activeRef.nativeSessionId ||
      (!!input.sessionRef.sessionPathHint &&
        input.sessionRef.sessionPathHint === activeRef.sessionPathHint)
    if (!sameSession) {
      throw new Error('pi rewrite does not match the active session.')
    }

    const handle = this.activeHandle
    const entriesResponse = await handle.transport.request('get_entries', {})
    const checkpoint = resolvePiRewriteCheckpoint(
      entriesResponse,
      input.sourceUserMessageId,
      this.sentUserMessageIds,
    )
    const keptUserMessageIds = this.sentUserMessageIds.slice(
      0,
      checkpoint.userIndex,
    )
    const state = await handle.transport.request('get_state', {})
    const identity = extractPiSessionIdentity(state)
    const sourceFile = activeRef.sessionPathHint ?? identity?.sessionFile
    if (!sourceFile) {
      throw new Error('pi session file is unknown; cannot rewrite a turn.')
    }

    const nextRef = checkpoint.resumeAt
      ? await this.writeForkedSession({
          entriesResponse,
          resumeAt: checkpoint.resumeAt,
          sourceFile,
        })
      : null

    await this.ensureReady(nextRef ? { sessionRef: nextRef } : {})
    this.sentUserMessageIds = keptUserMessageIds
    await this.sendTurn({
      content: input.content,
      userMessageId: input.userMessageId,
      ...(input.selectedSkills ? { selectedSkills: input.selectedSkills } : {}),
      ...(this.activeSessionRef ? { sessionRef: this.activeSessionRef } : {}),
    })
  }

  private async writeForkedSession({
    entriesResponse,
    resumeAt,
    sourceFile,
  }: {
    entriesResponse: unknown
    resumeAt: string
    sourceFile: string
  }): Promise<CliSessionRef> {
    const path =
      await loadDesktopNodeModule<typeof import('node:path')>('node:path')
    const fs =
      await loadDesktopNodeModule<typeof import('node:fs/promises')>(
        'node:fs/promises',
      )
    const sessionId = globalThis.crypto.randomUUID()
    const timestamp = new Date().toISOString()
    const sessionFile = path.join(
      path.dirname(sourceFile),
      `${timestamp.replace(/[:.]/g, '-')}_${sessionId}.jsonl`,
    )
    await fs.mkdir(path.dirname(sessionFile), { recursive: true })
    await fs.writeFile(
      sessionFile,
      buildPiForkSessionContent({
        entries: collectPiForkRawEntries(entriesResponse, resumeAt),
        sessionId,
        timestamp,
        cwd: this.options.vaultPath,
        parentSession: sourceFile,
      }),
      { flag: 'wx' },
    )
    return {
      runtimeId: 'pi',
      nativeSessionId: sessionId,
      sessionPathHint: sessionFile,
    }
  }

  async cancel(): Promise<void> {
    if (!this.activeHandle) return
    this.cancelRequested = true
    // Fire-and-forget: pi's abort ack may race the process tearing down the
    // turn on its own, and cancellation must not hang on a round trip.
    this.activeHandle.transport.send({ type: 'abort' })
  }

  async compact(): Promise<void> {
    if (!this.activeHandle) throw new Error('pi runtime is not ready.')
    // Compaction waits on the summarization LLM call. Same as Codex:
    // `timeoutMs = 0` disables the transport default (30s).
    await this.activeHandle.transport.request('compact', {}, 0)
  }

  /** pi has no approval prompts in v1 — nothing is ever pending to answer. */
  async respondApproval(_response: CliApprovalResponse): Promise<boolean> {
    return false
  }

  /** pi has no user-question prompts in v1 — nothing is ever pending to answer. */
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
    await this.shutdownActiveHandle()
    this.listeners.clear()
  }

  // ---------------------------------------------------------------------
  // Process / transport lifecycle
  // ---------------------------------------------------------------------

  private async resolveCommand(): Promise<string> {
    const env = (await loadLoginShellEnvironment()) as NodeJS.ProcessEnv
    const cliPathOverride = getCliPathOverride(this.options.app, 'pi')
    const resolved = await resolvePiCommand(
      env,
      process.platform,
      cliPathOverride,
    )
    if (!resolved) throw new Error(NOT_FOUND_MESSAGE)
    return resolved.command
  }

  private async startProcessHandle(
    sessionTarget: string | null,
  ): Promise<PiProcessHandle> {
    const command = await this.resolveCommand()
    const args = [
      '--mode',
      'rpc',
      ...(sessionTarget ? ['--session', sessionTarget] : []),
    ]
    const process = await PiSubprocess.start({
      command,
      args,
      cwd: this.options.vaultPath,
    })
    const transport = new PiRpcTransport(process)
    return { process, transport }
  }

  private async disposeProcessHandle(handle: PiProcessHandle): Promise<void> {
    handle.transport.dispose()
    await handle.process.shutdown()
  }

  private async shutdownActiveHandle(): Promise<void> {
    const handle = this.activeHandle
    this.activeHandle = null
    this.detachActiveListeners?.()
    this.detachActiveListeners = null
    if (handle) await this.disposeProcessHandle(handle)
  }

  /**
   * Reuses the active conversation process for a query when one is already
   * running; otherwise spins up a throwaway sessionless process just for
   * this call and disposes it afterward. pi's per-session process model
   * gives no cheaper option for e.g. a cold model-catalog warm-up.
   */
  private async withQueryHandle<T>(
    fn: (transport: PiRpcTransport) => Promise<T>,
  ): Promise<T> {
    if (this.activeHandle && !this.activeHandle.transport.isDisposed) {
      return fn(this.activeHandle.transport)
    }
    const handle = await this.startProcessHandle(null)
    try {
      return await fn(handle.transport)
    } finally {
      await this.disposeProcessHandle(handle)
    }
  }

  private attachActiveListeners(handle: PiProcessHandle): void {
    const detachEvent = handle.transport.onEvent((event) =>
      this.handleTransportEvent(handle, event),
    )
    const detachFatal = handle.transport.onFatal((error) =>
      this.handleTransportFatal(handle, error),
    )
    this.detachActiveListeners = () => {
      detachEvent()
      detachFatal()
    }
  }

  private handleTransportEvent(
    handle: PiProcessHandle,
    event: PiRpcRecord,
  ): void {
    if (handle !== this.activeHandle) return // stale process (already respawned)

    if (!this.receivedFirstEvent) {
      this.receivedFirstEvent = true
      if (!this.sessionBound) void this.attemptBindSession()
    }

    const errorMessage = getPiTerminalErrorMessage(event)
    if (errorMessage && !this.turnTerminalEmitted) {
      this.turnTerminalEmitted = true
      this.cancelRequested = false
      this.emit({ type: 'run_state', state: 'error', error: errorMessage })
      return
    }

    for (const mapped of mapPiEvent(
      event,
      this.mappingState,
      this.contextWindowHint,
    )) {
      this.emit(mapped)
    }

    if (isPiAgentSettled(event) && !this.turnTerminalEmitted) {
      this.turnTerminalEmitted = true
      const state = this.cancelRequested ? 'aborted' : 'completed'
      this.cancelRequested = false
      this.emit({ type: 'run_state', state })
    }
  }

  private handleTransportFatal(handle: PiProcessHandle, error: Error): void {
    if (handle !== this.activeHandle) return
    // Detach and drop the dead handle so the next `ensureReady()` respawns
    // instead of reusing a process whose transport rejects every request
    // with this same fatal error forever (`transport.isDisposed` alone never
    // reflects a fatal exit — only an explicit `dispose()` call sets it).
    this.activeHandle = null
    this.detachActiveListeners?.()
    this.detachActiveListeners = null
    this.sessionBound = false
    if (!this.disposed) {
      this.emit({ type: 'run_state', state: 'error', error: error.message })
    }
    void this.disposeProcessHandle(handle)
  }

  /**
   * pi does not hand back a session id/file proactively for a brand-new
   * session — it only becomes known once pi has materialized one, which can
   * lag slightly behind the `prompt` response that accepted the turn.
   * Callers trigger this: synchronously after a resume (`ensureReady`), on
   * the first inbound event of a fresh session, and again after a `prompt`
   * round-trip if still unbound at that point — the last of which is now
   * awaited by the caller, so a bounded retry gives pi a real chance to
   * materialize the session before giving up.
   */
  private async attemptBindSession(): Promise<void> {
    if (this.sessionBound || this.disposed || !this.activeHandle) return
    if (this.bindAttemptInFlight) return this.bindAttemptInFlight
    const handle = this.activeHandle
    const maxAttempts = 3
    const retryDelayMs = 150
    const attempt = (async () => {
      for (
        let attemptIndex = 0;
        attemptIndex < maxAttempts;
        attemptIndex += 1
      ) {
        try {
          const state = await handle.transport.request('get_state', {})
          if (handle !== this.activeHandle || this.sessionBound) return
          const window = extractPiContextWindow(state)
          if (window !== null) this.contextWindowHint = window
          const identity = extractPiSessionIdentity(state)
          const nativeSessionId =
            identity && (identity.sessionId ?? identity.sessionFile)
          if (nativeSessionId) {
            const ref: CliSessionRef = {
              runtimeId: 'pi',
              nativeSessionId,
              ...(identity?.sessionFile
                ? { sessionPathHint: identity.sessionFile }
                : {}),
            }
            this.activeSessionRef = ref
            this.sessionBound = true
            this.boundTargetKey = ref.sessionPathHint ?? ref.nativeSessionId
            this.emit({ type: 'session_bound', ref })
            return
          }
        } catch {
          // Fall through to retry/give-up below — a later trigger point can
          // still succeed once this attempt sequence is exhausted.
        }
        if (attemptIndex < maxAttempts - 1) {
          await new Promise((resolve) =>
            globalThis.setTimeout(resolve, retryDelayMs),
          )
        }
      }
    })()
    this.bindAttemptInFlight = attempt.finally(() => {
      this.bindAttemptInFlight = null
    })
    return this.bindAttemptInFlight
  }

  private async applySelectedModel(handle: PiProcessHandle): Promise<void> {
    if (!this.modelId || this.appliedModelId === this.modelId) return
    const decoded = decodePiModelId(this.modelId)
    // A malformed/stale id (e.g. carried over from a persisted index entry
    // predating the `provider/modelId` encoding) can't be applied safely —
    // leave pi on its current model rather than sending a broken request.
    if (!decoded) return
    await handle.transport.request('set_model', {
      provider: decoded.provider,
      modelId: decoded.modelId,
    })
    this.appliedModelId = this.modelId
    this.appliedThinkingLevel = null
  }

  /**
   * `reasoningEffort === null` means "auto" in the shared UI — pi has no
   * ambient auto-reasoning concept, so this simply skips `set_thinking_level`
   * and leaves pi's own default in effect rather than forcing `'off'`.
   */
  private async applySelectedThinkingLevel(
    handle: PiProcessHandle,
  ): Promise<void> {
    if (
      !this.reasoningEffort ||
      this.appliedThinkingLevel === this.reasoningEffort
    ) {
      return
    }
    await handle.transport.request('set_thinking_level', {
      level: this.reasoningEffort,
    })
    this.appliedThinkingLevel = this.reasoningEffort
  }

  private emit(event: CliRuntimeEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
