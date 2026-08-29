import { v4 as uuidv4 } from 'uuid'

import type { ChatMessage, ChatUserMessage } from '../../types/chat'
import type { ResponseUsage } from '../../types/llm/response'
import type { ToolEditSummary } from '../../types/tool-call.types'

import { attachCliTurnEditSummary } from './turn-edit-summary'
import type {
  CliCompactionBoundary,
  CliContextUsage,
  CliPermissionProfileUpdate,
  CliRewriteTurnInput,
  CliRuntime,
  CliRuntimeConfiguration,
  CliRuntimeConfigurationUpdate,
  CliRuntimeEvent,
  CliRuntimeMcpServerStatus,
  CliRuntimeModel,
  CliRuntimeRunState,
  CliRuntimeSkill,
  CliSessionFallbackBoundary,
  CliSessionHydration,
  CliSessionOverlay,
  CliSessionRef,
  CliTurnConfiguration,
  CliTurnInput,
} from './types'

export type CliConversationSnapshot = Readonly<{
  /**
   * Stable identity for the selected conversation surface. Unlike
   * `sessionRef`, this exists before a provider-native session is bound and
   * must not change when that binding arrives.
   */
  surfaceId: string
  runtimeId: CliRuntime['runtimeId']
  messages: readonly ChatMessage[]
  /** Ordered provider-native compaction events derived from the CLI session. */
  compactionBoundaries: readonly CliCompactionBoundary[]
  /**
   * Ordered "resumed session couldn't be reached, started a fresh one
   * instead" notices anchored into the transcript. See
   * `AcpCliRuntimeOptions.sessionRecovery`. Optional (unlike
   * `compactionBoundaries`) so existing snapshot fixtures that predate this
   * field stay valid; treat a missing value the same as an empty array.
   */
  sessionFallbackBoundaries?: readonly CliSessionFallbackBoundary[]
  sessionRef: CliSessionRef | null
  runState: CliRuntimeRunState
  /** True only while a provider-native context compaction is in flight. */
  isCompacting?: boolean
  error: string | null
  configuration?: CliRuntimeConfiguration | null
  turnConfigurationByUserMessageId?: Readonly<
    Record<string, CliTurnConfiguration>
  >
  /** Latest provider-reported context usage for the input ring; not persisted. */
  contextUsage?: CliContextUsage | null
}>

export type CliConversationTurn = Readonly<{
  userMessage: ChatUserMessage
  content: CliTurnInput['content']
  selectedSkills?: CliTurnInput['selectedSkills']
}>

export type CliConversationRewriteTurn = CliConversationTurn &
  Readonly<Pick<CliRewriteTurnInput, 'sourceUserMessageId'>>

export type CliStagedConversationTurn = Readonly<{
  surfaceId: string
  conversationEpoch: number
  userMessageId: string
}>

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const isSameSession = (
  left: CliSessionRef | null | undefined,
  right: CliSessionRef | null | undefined,
): boolean =>
  left?.runtimeId === right?.runtimeId &&
  left?.nativeSessionId === right?.nativeSessionId

const isToolRequestShell = (message: ChatMessage): boolean =>
  message.role === 'assistant' &&
  !message.content.trim() &&
  (message.toolCallRequests?.length ?? 0) > 0

const upsertMessage = (
  messages: readonly ChatMessage[],
  message: ChatMessage,
): readonly ChatMessage[] => {
  const index = messages.findIndex((candidate) => candidate.id === message.id)
  if (index < 0) return Object.freeze([...messages, message])
  if (messages[index] === message) return messages
  const next = [...messages]
  next[index] = message
  return Object.freeze(next)
}

const normalizeMessages = (
  messages: readonly ChatMessage[],
): readonly ChatMessage[] => {
  const normalized: ChatMessage[] = []
  const indexById = new Map<string, number>()
  for (const message of messages) {
    const index = indexById.get(message.id)
    if (index === undefined) {
      indexById.set(message.id, normalized.length)
      normalized.push(message)
    } else {
      normalized[index] = message
    }
  }
  return Object.freeze(normalized)
}

const normalizeCompactionBoundaries = (
  boundaries: readonly CliCompactionBoundary[],
  messages: readonly ChatMessage[],
): readonly CliCompactionBoundary[] => {
  const messageIds = new Set(messages.map((message) => message.id))
  const normalized: CliCompactionBoundary[] = []
  const indexById = new Map<string, number>()
  for (const boundary of boundaries) {
    if (
      boundary.afterMessageId !== null &&
      !messageIds.has(boundary.afterMessageId)
    ) {
      continue
    }
    const index = indexById.get(boundary.id)
    if (index === undefined) {
      indexById.set(boundary.id, normalized.length)
      normalized.push(boundary)
    } else {
      normalized[index] = boundary
    }
  }
  return Object.freeze(normalized)
}

const retainAnchoredCompactionBoundaries = (
  boundaries: readonly CliCompactionBoundary[],
  messages: readonly ChatMessage[],
): readonly CliCompactionBoundary[] =>
  normalizeCompactionBoundaries(boundaries, messages)

const normalizeSessionFallbackBoundaries = (
  boundaries: readonly CliSessionFallbackBoundary[],
  messages: readonly ChatMessage[],
): readonly CliSessionFallbackBoundary[] => {
  const messageIds = new Set(messages.map((message) => message.id))
  const normalized: CliSessionFallbackBoundary[] = []
  const indexById = new Map<string, number>()
  for (const boundary of boundaries) {
    if (
      boundary.afterMessageId !== null &&
      !messageIds.has(boundary.afterMessageId)
    ) {
      continue
    }
    const index = indexById.get(boundary.id)
    if (index === undefined) {
      indexById.set(boundary.id, normalized.length)
      normalized.push(boundary)
    } else {
      normalized[index] = boundary
    }
  }
  return Object.freeze(normalized)
}

