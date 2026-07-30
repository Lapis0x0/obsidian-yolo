import type { App } from 'obsidian'

import type {
  ChatRuntimeId,
  CliConversationController,
  CliConversationSnapshot,
  CliRuntimeId,
  CliRuntimeScope,
  CliSessionDiscoveryResult,
  CliSessionHydration,
  CliSessionRef,
} from '../../core/cli-runtime'
import {
  buildCliTurnContent,
  resolveCliAssistantBinding,
} from '../../core/cli-runtime'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { ChatUserMessage } from '../../types/chat'
import { stampUserMessageTimeContext } from '../../utils/prompt/timeContext'

import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'

const ACTIVE_CLI_RUN_STATES: ReadonlySet<CliConversationSnapshot['runState']> =
  new Set(['running', 'waiting_for_approval', 'waiting_for_user'])

const toError = (error: unknown): Error =>
  error instanceof Error
    ? error
    : new Error(typeof error === 'string' ? error : 'Unknown CLI session error')

export type CliSubmissionPhase = 'idle' | 'preparing' | 'sending' | 'accepted'

export type AcceptedCliDraft = Readonly<{
  token: number
  draftRevision: number
  userMessage: ChatUserMessage
}>

export type CliChatOperationSnapshot = Readonly<{
  submissionPhase: CliSubmissionPhase
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
    controller: CliConversationController,
    action: (isCurrent: () => boolean) => void | Promise<void>,
  ): Promise<boolean> {
    const token = ++this.transitionToken
    this.transitioning = true
    this.publish()

    try {
      if (this.stopping) await this.stopping
      if (token !== this.transitionToken) return false
      const submission = this.submission
      this.abortPreparation()
      await this.settleAndCancel(controller, submission)
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
  const token = ++generation.current
  return () => token === generation.current && isMounted()
}

export const resolveActiveAssistantId = ({
  activeRuntimeId,
  conversationAssistantId,
  cliAssistantId,
}: {
  activeRuntimeId: ChatRuntimeId
  conversationAssistantId: string
  cliAssistantId: string
}): string =>
  activeRuntimeId === 'yolo' ? conversationAssistantId : cliAssistantId

export const isCliConversationActive = (
  snapshot: CliConversationSnapshot | null,
): boolean => snapshot !== null && ACTIVE_CLI_RUN_STATES.has(snapshot.runState)

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

export const shouldLoadYoloHistoryItem = ({
  activeRuntimeId,
  conversationId,
  currentConversationId,
}: {
  activeRuntimeId: ChatRuntimeId
  conversationId: string
  currentConversationId: string
}): boolean =>
  activeRuntimeId !== 'yolo' || conversationId !== currentConversationId

export const shouldBlockCliSessionOpen = ({
  activeRuntimeId,
  isYoloRunActive,
}: {
  activeRuntimeId: ChatRuntimeId
  isYoloRunActive: boolean
}): boolean => activeRuntimeId === 'yolo' && isYoloRunActive

export const selectFreshCliRuntime = (
  scope: CliRuntimeScope,
  runtimeId: CliRuntimeId,
): CliConversationController => {
  const controller = scope.selectConversationRuntime(runtimeId)
  controller.resetSession()
  return controller
}

const findSessionAssistantId = ({
  discoveryResult,
  ref,
  currentAssistantId,
}: {
  discoveryResult?: CliSessionDiscoveryResult
  ref: CliSessionRef
  currentAssistantId: string
}): string => {
  const session = discoveryResult?.sessions.find(
    (candidate) =>
      candidate.ref.runtimeId === ref.runtimeId &&
      candidate.ref.nativeSessionId === ref.nativeSessionId,
  )
  return session?.hasOverlay && session.assistantId
    ? session.assistantId
    : currentAssistantId
}

export const openCliSession = async ({
  scope,
  ref,
  discoveryResult,
  currentAssistantId,
}: {
  scope: CliRuntimeScope
  ref: CliSessionRef
  discoveryResult?: CliSessionDiscoveryResult
  currentAssistantId: string
}): Promise<{
  controller: CliConversationController
  assistantId: string
  hydration: CliSessionHydration | null
  overlayError: Error | null
}> => {
  const assistantId = findSessionAssistantId({
    discoveryResult,
    ref,
    currentAssistantId,
  })
  const controller = scope.selectConversationRuntime(ref.runtimeId)
  const hydration = await controller.hydrateSession(ref)
  let overlayError: Error | null = null
  if (hydration) {
    try {
      await scope.sessionService.recordOpenedSession(hydration, { assistantId })
    } catch (error) {
      overlayError = toError(error)
    }
  }
  return { controller, assistantId, hydration, overlayError }
}

export const openCliSessionForNavigation = async ({
  isCurrent,
  ...input
}: Parameters<typeof openCliSession>[0] & {
  isCurrent: () => boolean
}): Promise<Awaited<ReturnType<typeof openCliSession>> | null> => {
  if (!isCurrent()) return null
  const result = await openCliSession(input)
  return result.hydration && isCurrent() ? result : null
}

export type SubmitCliComposerTurnInput = {
  app: App
  settings: YoloSettings
  scope: CliRuntimeScope
  controller: CliConversationController
  runtimeId: CliRuntimeId
  assistantId: string
  userMessage: ChatUserMessage
  timeContextEnabled: boolean
  signal?: AbortSignal
  onSendStarted?: () => boolean | undefined
  onAccepted?: (userMessage: ChatUserMessage) => void
  resolveAssistantBinding?: typeof resolveCliAssistantBinding
  encodeTurnContent?: typeof buildCliTurnContent
}

export const submitCliComposerTurn = async ({
  app,
  settings,
  scope,
  controller,
  runtimeId,
  assistantId,
  userMessage,
  timeContextEnabled,
  signal,
  onSendStarted,
  onAccepted,
  resolveAssistantBinding = resolveCliAssistantBinding,
  encodeTurnContent = buildCliTurnContent,
}: SubmitCliComposerTurnInput): Promise<{
  userMessage: ChatUserMessage
  overlayError: Error | null
}> => {
  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw new DOMException('CLI submission aborted.', 'AbortError')
    }
  }
  throwIfAborted()
  const stampedUserMessage = stampUserMessageTimeContext(
    userMessage,
    timeContextEnabled,
  )
  const content = encodeTurnContent({
    runtimeId,
    text: stampedUserMessage.content
      ? editorStateToPlainText(stampedUserMessage.content)
      : '',
    mentionables: stampedUserMessage.mentionables,
    selectedSkills: stampedUserMessage.selectedSkills,
    timeContext: stampedUserMessage.timeContext,
  })
  const assistant = await resolveAssistantBinding({
    app,
    settings,
    assistantId,
  })
  throwIfAborted()
  await controller.ensureReady(assistant)
  throwIfAborted()
  if (onSendStarted?.() === false) {
    throw new DOMException('CLI submission superseded.', 'AbortError')
  }
  await controller.sendTurn({
    userMessage: {
      ...stampedUserMessage,
      promptContent: content,
    },
    content,
  })
  onAccepted?.(stampedUserMessage)

  const snapshot = controller.getSnapshot()
  if (!snapshot.sessionRef) {
    throw new Error('CLI runtime accepted a turn without binding a session.')
  }
  let overlayError: Error | null = null
  try {
    await scope.sessionService.recordOpenedSession(
      {
        ref: snapshot.sessionRef,
        messages: [...snapshot.messages],
      },
      { assistantId },
    )
  } catch (error) {
    overlayError = toError(error)
  }
  return { userMessage: stampedUserMessage, overlayError }
}

export const removeCliOverlayAfterConfirmation = async ({
  requestConfirmation,
  removeOverlay,
}: {
  requestConfirmation: (onConfirm: () => void, onCancel: () => void) => void
  removeOverlay: () => Promise<boolean>
}): Promise<boolean> => {
  const confirmed = await new Promise<boolean>((resolve) => {
    requestConfirmation(
      () => resolve(true),
      () => resolve(false),
    )
  })
  return confirmed ? await removeOverlay() : false
}
