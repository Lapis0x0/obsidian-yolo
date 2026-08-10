import type {
  ChatRuntimeId,
  CliConversationController,
  CliConversationSnapshot,
  CliPermissionProfileUpdate,
  CliRuntimeConfigurationUpdate,
  CliRuntimeId,
  CliRuntimeScope,
  CliSessionHydration,
  CliSessionRef,
  CliTurnConfiguration,
} from '../../core/cli-runtime'
import { buildCliTurnContent } from '../../core/cli-runtime'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { ChatUserMessage } from '../../types/chat'
import type { ContentPart } from '../../types/llm/request'
import { stampUserMessageTimeContext } from '../../utils/prompt/timeContext'

import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'
import { resolveCliRuntimePreference } from './cliRuntimePreferences'

const ACTIVE_CLI_RUN_STATES: ReadonlySet<CliConversationSnapshot['runState']> =
  new Set(['running', 'waiting_for_approval', 'waiting_for_user'])

const toError = (error: unknown): Error =>
  error instanceof Error
    ? error
    : new Error(typeof error === 'string' ? error : 'Unknown CLI session error')

const getTurnConfiguration = (
  snapshot: CliConversationSnapshot,
): CliTurnConfiguration | undefined =>
  snapshot.configuration
    ? {
        modelId: snapshot.configuration.modelId,
        reasoningEffort: snapshot.configuration.reasoningEffort,
      }
    : undefined

const getLatestUserMessage = (
  snapshot: CliConversationSnapshot,
  fallback: ChatUserMessage,
): ChatUserMessage => {
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index]
    if (message?.role === 'user') return { ...fallback, id: message.id }
  }
  return fallback
}

export const prepareCliConversation = async ({
  controller,
  scope,
  runtimeId,
  settings,
  permissionProfile,
}: {
  controller: CliConversationController
  scope: CliRuntimeScope
  runtimeId: CliRuntimeId
  settings: YoloSettings
  permissionProfile?: CliPermissionProfileUpdate
}): Promise<void> => {
  if (permissionProfile) {
    await controller.updatePermissionProfile(permissionProfile)
  }
  const existingSessionRef = controller.getSnapshot().sessionRef
  let initialConfiguration: CliRuntimeConfigurationUpdate = {}
  if (existingSessionRef && runtimeId === 'claude-code') {
    const remembered =
      await scope.sessionService.getRememberedConfiguration(existingSessionRef)
    initialConfiguration = {
      ...(remembered?.modelId !== undefined
        ? { modelId: remembered.modelId }
        : {}),
      ...(remembered?.reasoningEffort !== undefined
        ? { reasoningEffort: remembered.reasoningEffort }
        : {}),
    }
  } else if (!existingSessionRef) {
    const stagedConfiguration = controller.getSnapshot().configuration
    initialConfiguration = stagedConfiguration
      ? {
          modelId: stagedConfiguration.modelId,
          reasoningEffort: stagedConfiguration.reasoningEffort,
        }
      : resolveCliRuntimePreference(
          settings,
          runtimeId,
          scope.getModelCatalogSnapshot().get(runtimeId) ?? [],
        )
  }
  await controller.ensureReady(initialConfiguration)
}

export type CliSubmissionPhase = 'idle' | 'preparing' | 'sending' | 'accepted'

export type AcceptedCliDraft = Readonly<{
  token: number
  draftRevision: number
  userMessage: ChatUserMessage
}>

export type CliChatOperationSnapshot = Readonly<{
  submissionPhase: CliSubmissionPhase
  presentedDraft: AcceptedCliDraft | null
  acceptedDraft: AcceptedCliDraft | null
  isTransitioning: boolean
}>

type CliSubmissionOperation = {
  token: number
  draftRevision: number
  phase: Exclude<CliSubmissionPhase, 'idle'>
  abortController: AbortController
  sendSettled: Promise<boolean>
  resolveSendSettled: (accepted: boolean) => void
  sendSettlementResolved: boolean
}

const EMPTY_OPERATION_SNAPSHOT: CliChatOperationSnapshot = Object.freeze({
  submissionPhase: 'idle',
  presentedDraft: null,
  acceptedDraft: null,
  isTransitioning: false,
})

const isActiveRunState = (snapshot: CliConversationSnapshot): boolean =>
  ACTIVE_CLI_RUN_STATES.has(snapshot.runState)