const getCurrentTurnConfiguration = (
  configuration: CliRuntimeConfiguration | null | undefined,
): CliTurnConfiguration | null =>
  configuration
    ? {
        modelId: configuration.modelId,
        reasoningEffort: configuration.reasoningEffort,
      }
    : null

const setTurnConfiguration = (
  configurations: NonNullable<
    CliConversationSnapshot['turnConfigurationByUserMessageId']
  >,
  userMessageId: string,
  configuration: CliRuntimeConfiguration | null | undefined,
): CliConversationSnapshot['turnConfigurationByUserMessageId'] => {
  const turnConfiguration = getCurrentTurnConfiguration(configuration)
  return turnConfiguration
    ? Object.freeze({
        ...configurations,
        [userMessageId]: turnConfiguration,
      })
    : configurations
}

const replaceTurnConfigurationMessageId = (
  configurations: NonNullable<
    CliConversationSnapshot['turnConfigurationByUserMessageId']
  >,
  previousMessageId: string,
  nextMessageId: string,
): CliConversationSnapshot['turnConfigurationByUserMessageId'] => {
  const { [previousMessageId]: configuration, ...remaining } = configurations
  return Object.freeze(
    configuration
      ? { ...remaining, [nextMessageId]: configuration }
      : remaining,
  )
}

const replaceOptimisticUserMessage = (
  messages: readonly ChatMessage[],
  optimisticMessageId: string,
  nativeMessage: ChatUserMessage,
): readonly ChatMessage[] => {
  const index = messages.findIndex(
    (message) => message.role === 'user' && message.id === optimisticMessageId,
  )
  if (index < 0) return upsertMessage(messages, nativeMessage)
  const optimisticMessage = messages[index] as ChatUserMessage
  const next = [...messages]
  next[index] = {
    ...nativeMessage,
    ...optimisticMessage,
    id: nativeMessage.id,
  }
  return Object.freeze(next)
}

/**
 * A transcript that is not being generated into must not contain a message
 * still marked `streaming` — every consumer reads that flag as "tokens are
 * still arriving" and keeps the streaming markdown/reasoning renderers
 * engaged while suppressing finished-message affordances such as the
 * selection-quote overlay.
 *
 * Runtimes that already finalize their own messages (claude-code, codex) pass
 * through untouched; ACP agents and pi only ever emit `streaming`, so without
 * this their turns would stay "generating" forever. Owned here because this is
 * the layer that holds both the run state and the messages it applies to.
 */
const settleStreamingAssistantMessages = (
  messages: readonly ChatMessage[],
  generationState: 'completed' | 'aborted',
): readonly ChatMessage[] => {
  let changed = false
  const settled = messages.map((message) => {
    if (
      message.role !== 'assistant' ||
      message.metadata?.generationState !== 'streaming'
    ) {
      return message
    }
    changed = true
    return {
      ...message,
      metadata: { ...message.metadata, generationState },
    }
  })
  return changed ? Object.freeze(settled) : messages
}

const appendAssistantError = (
  snapshot: CliConversationSnapshot,
  errorMessage: string,
): readonly ChatMessage[] => {
  let sourceUserMessageId: string | undefined
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index]
    if (message?.role === 'user') {
      sourceUserMessageId = message.id
      break
    }
  }
  return upsertMessage(snapshot.messages, {
    role: 'assistant',
    id: `cli-error-${sourceUserMessageId ?? snapshot.surfaceId}`,
    content: '',
    metadata: {
      generationState: 'error',
      errorMessage,
      ...(sourceUserMessageId ? { sourceUserMessageId } : {}),
    },
  })
}

type CliTurnMetrics = Readonly<{
  usage?: ResponseUsage
  durationMs?: number
}>

const applyTurnMetrics = (
  messages: readonly ChatMessage[],
  metrics: CliTurnMetrics,
): readonly ChatMessage[] => {
  let latestUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      latestUserIndex = index
      break
    }
  }
  let targetIndex = -1
  for (let index = messages.length - 1; index > latestUserIndex; index -= 1) {
    const message = messages[index]
    if (
      message?.role === 'assistant' &&
      message.metadata?.cliSubagentParentCallId === undefined
    ) {
      targetIndex = index
      break
    }
  }
  if (targetIndex < 0) return messages
  return Object.freeze(
    messages.map((message, index) => {
      if (
        message.role !== 'assistant' ||
        index <= latestUserIndex ||
        message.metadata?.cliSubagentParentCallId !== undefined
      ) {
        return message
      }
      const {
        usage: _usage,
        durationMs: _durationMs,
        ...metadata
      } = message.metadata ?? {}
      return index === targetIndex
        ? {
            ...message,
            metadata: { ...metadata, ...metrics },
          }
        : { ...message, metadata }
    }),
  )
}

/**
 * Owns the transient timeline for the currently selected CLI runtime/session.
 * The runtime remains owned by the caller; disposing this controller only
 * detaches its listeners and invalidates outstanding operations.
 */
