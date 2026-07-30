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

export const resetCliSessionForAssistantChange = ({
  activeRuntimeId,
  controller,
  currentAssistantId,
  nextAssistantId,
}: {
  activeRuntimeId: ChatRuntimeId
  controller: CliConversationController | null
  currentAssistantId: string
  nextAssistantId: string
}): boolean => {
  if (
    activeRuntimeId === 'yolo' ||
    currentAssistantId === nextAssistantId ||
    !controller
  ) {
    return false
  }
  controller.resetSession()
  return true
}

export const dispatchComposerSubmit = async <T>({
  runtimeId,
  submitYolo,
  submitCli,
}: {
  runtimeId: ChatRuntimeId
  submitYolo: () => T | Promise<T>
  submitCli: (runtimeId: CliRuntimeId) => T | Promise<T>
}): Promise<T> =>
  runtimeId === 'yolo' ? await submitYolo() : await submitCli(runtimeId)

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
  await controller.sendTurn({
    userMessage: {
      ...stampedUserMessage,
      promptContent: content,
    },
    content,
  })
  throwIfAborted()

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
  throwIfAborted()
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