/**
 * Coordinates transient UI operations for one controller across React host
 * rebuilds. The controller remains the only source of transcript/session/run
 * state; this object only guards preparation, accepted-draft cleanup and
 * stale session transitions.
 */
export class CliChatOperationCoordinator {
  private readonly listeners = new Set<() => void>()
  private submission: CliSubmissionOperation | null = null
  private presentedDraft: AcceptedCliDraft | null = null
  private acceptedDraft: AcceptedCliDraft | null = null
  private nextSubmissionToken = 1
  private transitionToken = 0
  private transitioning = false
  private stopping: Promise<void> | null = null
  private cancellation: Promise<void> | null = null
  private snapshot: CliChatOperationSnapshot = EMPTY_OPERATION_SNAPSHOT

  getSnapshot = (): CliChatOperationSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  beginSubmission(draftRevision: number): {
    token: number
    signal: AbortSignal
  } | null {
    if (this.transitioning || this.stopping) return null
    if (this.submission?.phase === 'accepted') {
      // Overlay persistence is post-acceptance bookkeeping. It must not keep a
      // completed native turn from accepting the next composer submission.
      this.submission = null
    } else if (this.submission) {
      return null
    }
    let resolveSendSettled!: (accepted: boolean) => void
    const sendSettled = new Promise<boolean>((resolve) => {
      resolveSendSettled = resolve
    })
    const operation: CliSubmissionOperation = {
      token: this.nextSubmissionToken++,
      draftRevision,
      phase: 'preparing',
      abortController: new AbortController(),
      sendSettled,
      resolveSendSettled,
      sendSettlementResolved: false,
    }
    this.submission = operation
    this.publish()
    return { token: operation.token, signal: operation.abortController.signal }
  }

  markSending(token: number): boolean {
    if (!this.isCurrentSubmission(token)) return false
    this.submission!.phase = 'sending'
    this.publish()
    return true
  }

  markPresented(token: number, userMessage: ChatUserMessage): boolean {
    if (!this.isCurrentSubmission(token)) return false
    this.presentedDraft = Object.freeze({
      token,
      draftRevision: this.submission!.draftRevision,
      userMessage,
    })
    this.publish()
    return true
  }

  markAccepted(token: number, userMessage: ChatUserMessage): boolean {
    if (!this.isCurrentSubmission(token)) return false
    this.submission!.phase = 'accepted'
    this.acceptedDraft = Object.freeze({
      token,
      draftRevision: this.submission!.draftRevision,
      userMessage,
    })
    this.resolveSubmission(this.submission!, true)
    this.publish()
    return true
  }

  finishSubmission(token: number): void {
    if (!this.isCurrentSubmission(token)) return
    this.resolveSubmission(this.submission!, false)
    this.submission = null
    this.publish()
  }

  acknowledgeAcceptedDraft(token: number): void {
    if (this.acceptedDraft?.token !== token) return
    this.acceptedDraft = null
    this.publish()
  }

  acknowledgePresentedDraft(token: number): void {
    if (this.presentedDraft?.token !== token) return
    this.presentedDraft = null
    this.publish()
  }

  abortPreparation(): CliSubmissionPhase {
    const phase = this.submission?.phase ?? 'idle'
    this.submission?.abortController.abort()
    return phase
  }

  async cancelCurrentOperation(
    controller: CliConversationController,
  ): Promise<void> {
    if (this.stopping) return await this.stopping
    ++this.transitionToken
    this.transitioning = false
    const operation = this.submission
    this.abortPreparation()
    const stopping = (async () => {
      await this.settleAndCancel(controller, operation)
    })()
    this.stopping = stopping.finally(() => {
      this.stopping = null
      this.publish()
    })
    this.publish()
    await this.stopping
  }

  async transition(
    _controller: CliConversationController,
    action: (isCurrent: () => boolean) => void | Promise<void>,
  ): Promise<boolean> {
    const token = ++this.transitionToken
    this.transitioning = true
    this.publish()

    try {
      await Promise.resolve()
      if (token !== this.transitionToken) return false
      const isCurrent = () => token === this.transitionToken
      await action(isCurrent)
      return isCurrent()
    } catch (error) {
      if (token !== this.transitionToken) return false
      throw error
    } finally {
      if (token === this.transitionToken) {
        this.transitioning = false
        this.publish()
      }
    }
  }