export class CliConversationController {
  private readonly runtime: CliRuntime
  private snapshot: CliConversationSnapshot
  private readonly listeners = new Set<() => void>()
  private unsubscribeRuntime: (() => void) | null = null
  private runtimeEpoch = 0
  private conversationEpoch = 0
  private acceptingEvents = false
  private bindingTarget: CliSessionRef | null | undefined
  private bindingEpoch: number | null = null
  private pendingOptimisticUserMessageId: string | null = null
  /**
   * Live-turn remapping of runtime message ids. A provider may reuse the same
   * stream id across turns (pi's fallback `"stream"`, an ACP agent recycling
   * `messageId`); upsert-in-place would then edit the previous turn. When that
   * happens we mint a fresh id for the current turn and keep routing later
   * deltas to it.
   */
  private currentTurnMessageIds = new Map<string, string>()
  private allowSessionRebind = false
  private restoredCacheHitRate: number | null = null
  private currentTurnMetrics: CliTurnMetrics | null = null
  private readonly reconciledNativeUserMessageIds = new Set<string>()
  /**
   * Host conversation this surface belongs to. Kept outside the snapshot
   * because it survives provider-native session transitions, and because it is
   * the only way background monitoring can locate a still-running CLI process
   * after its view is gone.
   */
  private conversationId: string | null = null
  private readyTail: Promise<void> = Promise.resolve()
  private permissionUpdateTail: Promise<void> = Promise.resolve()
  private appliedPermissionProfile: CliPermissionProfileUpdate | null = null
  private disposed = false

  constructor(
    runtime: CliRuntime,
    private readonly getCachedModels: () => readonly CliRuntimeModel[] = () => [],
    private readonly onTurnEditSummary?: (
      ref: CliSessionRef,
      sourceUserMessageId: string,
      summary: ToolEditSummary,
    ) => Promise<void>,
    private readonly onContextUsage?: (
      ref: CliSessionRef,
      usage: CliContextUsage,
    ) => Promise<void>,
  ) {
    this.runtime = runtime
    this.snapshot = this.createEmptySnapshot(runtime)
    this.subscribeToRuntime()
  }

  getSnapshot = (): CliConversationSnapshot => this.snapshot

  getConversationId = (): string | null => this.conversationId

  /** Binds this surface to the host conversation that presents it. */
  bindConversation(conversationId: string): void {
    if (this.disposed || this.conversationId === conversationId) return
    this.conversationId = conversationId
    this.notify()
  }

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Clears the current transcript before starting a provider-native session. */
  resetSession(): void {
    this.assertActive()
    this.beginSessionTransition(null)
  }

  async hydrateSession(
    ref: CliSessionRef,
    restoreMessages?: (
      messages: readonly ChatMessage[],
    ) => Promise<readonly ChatMessage[] | CliSessionOverlay>,
  ): Promise<CliSessionHydration | null> {
    this.assertActive()
    this.assertRuntimeRef(ref)
    this.beginSessionTransition(ref)
    const operation = this.captureOperation()

    try {
      const hydration = await operation.runtime.openSession(ref)
      if (!this.isCurrent(operation)) return null
      this.assertRuntimeRef(hydration.ref)
      const isFallback =
        hydration.sessionFallback !== undefined &&
        isSameSession(hydration.sessionFallback.requestedRef, ref)
      if (!isFallback && !isSameSession(ref, hydration.ref)) {
        throw new Error('CLI runtime hydrated a different session.')
      }
      const restored = restoreMessages
        ? await restoreMessages(hydration.messages)
        : hydration.messages
      const overlay = Array.isArray(restored)
        ? null
        : (restored as CliSessionOverlay)
      const messages = overlay
        ? overlay.messages
        : (restored as readonly ChatMessage[])
      if (!this.isCurrent(operation)) return null
      this.restoredCacheHitRate = overlay?.lastCacheHitRate ?? null
      const sessionFallbackBoundaries = isFallback
        ? normalizeSessionFallbackBoundaries(
            [
              {
                id: `${hydration.ref.runtimeId}-fallback-${hydration.ref.nativeSessionId}`,
                afterMessageId: messages.at(-1)?.id ?? null,
                requestedRef: hydration.sessionFallback!.requestedRef,
              },
            ],
            messages,
          )
        : Object.freeze([])
      this.publish({
        ...this.snapshot,
        // Hydrated history is finished by definition — nothing in it can still
        // be generating, whatever `generationState` the replay mapping emitted.
        messages: settleStreamingAssistantMessages(
          normalizeMessages(messages),
          'completed',
        ),
        compactionBoundaries: normalizeCompactionBoundaries(
          hydration.compactionBoundaries ?? [],
          messages,
        ),
        sessionFallbackBoundaries,
        turnConfigurationByUserMessageId:
          overlay?.turnConfigurationByUserMessageId ?? Object.freeze({}),
        sessionRef: hydration.ref,
        runState: 'idle',
        error: null,
      })
      return {
        ...hydration,
        messages: [...messages],
        compactionBoundaries: [...(hydration.compactionBoundaries ?? [])],
      }
    } catch (error) {
      if (this.isCurrent(operation)) this.publishError(error)
      throw error
    }
  }

  ensureReady(
    initialConfiguration?: CliRuntimeConfigurationUpdate,
  ): Promise<void> {
    this.assertActive()
    const operation = this.captureOperation()
    const stagedConfiguration = this.snapshot.configuration
    const configurationToApply =
      initialConfiguration ??
      (stagedConfiguration
        ? {
            modelId: stagedConfiguration.modelId,
            reasoningEffort: stagedConfiguration.reasoningEffort,
          }
        : undefined)
    const task = this.readyTail
      .catch(() => undefined)
      .then(async () => {
        if (!this.isCurrent(operation)) return
        await this.ensureReadyNow(operation, configurationToApply)
      })
    this.readyTail = task.catch(() => undefined)
    return task
  }

  async sendTurn({
    userMessage,
    content,
    selectedSkills,
  }: CliConversationTurn): Promise<void> {
    this.assertActive()
    const operation = this.captureOperation()
    if (!this.acceptingEvents) {
      throw new Error('CLI runtime is not ready for the selected session.')
    }
    const sessionRef = this.snapshot.sessionRef

    this.currentTurnMetrics = {}
    this.currentTurnMessageIds.clear()
    this.publish({
      ...this.snapshot,
      messages: upsertMessage(this.snapshot.messages, userMessage),
      turnConfigurationByUserMessageId: setTurnConfiguration(
        this.snapshot.turnConfigurationByUserMessageId ?? {},
        userMessage.id,
        this.snapshot.configuration,
      ),
      runState: 'running',
      error: null,
    })
    this.pendingOptimisticUserMessageId = userMessage.id
    if (!this.isCurrent(operation) || !this.acceptingEvents) return

    try {
      await operation.runtime.sendTurn({
        ...(sessionRef ? { sessionRef } : {}),
        userMessageId: userMessage.id,
        content,
        ...(selectedSkills ? { selectedSkills } : {}),
      })
      // Runtime notifications may arrive before sendTurn resolves. Do not
      // overwrite messages or a newer run state after the await.
    } catch (error) {
      if (this.isCurrent(operation)) this.publishError(error)
      throw error
    }
  }

  async rewriteTurn({
    sourceUserMessageId,
    userMessage,
    content,
    selectedSkills,
  }: CliConversationRewriteTurn): Promise<void> {
    this.assertActive()
    const operation = this.captureOperation()
    if (!this.acceptingEvents || !this.snapshot.sessionRef) {
      throw new Error('CLI runtime is not ready for rewriting this session.')
    }
    if (
      this.snapshot.runState === 'running' ||
      this.snapshot.runState === 'waiting_for_approval' ||
      this.snapshot.runState === 'waiting_for_user'
    ) {
      throw new Error('Cannot rewrite a CLI message while a turn is active.')
    }
    const sourceIndex = this.snapshot.messages.findIndex(
      (message) =>
        message.role === 'user' && message.id === sourceUserMessageId,
    )
    if (sourceIndex < 0) {
      throw new Error('The selected CLI user message no longer exists.')
    }

    const sessionRef = this.snapshot.sessionRef
    this.currentTurnMetrics = {}
    this.currentTurnMessageIds.clear()
    this.pendingOptimisticUserMessageId = userMessage.id
    const messages = Object.freeze([
      ...this.snapshot.messages.slice(0, sourceIndex),
      userMessage,
    ])
    this.publish({
      ...this.snapshot,
      messages,
      compactionBoundaries: retainAnchoredCompactionBoundaries(
        this.snapshot.compactionBoundaries,
        messages,
      ),
      sessionFallbackBoundaries: normalizeSessionFallbackBoundaries(
        this.snapshot.sessionFallbackBoundaries ?? [],
        messages,
      ),
      turnConfigurationByUserMessageId: setTurnConfiguration(
        Object.freeze(
          Object.fromEntries(
            this.snapshot.messages
              .slice(0, sourceIndex)
              .filter((message) => message.role === 'user')
              .flatMap((message) => {
                const configuration =
                  this.snapshot.turnConfigurationByUserMessageId?.[message.id]
                return configuration ? [[message.id, configuration]] : []
              }),
          ),
        ),
        userMessage.id,
        this.snapshot.configuration,
      ),
      runState: 'running',
      error: null,
    })
    this.allowSessionRebind = true
    try {
      await operation.runtime.rewriteTurn({
        sessionRef,
        sourceUserMessageId,
        userMessageId: userMessage.id,
        content,
        ...(selectedSkills ? { selectedSkills } : {}),
      })
    } catch (error) {
      if (this.isCurrent(operation)) this.publishError(error)
      throw error
    } finally {
      this.allowSessionRebind = false
    }
  }

  async listSkills(): Promise<readonly CliRuntimeSkill[]> {
    this.assertActive()
    const operation = this.captureOperation()
    if (!operation.runtime.listSkills) return []
    const skills = await operation.runtime.listSkills()
    return this.isCurrent(operation) ? skills : []
  }

  /**
   * Best-effort hot-reload of plugin state into the bound runtime. No-ops
   * when the runtime does not support it (non-Claude runtimes, or a stale
   * operation) so callers can fire-and-forget after a plugin CLI mutation.
   */
  async reloadPlugins(): Promise<void> {
    this.assertActive()
    const operation = this.captureOperation()
    if (!operation.runtime.reloadPlugins) return
    await operation.runtime.reloadPlugins()
  }

  /**
   * Current MCP server status for the bound runtime. No-ops to an empty list
   * when the runtime does not support it (or a stale operation), mirroring
   * `listSkills`.
   */
  async mcpServerStatus(): Promise<readonly CliRuntimeMcpServerStatus[]> {
    this.assertActive()
    const operation = this.captureOperation()
    if (!operation.runtime.mcpServerStatus) return []
    const statuses = await operation.runtime.mcpServerStatus()
    return this.isCurrent(operation) ? statuses : []
  }

  /** Claude Code only. Throws when the runtime does not support toggling. */
  async toggleMcpServer(name: string, enabled: boolean): Promise<void> {
    this.assertActive()
    const operation = this.captureOperation()
    if (!operation.runtime.toggleMcpServer) {
      throw new Error(
        `${operation.runtime.runtimeId} does not support toggling MCP servers.`,
      )
    }
    await operation.runtime.toggleMcpServer(name, enabled)
  }

  /** Claude Code only. Throws when the runtime does not support reconnecting. */
  async reconnectMcpServer(name: string): Promise<void> {
    this.assertActive()
    const operation = this.captureOperation()
    if (!operation.runtime.reconnectMcpServer) {
      throw new Error(
        `${operation.runtime.runtimeId} does not support reconnecting MCP servers.`,
      )
    }
    await operation.runtime.reconnectMcpServer(name)
  }