  private isCurrentSubmission(token: number): boolean {
    return this.submission?.token === token
  }

  private resolveSubmission(
    operation: CliSubmissionOperation,
    accepted: boolean,
  ): void {
    if (operation.sendSettlementResolved) return
    operation.sendSettlementResolved = true
    operation.resolveSendSettled(accepted)
  }

  private async settleAndCancel(
    controller: CliConversationController,
    operation: CliSubmissionOperation | null,
  ): Promise<void> {
    const phase = operation?.phase ?? 'idle'
    if (phase === 'preparing' && operation) {
      this.resolveSubmission(operation, false)
      if (this.submission === operation) {
        this.submission = null
        this.publish()
      }
    }

    let earlyCancellationError: unknown
    const controllerSnapshot = controller.getSnapshot()
    const shouldCancelBeforeSettlement =
      phase !== 'accepted' &&
      (controllerSnapshot.sessionRef !== null ||
        isActiveRunState(controllerSnapshot) ||
        phase !== 'idle')
    if (shouldCancelBeforeSettlement) {
      try {
        await this.cancelController(controller)
      } catch (error) {
        earlyCancellationError = error
      }
    }

    const accepted = operation ? await operation.sendSettled : false
    if (accepted) {
      // sendTurn may have entered while the provider had no active native turn,
      // making the first cancellation a no-op. Once accepted, cancel again.
      await this.cancelController(controller)
      if (this.submission === operation) {
        this.submission = null
        this.publish()
      }
      return
    }
    if (earlyCancellationError) throw toError(earlyCancellationError)
    if (phase === 'preparing') controller.resetSession()
  }

  private cancelController(
    controller: CliConversationController,
  ): Promise<void> {
    this.cancellation ??= controller.cancel().finally(() => {
      this.cancellation = null
    })
    return this.cancellation
  }

  private publish(): void {
    this.snapshot = Object.freeze({
      submissionPhase: this.submission?.phase ?? 'idle',
      presentedDraft: this.presentedDraft,
      acceptedDraft: this.acceptedDraft,
      isTransitioning: this.transitioning || this.stopping !== null,
    })
    for (const listener of [...this.listeners]) listener()
  }
}

const operationCoordinators = new WeakMap<
  CliConversationController,
  CliChatOperationCoordinator
>()

export const getCliChatOperationCoordinator = (
  controller: CliConversationController,
): CliChatOperationCoordinator => {
  const existing = operationCoordinators.get(controller)
  if (existing) return existing
  const coordinator = new CliChatOperationCoordinator()
  operationCoordinators.set(controller, coordinator)
  return coordinator
}

export const resolveChatRuntimeId = ({
  requestedRuntimeId,
  hasCliRuntimeScope,
  cliRuntimeAvailable,
}: {
  requestedRuntimeId?: ChatRuntimeId
  hasCliRuntimeScope: boolean
  cliRuntimeAvailable: boolean
}): ChatRuntimeId =>
  requestedRuntimeId !== undefined &&
  requestedRuntimeId !== 'yolo' &&
  hasCliRuntimeScope &&
  cliRuntimeAvailable
    ? requestedRuntimeId
    : 'yolo'

export const beginChatRuntimeNavigation = (
  generation: { current: number },
  isMounted: () => boolean,
): (() => boolean) => {
  const token = invalidateChatRuntimeNavigation(generation)
  return () => token === generation.current && isMounted()
}

export const invalidateChatRuntimeNavigation = (generation: {
  current: number
}): number => ++generation.current

export const isCliConversationActive = (
  snapshot: CliConversationSnapshot | null,
): boolean =>
  snapshot !== null &&
  (snapshot.isCompacting === true ||
    ACTIVE_CLI_RUN_STATES.has(snapshot.runState))

export const resolveActiveCliConversationSnapshot = (
  activeRuntimeId: ChatRuntimeId,
  snapshot: CliConversationSnapshot | null,
): CliConversationSnapshot | null =>
  activeRuntimeId !== 'yolo' && snapshot?.runtimeId === activeRuntimeId
    ? snapshot
    : null

export const shouldHydrateSeededCliSession = (
  seededRef: CliSessionRef | null | undefined,
  snapshot: CliConversationSnapshot,
): seededRef is CliSessionRef =>
  seededRef !== null && seededRef !== undefined && snapshot.sessionRef === null