  async compact(): Promise<void> {
    this.assertActive()
    const operation = this.captureOperation()
    if (!operation.runtime.compact) {
      throw new Error(
        `${operation.runtime.runtimeId} does not support compaction.`,
      )
    }
    this.currentTurnMetrics = null
    this.publish({
      ...this.snapshot,
      isCompacting: true,
      error: null,
    })
    try {
      await operation.runtime.compact()
    } catch (error) {
      if (this.isCurrent(operation)) this.publishError(error)
      throw error
    }
  }

  /**
   * Accepts a composer turn into the local transcript before provider setup.
   * Native acceptance remains owned by `sendTurn`.
   */
  stageTurn(userMessage: ChatUserMessage): CliStagedConversationTurn {
    this.assertActive()
    const stagedTurn = Object.freeze({
      surfaceId: this.snapshot.surfaceId,
      conversationEpoch: this.conversationEpoch,
      userMessageId: userMessage.id,
    })
    this.pendingOptimisticUserMessageId = userMessage.id
    this.currentTurnMetrics = {}
    this.publish({
      ...this.snapshot,
      messages: upsertMessage(this.snapshot.messages, userMessage),
      turnConfigurationByUserMessageId: setTurnConfiguration(
        this.snapshot.turnConfigurationByUserMessageId ?? {},
        userMessage.id,
        this.snapshot.configuration,
      ),
      runState: 'running',
      error: null,
    })
    return stagedTurn
  }

  rejectStagedTurn(
    stagedTurn: CliStagedConversationTurn,
    error: unknown,
  ): void {
    if (
      this.disposed ||
      stagedTurn.surfaceId !== this.snapshot.surfaceId ||
      stagedTurn.conversationEpoch !== this.conversationEpoch ||
      stagedTurn.userMessageId !== this.pendingOptimisticUserMessageId
    ) {
      return
    }
    this.publishError(error)
  }

  async updateConfiguration(
    update: CliRuntimeConfigurationUpdate,
  ): Promise<CliRuntimeConfiguration | undefined> {
    this.assertActive()
    if (!this.acceptingEvents) {
      return this.stageConfiguration(update)
    }
    const operation = this.captureOperation()
    try {
      const configuration = await operation.runtime.updateConfiguration(update)
      if (!this.isCurrent(operation)) return undefined
      this.publish({ ...this.snapshot, configuration, error: null })
      return configuration
    } catch (error) {
      if (this.isCurrent(operation)) this.publishError(error)
      throw error
    }
  }

  /**
   * Hot-update Agent/Plan + YOLO for the bound CLI runtime.
   * Claude applies immediately via setPermissionMode; Codex applies on the next
   * turn/start. Safe to call before ensureReady. No-ops when unsupported.
   */
  async updatePermissionProfile(
    update: CliPermissionProfileUpdate,
  ): Promise<void> {
    this.assertActive()
    const operation = this.captureOperation()
    if (!operation.runtime.updatePermissionProfile) return
    if (
      this.appliedPermissionProfile?.mode === update.mode &&
      this.appliedPermissionProfile.yoloEnabled === update.yoloEnabled
    ) {
      return
    }
    const task = this.permissionUpdateTail
      .catch(() => undefined)
      .then(async () => {
        if (
          this.appliedPermissionProfile?.mode === update.mode &&
          this.appliedPermissionProfile.yoloEnabled === update.yoloEnabled
        ) {
          return
        }
        await operation.runtime.updatePermissionProfile!(update)
        this.appliedPermissionProfile = { ...update }
      })
      .catch((error) => {
        if (this.isCurrent(operation)) this.publishError(error)
        throw error
      })
    this.permissionUpdateTail = task.catch(() => undefined)
    return task
  }

  stageConfiguration(
    update: CliRuntimeConfigurationUpdate = {},
  ): CliRuntimeConfiguration | undefined {
    this.assertActive()
    if (this.acceptingEvents) return this.snapshot.configuration ?? undefined
    const models = [...this.getCachedModels()]
    if (models.length === 0) return undefined
    const current = this.snapshot.configuration
    const requestedModelId =
      'modelId' in update ? update.modelId : current?.modelId
    // No invented selection: when nothing is requested/remembered (or the
    // remembered id is no longer in the catalog), stage `null` — "the
    // runtime's own current model". Falling back to the catalog head here
    // would not just display an arbitrary model, it would be applied via
    // set_model once the session binds (the runtime restores its real model
    // on bind and the orchestration layer remembers it, so a fresh
    // conversation's staged null resolves to the truth one turn later).
    const modelId =
      requestedModelId != null &&
      models.some((model) => model.id === requestedModelId)
        ? requestedModelId
        : null
    const selectedModel = modelId
      ? models.find((model) => model.id === modelId)
      : undefined
    const requestedEffort =
      'reasoningEffort' in update
        ? update.reasoningEffort
        : current?.modelId === modelId
          ? current.reasoningEffort
          : null
    const reasoningEffort =
      requestedEffort === null ||
      selectedModel?.reasoningEfforts.some(
        (effort) => effort.id === requestedEffort,
      )
        ? (requestedEffort ?? null)
        : null
    const configuration = { models, modelId, reasoningEffort }
    this.publish({ ...this.snapshot, configuration, error: null })
    return configuration
  }

  async cancel(): Promise<void> {
    this.assertActive()
    const operation = this.captureOperation()
    try {
      await operation.runtime.cancel()
      // Completion/abort may be notified before cancel resolves; the event is
      // the authoritative run state, so success does not publish another one.
    } catch (error) {
      if (this.isCurrent(operation)) this.publishError(error)
      throw error
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.runtimeEpoch += 1
    this.conversationEpoch += 1
    this.invalidateRuntimeSubscription()
    this.resetEventGate()
    this.listeners.clear()
  }

  private async ensureReadyNow(
    operation: ReturnType<CliConversationController['captureOperation']>,
    initialConfiguration?: CliRuntimeConfigurationUpdate,
  ): Promise<void> {
    const target = this.snapshot.sessionRef
    this.acceptingEvents = false
    this.bindingTarget = target
    this.bindingEpoch = operation.conversationEpoch
    this.publish({ ...this.snapshot, error: null })

    try {
      await operation.runtime.ensureReady({
        ...(target ? { sessionRef: target } : {}),
      })
      if (!this.isCurrent(operation)) return
      // Some runtimes (pi) only materialize a native session on the first
      // prompt. `surfaceId` already identifies the conversation until then.
      let configuration = await operation.runtime.getConfiguration(
        this.getCachedModels(),
      )
      if (!this.isCurrent(operation)) return
      if (initialConfiguration) {
        const update = this.resolveAvailableConfigurationUpdate(
          initialConfiguration,
          configuration,
        )
        if (Object.keys(update).length > 0) {
          configuration = await operation.runtime.updateConfiguration(update)
          if (!this.isCurrent(operation)) return
        }
      }
      this.acceptingEvents = true
      this.bindingTarget = undefined
      this.bindingEpoch = null
      this.publish({
        ...this.snapshot,
        configuration,
        error: null,
      })
    } catch (error) {
      if (this.isCurrent(operation)) {
        this.resetEventGate()
        this.publishError(error)
      }
      throw error
    }
  }

  private resolveAvailableConfigurationUpdate(
    update: CliRuntimeConfigurationUpdate,
    configuration: CliRuntimeConfiguration,
  ): CliRuntimeConfigurationUpdate {
    const resolved: CliRuntimeConfigurationUpdate = {}
    const requestedModelId = update.modelId
    if (
      requestedModelId === null ||
      (requestedModelId !== undefined &&
        configuration.models.some((model) => model.id === requestedModelId))
    ) {
      resolved.modelId = requestedModelId
    }
    if ('reasoningEffort' in update) {
      const targetModelId =
        'modelId' in resolved
          ? (resolved.modelId ?? null)
          : configuration.modelId
      const targetModel = targetModelId
        ? configuration.models.find((model) => model.id === targetModelId)
        : undefined
      if (
        update.reasoningEffort === null ||
        (targetModel?.reasoningEfforts.some(
          (effort) => effort.id === update.reasoningEffort,
        ) ??
          false)
      ) {
        resolved.reasoningEffort = update.reasoningEffort
      }
    }
    return resolved
  }

  private beginSessionTransition(ref: CliSessionRef | null): void {
    this.conversationEpoch += 1
    this.resetEventGate()
    this.pendingOptimisticUserMessageId = null
    this.reconciledNativeUserMessageIds.clear()
    this.restoredCacheHitRate = null
    this.currentTurnMetrics = null
    this.replaceRuntimeSubscription()
    this.publish({
      surfaceId: ref
        ? `${ref.runtimeId}:${ref.nativeSessionId}`
        : this.createSurfaceId(),
      runtimeId: this.runtime.runtimeId,
      messages: Object.freeze([]),
      compactionBoundaries: Object.freeze([]),
      sessionFallbackBoundaries: Object.freeze([]),
      turnConfigurationByUserMessageId: Object.freeze({}),
      sessionRef: ref,
      runState: 'idle',
      error: null,
      configuration: this.snapshot.configuration ?? null,
      contextUsage: null,
    })
  }

  private handleRuntimeEvent(
    event: CliRuntimeEvent,
    runtimeEpoch: number,
    conversationEpoch: number,
  ): void {
    if (
      this.disposed ||
      runtimeEpoch !== this.runtimeEpoch ||
      conversationEpoch !== this.conversationEpoch
    ) {
      return
    }

    if (event.type === 'session_bound') {
      if (event.ref.runtimeId !== this.runtime.runtimeId) return
      if (this.allowSessionRebind) {
        this.acceptingEvents = true
        const sameSession = isSameSession(this.snapshot.sessionRef, event.ref)
        this.publish({
          ...this.snapshot,
          sessionRef: event.ref,
          error: null,
          ...(sameSession ? {} : { contextUsage: null }),
        })
        return
      }
      if (this.bindingEpoch === conversationEpoch) {
        const isFallback =
          event.fallbackFrom !== undefined &&
          this.bindingTarget !== null &&
          this.bindingTarget !== undefined &&
          isSameSession(this.bindingTarget, event.fallbackFrom)
        if (
          this.bindingTarget &&
          !isSameSession(this.bindingTarget, event.ref) &&
          !isFallback
        ) {
          return
        }
        this.acceptingEvents = true
        this.publish({
          ...this.snapshot,
          sessionRef: event.ref,
          error: null,
          ...(isFallback
            ? {
                sessionFallbackBoundaries: normalizeSessionFallbackBoundaries(
                  [
                    ...(this.snapshot.sessionFallbackBoundaries ?? []),
                    {
                      id: `${event.ref.runtimeId}-fallback-${event.ref.nativeSessionId}`,
                      afterMessageId: this.snapshot.messages.at(-1)?.id ?? null,
                      requestedRef: event.fallbackFrom!,
                    },
                  ],
                  this.snapshot.messages,
                ),
              }
            : {}),
        })
        return
      }
      if (this.acceptingEvents && !this.snapshot.sessionRef) {
        this.publish({ ...this.snapshot, sessionRef: event.ref, error: null })
        return
      }
      if (
        this.acceptingEvents &&
        isSameSession(this.snapshot.sessionRef, event.ref)
      ) {
        this.publish({ ...this.snapshot, sessionRef: event.ref })
      }
      return
    }

    // Accept during ensureReady binding (before acceptingEvents flips) so
    // Codex resume replay of thread/tokenUsage/updated is not dropped.
    if (event.type === 'context_usage') {
      if (!this.acceptingEvents && this.bindingEpoch !== conversationEpoch) {
        return
      }
      const usage =
        event.usage.cacheHitRate === undefined &&
        this.restoredCacheHitRate !== null
          ? { ...event.usage, cacheHitRate: this.restoredCacheHitRate }
          : event.usage
      if (event.usage.cacheHitRate !== undefined) {
        this.restoredCacheHitRate = event.usage.cacheHitRate
      }
      this.publish({ ...this.snapshot, contextUsage: usage })
      const ref = this.snapshot.sessionRef
      if (
        ref &&
        this.onContextUsage &&
        event.usage.cacheHitRate !== undefined
      ) {
        void this.onContextUsage(ref, event.usage).catch((error) => {
          console.warn('[YOLO] Failed to persist CLI context usage', error)
        })
      }
      return
    }

    if (event.type === 'compaction_state') {
      if (!this.acceptingEvents) return
      this.publish({
        ...this.snapshot,
        isCompacting: event.isCompacting,
      })
      return
    }

    if (event.type === 'compaction_boundary') {
      if (!this.acceptingEvents) return
      const boundary: CliCompactionBoundary = {
        ...event.boundary,
        afterMessageId: this.snapshot.messages.at(-1)?.id ?? null,
      }
      this.publish({
        ...this.snapshot,
        isCompacting: false,
        compactionBoundaries: normalizeCompactionBoundaries(
          [...this.snapshot.compactionBoundaries, boundary],
          this.snapshot.messages,
        ),
      })
      return
    }

    if (event.type === 'turn_metrics') {
      if (!this.acceptingEvents || this.currentTurnMetrics === null) return
      this.currentTurnMetrics = {
        ...this.currentTurnMetrics,
        ...(event.usage ? { usage: event.usage } : {}),
        ...(event.durationMs !== undefined
          ? { durationMs: event.durationMs }
          : {}),
      }
      this.publish({
        ...this.snapshot,
        messages: applyTurnMetrics(
          this.snapshot.messages,
          this.currentTurnMetrics,
        ),
      })
      return
    }

    if (!this.acceptingEvents) return
    if (event.type === 'turn_edit_summary') {
      const messages = attachCliTurnEditSummary(
        this.snapshot.messages,
        event.sourceUserMessageId,
        event.summary,
      )
      this.publish({ ...this.snapshot, messages })
      const ref = this.snapshot.sessionRef
      if (ref && this.onTurnEditSummary) {
        void this.onTurnEditSummary(
          ref,
          event.sourceUserMessageId,
          event.summary,
        ).catch((error) => {
          console.warn('[YOLO] Failed to persist CLI edit summary', error)
        })
      }
      return
    }
    if (event.type === 'message_upsert') {
      if (event.message.role === 'user') {
        if (this.reconciledNativeUserMessageIds.has(event.message.id)) return
        if (this.pendingOptimisticUserMessageId) {
          const optimisticMessageId = this.pendingOptimisticUserMessageId
          this.reconciledNativeUserMessageIds.add(event.message.id)
          this.pendingOptimisticUserMessageId = null
          this.publish({
            ...this.snapshot,
            messages: replaceOptimisticUserMessage(
              this.snapshot.messages,
              optimisticMessageId,
              event.message,
            ),
            turnConfigurationByUserMessageId: replaceTurnConfigurationMessageId(
              this.snapshot.turnConfigurationByUserMessageId ?? {},
              optimisticMessageId,
              event.message.id,
            ),
          })
          return
        }
      }
      const message = this.resolveCurrentTurnUpsert(event.message)
      const messages = upsertMessage(this.snapshot.messages, message)
      this.publish({
        ...this.snapshot,
        messages:
          message.role === 'assistant' && this.currentTurnMetrics
            ? applyTurnMetrics(messages, this.currentTurnMetrics)
            : messages,
      })
      return
    }
    if (event.type === 'message_remove') {
      const messageId =
        this.currentTurnMessageIds.get(event.messageId) ?? event.messageId
      const messages = this.snapshot.messages.filter(
        (message) => message.id !== messageId,
      )
      if (messages.length !== this.snapshot.messages.length) {
        const frozenMessages = Object.freeze(messages)
        this.publish({
          ...this.snapshot,
          messages: frozenMessages,
          compactionBoundaries: retainAnchoredCompactionBoundaries(
            this.snapshot.compactionBoundaries,
            frozenMessages,
          ),
          sessionFallbackBoundaries: normalizeSessionFallbackBoundaries(
            this.snapshot.sessionFallbackBoundaries ?? [],
            frozenMessages,
          ),
        })
      }
      return
    }
    if (
      event.state !== 'running' &&
      event.state !== 'waiting_for_approval' &&
      event.state !== 'waiting_for_user'
    ) {
      this.pendingOptimisticUserMessageId = null
      this.currentTurnMessageIds.clear()
      this.currentTurnMetrics = null
    }
    const messages =
      event.state === 'completed' ||
      event.state === 'aborted' ||
      event.state === 'error'
        ? settleStreamingAssistantMessages(
            this.snapshot.messages,
            event.state === 'aborted' ? 'aborted' : 'completed',
          )
        : this.snapshot.messages
    if (event.state === 'error' && event.error) {
      this.publish({
        ...this.snapshot,
        messages: appendAssistantError(
          { ...this.snapshot, messages },
          event.error,
        ),
        runState: 'error',
        error: event.error,
      })
      return
    }
    this.publish({
      ...this.snapshot,
      messages,
      runState: event.state,
      error: event.error ?? null,
      ...(event.state !== 'running' &&
      event.state !== 'waiting_for_approval' &&
      event.state !== 'waiting_for_user'
        ? { isCompacting: false }
        : {}),
    })
  }

  private subscribeToRuntime(): void {
    const runtimeEpoch = this.runtimeEpoch
    const conversationEpoch = this.conversationEpoch
    this.unsubscribeRuntime = this.runtime.subscribe((event) =>
      this.handleRuntimeEvent(event, runtimeEpoch, conversationEpoch),
    )
  }

  private replaceRuntimeSubscription(): void {
    this.invalidateRuntimeSubscription()
    this.subscribeToRuntime()
  }

  private invalidateRuntimeSubscription(): void {
    this.unsubscribeRuntime?.()
    this.unsubscribeRuntime = null
  }

  private resetEventGate(): void {
    this.acceptingEvents = false
    this.bindingTarget = undefined
    this.bindingEpoch = null
    this.currentTurnMessageIds.clear()
  }

  /**
   * Streaming upserts may only edit the current bubble. Reused ids from an
   * earlier turn, or assistant *text* that continues after tools, must start
   * a new message. Tool-request shells (empty assistant + toolCallRequests)
   * stay in place — they are re-emitted on every tool update, and appending
   * them would duplicate a stale "running" preview after the real tool cards.
   */
  private resolveCurrentTurnUpsert(message: ChatMessage): ChatMessage {
    if (message.role === 'user') return message
    const sourceId = message.id
    const mappedId = this.currentTurnMessageIds.get(sourceId) ?? sourceId
    const candidate =
      mappedId === sourceId ? message : { ...message, id: mappedId }
    const existingIndex = this.snapshot.messages.findIndex(
      (entry) => entry.id === candidate.id,
    )
    if (this.shouldAppendInsteadOfReplace(candidate, existingIndex)) {
      const nextId = `${sourceId}#${this.conversationEpoch}-${this.currentTurnMessageIds.size}`
      this.currentTurnMessageIds.set(sourceId, nextId)
      return { ...message, id: nextId }
    }
    this.currentTurnMessageIds.set(sourceId, candidate.id)
    return candidate
  }

  private shouldAppendInsteadOfReplace(
    message: ChatMessage,
    existingIndex: number,
  ): boolean {
    if (existingIndex < 0) return false
    const turnStart = this.findCurrentTurnUserIndex(this.snapshot.messages)
    if (turnStart >= 0 && existingIndex < turnStart) return true
    if (message.role !== 'assistant') return false
    const existing = this.snapshot.messages[existingIndex]
    if (existing?.role !== 'assistant') return false
    if (isToolRequestShell(existing) || isToolRequestShell(message)) {
      return false
    }
    return this.snapshot.messages
      .slice(existingIndex + 1)
      .some((entry) => entry.role !== 'assistant')
  }

  private findCurrentTurnUserIndex(messages: readonly ChatMessage[]): number {
    const optimisticId = this.pendingOptimisticUserMessageId
    if (optimisticId) {
      const index = messages.findIndex((message) => message.id === optimisticId)
      if (index >= 0) return index
    }
    if (
      this.snapshot.runState !== 'running' &&
      this.snapshot.runState !== 'waiting_for_approval' &&
      this.snapshot.runState !== 'waiting_for_user'
    ) {
      return -1
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === 'user') return index
    }
    return -1
  }