export const shouldClearAcceptedCliDraft = ({
  acceptedDraft,
  currentDraft,
  currentDraftRevision,
}: {
  acceptedDraft: AcceptedCliDraft
  currentDraft: ChatUserMessage
  currentDraftRevision: number
}): boolean =>
  currentDraftRevision === acceptedDraft.draftRevision &&
  currentDraft.id === acceptedDraft.userMessage.id

export const openCliSession = async ({
  scope,
  ref,
  isCurrent = () => true,
}: {
  scope: CliRuntimeScope
  ref: CliSessionRef
  isCurrent?: () => boolean
}): Promise<{
  controller: CliConversationController
  hydration: CliSessionHydration | null
  overlayError: Error | null
}> => {
  const controller = scope.selectConversationSession(ref)
  const existingSnapshot = controller.getSnapshot()
  const alreadyHydrated =
    existingSnapshot.sessionRef?.runtimeId === ref.runtimeId &&
    existingSnapshot.sessionRef.nativeSessionId === ref.nativeSessionId
  const hydration = alreadyHydrated
    ? {
        ref,
        messages: [...existingSnapshot.messages],
        compactionBoundaries: [...existingSnapshot.compactionBoundaries],
      }
    : await controller.hydrateSession(ref, (messages) =>
        scope.sessionService.restoreSessionOverlay(ref, messages),
      )
  let overlayError: Error | null = null
  if (hydration && isCurrent()) {
    try {
      await scope.sessionService.recordOpenedSession(hydration)
    } catch (error) {
      overlayError = toError(error)
    }
  }
  return { controller, hydration, overlayError }
}

export const openCliSessionForNavigation = async ({
  isCurrent,
  ...input
}: Parameters<typeof openCliSession>[0] & {
  isCurrent: () => boolean
}): Promise<Awaited<ReturnType<typeof openCliSession>> | null> => {
  if (!isCurrent()) return null
  const result = await openCliSession({ ...input, isCurrent })
  return result.hydration && isCurrent() ? result : null
}

export type SubmitCliComposerTurnInput = {
  settings: YoloSettings
  scope: CliRuntimeScope
  controller: CliConversationController
  runtimeId: CliRuntimeId
  userMessage: ChatUserMessage
  environmentContext: readonly ContentPart[]
  permissionProfile?: CliPermissionProfileUpdate
  signal?: AbortSignal
  onSendStarted?: () => boolean | undefined
  onPresented?: (userMessage: ChatUserMessage) => void
  onAccepted?: (userMessage: ChatUserMessage) => void
  encodeTurnContent?: typeof buildCliTurnContent
}

export const submitCliComposerTurn = async ({
  settings,
  scope,
  controller,
  runtimeId,
  userMessage,
  environmentContext,
  permissionProfile,
  signal,
  onSendStarted,
  onPresented,
  onAccepted,
  encodeTurnContent = buildCliTurnContent,
}: SubmitCliComposerTurnInput): Promise<{
  sessionRef: CliSessionRef
  userMessage: ChatUserMessage
  overlayError: Error | null
}> => {
  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw new DOMException('CLI submission aborted.', 'AbortError')
    }
  }
  throwIfAborted()
  const stampedUserMessage = stampUserMessageTimeContext(userMessage, true)
  const content = encodeTurnContent({
    runtimeId,
    text: stampedUserMessage.content
      ? editorStateToPlainText(stampedUserMessage.content)
      : '',
    mentionables: stampedUserMessage.mentionables,
    selectedSkills: stampedUserMessage.selectedSkills,
    timeContext: stampedUserMessage.timeContext,
    environmentContext,
  })
  const stagedTurn = controller.stageTurn(stampedUserMessage)
  onPresented?.(stampedUserMessage)
  try {
    throwIfAborted()
    await prepareCliConversation({
      controller,
      scope,
      runtimeId,
      settings,
      permissionProfile,
    })
    throwIfAborted()
    if (onSendStarted?.() === false) {
      throw new DOMException('CLI submission superseded.', 'AbortError')
    }
    await controller.sendTurn({
      userMessage: stampedUserMessage,
      content,
      selectedSkills: stampedUserMessage.selectedSkills,
    })
    onAccepted?.(stampedUserMessage)
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      controller.rejectStagedTurn(stagedTurn, error)
    }
    throw error
  }

  const snapshot = controller.getSnapshot()
  if (!snapshot.sessionRef) {
    throw new Error('CLI runtime accepted a turn without binding a session.')
  }
  let overlayError: Error | null = null
  try {
    await scope.sessionService.recordUserDisplay(
      snapshot.sessionRef,
      content,
      getLatestUserMessage(snapshot, stampedUserMessage),
      getTurnConfiguration(snapshot),
    )
    await scope.sessionService.recordOpenedSession({
      ref: snapshot.sessionRef,
      messages: [...snapshot.messages],
      compactionBoundaries: [...(snapshot.compactionBoundaries ?? [])],
    })
  } catch (error) {
    overlayError = toError(error)
  }
  return {
    sessionRef: snapshot.sessionRef,
    userMessage: stampedUserMessage,
    overlayError,
  }
}