  private captureOperation(): {
    runtime: CliRuntime
    runtimeEpoch: number
    conversationEpoch: number
  } {
    return {
      runtime: this.runtime,
      runtimeEpoch: this.runtimeEpoch,
      conversationEpoch: this.conversationEpoch,
    }
  }

  private isCurrent(operation: {
    runtime: CliRuntime
    runtimeEpoch: number
    conversationEpoch: number
  }): boolean {
    return (
      !this.disposed &&
      operation.runtime === this.runtime &&
      operation.runtimeEpoch === this.runtimeEpoch &&
      operation.conversationEpoch === this.conversationEpoch
    )
  }

  private assertRuntimeRef(ref: CliSessionRef): void {
    if (ref.runtimeId !== this.runtime.runtimeId) {
      throw new Error(
        `Cannot use ${ref.runtimeId} session with ${this.runtime.runtimeId} runtime.`,
      )
    }
  }

  private assertActive(): void {
    if (this.disposed)
      throw new Error('CLI conversation controller is disposed.')
  }

  private publishError(error: unknown): void {
    const errorMessage = getErrorMessage(error)
    const isTurnError =
      this.pendingOptimisticUserMessageId !== null ||
      this.snapshot.runState === 'running' ||
      this.snapshot.runState === 'waiting_for_approval' ||
      this.snapshot.runState === 'waiting_for_user'
    this.pendingOptimisticUserMessageId = null
    this.currentTurnMessageIds.clear()
    this.publish({
      ...this.snapshot,
      ...(isTurnError
        ? { messages: appendAssistantError(this.snapshot, errorMessage) }
        : {}),
      runState: 'error',
      error: errorMessage,
      isCompacting: false,
    })
  }

  private createEmptySnapshot(runtime: CliRuntime): CliConversationSnapshot {
    return Object.freeze({
      surfaceId: this.createSurfaceId(),
      runtimeId: runtime.runtimeId,
      messages: Object.freeze([]),
      compactionBoundaries: Object.freeze([]),
      sessionFallbackBoundaries: Object.freeze([]),
      turnConfigurationByUserMessageId: Object.freeze({}),
      sessionRef: null,
      runState: 'idle',
      isCompacting: false,
      error: null,
      configuration: null,
      contextUsage: null,
    })
  }

  private createSurfaceId(): string {
    return `cli:${this.runtime.runtimeId}:${uuidv4()}`
  }

  private publish(snapshot: CliConversationSnapshot): void {
    if (this.disposed) return
    this.snapshot = Object.freeze(snapshot)
    this.notify()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