export type RewriteCliConversationTurnInput = {
  settings: YoloSettings
  scope: CliRuntimeScope
  controller: CliConversationController
  runtimeId: CliRuntimeId
  sourceUserMessageId: string
  userMessage: ChatUserMessage
  environmentContext: readonly ContentPart[]
  configuration?: CliTurnConfiguration
  permissionProfile?: CliPermissionProfileUpdate
  encodeTurnContent?: typeof buildCliTurnContent
}

export const rewriteCliConversationTurn = async ({
  settings,
  scope,
  controller,
  runtimeId,
  sourceUserMessageId,
  userMessage,
  environmentContext,
  configuration,
  permissionProfile,
  encodeTurnContent = buildCliTurnContent,
}: RewriteCliConversationTurnInput): Promise<{
  sessionRef: CliSessionRef
  userMessage: ChatUserMessage
  overlayError: Error | null
}> => {
  const previousSessionRef = controller.getSnapshot().sessionRef
  if (!previousSessionRef) {
    throw new Error('CLI session is not ready for historical editing.')
  }
  const previousMessages = controller.getSnapshot().messages
  const sourceIndex = previousMessages.findIndex(
    (message) => message.role === 'user' && message.id === sourceUserMessageId,
  )
  const discardedUserMessageIds = previousMessages
    .slice(Math.max(0, sourceIndex))
    .flatMap((message) => (message.role === 'user' ? [message.id] : []))
  await prepareCliConversation({
    controller,
    scope,
    runtimeId,
    settings,
    permissionProfile,
  })
  if (configuration) {
    const appliedConfiguration =
      await controller.updateConfiguration(configuration)
    if (!appliedConfiguration) {
      throw new Error(
        'CLI runtime did not accept the edited turn configuration.',
      )
    }
  }
  const stampedUserMessage = stampUserMessageTimeContext(userMessage, true)
  const content = encodeTurnContent({
    runtimeId,
    text: stampedUserMessage.content
      ? editorStateToPlainText(stampedUserMessage.content)
      : '',
    mentionables: stampedUserMessage.mentionables,
    selectedSkills: stampedUserMessage.selectedSkills,
    timeContext: stampedUserMessage.timeContext,
    environmentContext,
  })
  await controller.rewriteTurn({
    sourceUserMessageId,
    userMessage: stampedUserMessage,
    content,
    selectedSkills: stampedUserMessage.selectedSkills,
  })
  const sessionRef = controller.getSnapshot().sessionRef
  if (!sessionRef) {
    throw new Error('CLI runtime rewrote a turn without binding a session.')
  }

  let overlayError: Error | null = null
  try {
    await scope.sessionService.rebindOverlay(
      previousSessionRef,
      sessionRef,
      discardedUserMessageIds,
    )
    const rewriteSnapshot = controller.getSnapshot()
    await scope.sessionService.recordUserDisplay(
      sessionRef,
      content,
      getLatestUserMessage(rewriteSnapshot, stampedUserMessage),
      getTurnConfiguration(rewriteSnapshot),
    )
    await scope.sessionService.recordOpenedSession({
      ref: sessionRef,
      messages: [...controller.getSnapshot().messages],
      compactionBoundaries: [
        ...(controller.getSnapshot().compactionBoundaries ?? []),
      ],
    })
  } catch (error) {
    overlayError = toError(error)
  }
  return { sessionRef, userMessage: stampedUserMessage, overlayError }
}
