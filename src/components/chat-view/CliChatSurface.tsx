import type { SerializedEditorState } from 'lexical'
import { SquareTerminal } from 'lucide-react'
import { Notice, TFile } from 'obsidian'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import type { AgentConversationRunSummary } from '../../core/agent/service'
import {
  type ChatRuntimeActions,
  type CliConversationSnapshot,
  type CliRuntimeModel,
  type CliRuntimeRunState,
  type CliRuntimeScope,
  type CliSessionRef,
  type CliTurnConfiguration,
  RUNTIME_CAPABILITIES,
} from '../../core/cli-runtime'
import type {
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'
import type { ChatTimelineItem } from '../../types/chat-timeline'
import type { MentionableAssistantQuote } from '../../types/mentionable'
import type { GroupEditSummary } from '../../utils/chat/editSummary'
import { buildChatTimelineItems } from '../../utils/chat/timeline'
import { getNodeWindow } from '../../utils/dom/window-context'

import AssistantErrorCard from './AssistantErrorCard'
import AssistantMessageReasoning from './AssistantMessageReasoning'
import { CliRuntimeControls } from './chat-input/CliRuntimeControls'
import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'
import { ChatRuntimeActionsProvider } from './chat-runtime-actions-context'
import { getChatSurfacePreset } from './chat-surface-presets'
import type { ChatSurfacePreset } from './chat-surface-presets'
import { CliSubagentProvider } from './cli-subagent-context'
import type { AcceptedCliDraft } from './cliChatIntegration'
import { buildCliSubagentReadModel } from './cliSubagentReadModel'
import type { ConversationTimelineRendererContract } from './conversation-surface-contract'
import { ConversationSurface } from './ConversationSurface'
import { LiveEdgeFollowProvider } from './live-edge-follow-context'
import { useAutoScroll } from './useAutoScroll'
import { useChatHistoryWindow } from './useChatHistoryWindow'
import {
  findAssistantGroupIdForRunAnchor,
  useChatTimelineReadModel,
  useStableChatTimelineItems,
} from './useChatTimelineReadModel'
import { useHistoricalUserMessageDismiss } from './useHistoricalUserMessageDismiss'
import UserMessageItem from './UserMessageItem'

const ACTIVE_RUN_STATES: ReadonlySet<CliRuntimeRunState> = new Set([
  'running',
  'waiting_for_approval',
  'waiting_for_user',
])

const noop = (): void => undefined
const noopToolMessageUpdate = (_message: ChatToolMessage): void => undefined

export type CliChatSurfaceProps = {
  snapshot: CliConversationSnapshot
  /** Resolves display names for `snapshot.sessionFallbackBoundaries`' notices. */
  cliRuntimeScope?: CliRuntimeScope
  presentedDraft: AcceptedCliDraft | null
  showEmptyState: boolean
  actions: ChatRuntimeActions
  footerContent: ReactNode
  emptyStateWorkspaceTitle?: ReactNode
  onRewriteUserMessage: (
    sourceMessage: ChatUserMessage,
    editedMessage: ChatUserMessage,
    configuration?: CliTurnConfiguration,
  ) => Promise<void>
  onPresentedDraftHandled: (draft: AcceptedCliDraft) => void
  cachedModels?: readonly CliRuntimeModel[]
  assistantQuotes?: readonly MentionableAssistantQuote[]
  onQuoteAssistantSelection?: (payload: {
    id?: string
    annotationNumber?: number
    messageId: string
    conversationId: string
    content: string
    comment?: string
    selector?: MentionableAssistantQuote['selector']
  }) => void
  onDeleteAssistantQuote?: (id: string) => void
}

export const handleVisiblePresentedCliDraft = ({
  presentedDraft,
  messages,
  forceScrollToBottom,
  onHandled,
}: {
  presentedDraft: AcceptedCliDraft | null
  messages: readonly ChatMessage[]
  forceScrollToBottom: () => void
  onHandled: (draft: AcceptedCliDraft) => void
}): boolean => {
  if (
    !presentedDraft ||
    !messages.some((message) => message.id === presentedDraft.userMessage.id)
  ) {
    return false
  }

  forceScrollToBottom()
  onHandled(presentedDraft)
  return true
}

const plainTextToEditorState = (text: string): SerializedEditorState =>
  ({
    root: {
      children: [
        {
          children: text.split('\n').flatMap((line, index) => [
            ...(index > 0 ? [{ type: 'linebreak', version: 1 }] : []),
            ...(line
              ? [
                  {
                    detail: 0,
                    format: 0,
                    mode: 'normal',
                    style: '',
                    text: line,
                    type: 'text',
                    version: 1,
                  },
                ]
              : []),
          ]),
          direction: null,
          format: '',
          indent: 0,
          type: 'paragraph',
          version: 1,
        },
      ],
      direction: null,
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  }) as unknown as SerializedEditorState

const getPromptContentText = (
  promptContent: ChatUserMessage['promptContent'],
): string => {
  if (!promptContent) return ''
  if (typeof promptContent === 'string') return promptContent
  return promptContent
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
}

const getUserMessageText = (message: ChatUserMessage): string => {
  const editorText = message.content
    ? editorStateToPlainText(message.content)
    : ''
  return editorText || getPromptContentText(message.promptContent)
}

const toEditableUserMessage = (message: ChatUserMessage): ChatUserMessage =>
  message.content
    ? message
    : {
        ...message,
        content: plainTextToEditorState(getUserMessageText(message)),
      }

export const getCliUserMessageDisplay = (
  message: ChatUserMessage,
  draft: ChatUserMessage,
  isFocused: boolean,
): ChatUserMessage => (isFocused ? draft : message)

function CliUserMessage({
  message,
  isFocused,
  isActionDisabled,
  canEdit,
  onFocus,
  onSubmit,
  runtimeId,
  configuration,
  turnConfiguration,
  cachedModels,
  onControlPopoverOpenChange,
  preset,
}: {
  message: ChatUserMessage
  isFocused: boolean
  isActionDisabled: boolean
  canEdit: boolean
  onFocus: () => void
  onSubmit: (
    editedMessage: ChatUserMessage,
    configuration?: CliTurnConfiguration,
  ) => void
  runtimeId: CliConversationSnapshot['runtimeId']
  configuration: CliConversationSnapshot['configuration']
  turnConfiguration?: CliTurnConfiguration
  cachedModels?: readonly CliRuntimeModel[]
  onControlPopoverOpenChange?: (isOpen: boolean) => void
  preset: ChatSurfacePreset
}) {
  const canonicalMessage = useMemo(
    () => toEditableUserMessage(message),
    [message],
  )
  const [draft, setDraft] = useState<ChatUserMessage>(() => canonicalMessage)
  const [draftConfiguration, setDraftConfiguration] =
    useState<CliTurnConfiguration | null>(null)
  useEffect(() => {
    if (!isFocused) {
      setDraft(canonicalMessage)
      setDraftConfiguration(null)
    }
  }, [canonicalMessage, isFocused])
  const selectedTurnConfiguration = draftConfiguration ?? turnConfiguration
  const editorConfiguration = useMemo(() => {
    const models = configuration?.models ?? [...(cachedModels ?? [])]
    if (!configuration && !selectedTurnConfiguration && models.length === 0) {
      return null
    }
    return {
      models,
      modelId:
        selectedTurnConfiguration?.modelId ?? configuration?.modelId ?? null,
      reasoningEffort:
        selectedTurnConfiguration?.reasoningEffort ??
        configuration?.reasoningEffort ??
        null,
    }
  }, [cachedModels, configuration, selectedTurnConfiguration])
  const displayMessage = getCliUserMessageDisplay(
    canonicalMessage,
    draft,
    isFocused,
  )

  return (
    <UserMessageItem
      message={displayMessage}
      displayMentionables={displayMessage.mentionables}
      isFocused={isFocused}
      isActionDisabled={isActionDisabled}
      canEdit={canEdit}
      chatUserInputRef={noop}
      onInputChange={(content) =>
        setDraft((current) => ({
          ...current,
          content,
          promptContent: null,
        }))
      }
      onSubmit={(content) => {
        onSubmit(
          { ...draft, content, promptContent: null },
          editorConfiguration
            ? {
                modelId: editorConfiguration.modelId,
                reasoningEffort: editorConfiguration.reasoningEffort,
              }
            : undefined,
        )
      }}
      onFocus={onFocus}
      onControlPopoverOpenChange={onControlPopoverOpenChange}
      onMentionablesChange={(mentionables) =>
        setDraft((current) => ({ ...current, mentionables }))
      }
      onSelectedSkillsChange={(selectedSkills) =>
        setDraft((current) => ({ ...current, selectedSkills }))
      }
      showReasoningSelect={preset.userMessage.showReasoningSelect}
      showModelControl={preset.userMessage.showModelControl}
      runtimeControls={
        <CliRuntimeControls
          configuration={editorConfiguration}
          cachedModels={cachedModels}
          runtimeId={runtimeId}
          disabled={isActionDisabled}
          onModelChange={(modelId) => {
            setDraftConfiguration({
              modelId,
              reasoningEffort: null,
            })
          }}
          onReasoningEffortChange={(reasoningEffort) => {
            setDraftConfiguration((current) => ({
              modelId: current?.modelId ?? editorConfiguration?.modelId ?? null,
              reasoningEffort,
            }))
          }}
        />
      }
      showPlaceholder={preset.userMessage.showPlaceholder}
      allowAgentModeOption={preset.userMessage.allowAgentModeOption}
    />
  )
}

const getNativeConversationId = (sessionRef: CliSessionRef): string =>
  `${sessionRef.runtimeId}:${sessionRef.nativeSessionId}`

const getLatestUserMessageId = (
  messages: readonly ChatMessage[],
): string | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user') return message.id
  }
  return undefined
}

const getSourceUserMessageForGroup = (
  messages: readonly ChatMessage[],
  groupMessageIds: readonly string[],
): ChatUserMessage | null => {
  const groupIds = new Set(groupMessageIds)
  const groupStartIndex = messages.findIndex((message) =>
    groupIds.has(message.id),
  )
  if (groupStartIndex < 0) return null
  for (let index = groupStartIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user') return message
  }
  return null
}

export const getActiveStreamingMessageId = (
  messages: readonly ChatMessage[],
  runState: CliRuntimeRunState,
): string | null => {
  if (!ACTIVE_RUN_STATES.has(runState)) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) continue
    if (message.role === 'user') return null
    return message.id
  }
  return null
}

/**
 * True when the active turn already has UI the user can watch: substance
 * (text / reasoning / tools / errors) or an empty streaming shell that itself
 * carries the Requesting indicator. Empty completed shells do not count.
 */
export const hasCliTurnResponseFeedback = (
  messages: readonly ChatMessage[],
): boolean => {
  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUserIndex = index
      break
    }
  }
  if (lastUserIndex < 0) return false

  for (let index = lastUserIndex + 1; index < messages.length; index += 1) {
    const message = messages[index]
    if (!message) continue
    if (message.role === 'tool') return true
    if (message.role !== 'assistant') continue
    if (message.content.trim().length > 0) return true
    if ((message.reasoning ?? '').trim().length > 0) return true
    if ((message.toolCallRequests?.length ?? 0) > 0) return true
    if (message.annotations) return true
    if (
      message.metadata?.generationState === 'error' &&
      Boolean(message.metadata.errorMessage)
    ) {
      return true
    }
    if (message.metadata?.generationState === 'streaming') return true
  }
  return false
}

export const getPendingResponseUserMessageId = (
  messages: readonly ChatMessage[],
  runState: CliRuntimeRunState,
): string | null => {
  if (runState !== 'running') return null
  if (hasCliTurnResponseFeedback(messages)) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user') return message.id
  }
  return null
}

export const getCliTimelineRenderVersion = (
  timelineItem: ChatTimelineItem,
  runState: CliRuntimeRunState,
  focusedUserMessageId: string | null,
): string =>
  `${timelineItem.renderKey}:${
    timelineItem.kind === 'assistant-group' ||
    timelineItem.kind === 'user-message'
      ? timelineItem.revision
      : 0
  }:${runState}:${
    timelineItem.kind === 'user-message' &&
    timelineItem.messageId === focusedUserMessageId
      ? 'editing'
      : 'readonly'
  }`

const toAgentRunStatus = (
  runState: CliRuntimeRunState,
): AgentConversationRunSummary['status'] => {
  if (
    runState === 'running' ||
    runState === 'waiting_for_approval' ||
    runState === 'waiting_for_user'
  ) {
    return 'running'
  }
  return runState
}

const buildRunSummary = ({
  conversationId,
  messages,
  runState,
}: {
  conversationId: string
  messages: readonly ChatMessage[]
  runState: CliRuntimeRunState
}): AgentConversationRunSummary => {
  const isActive = ACTIVE_RUN_STATES.has(runState)
  return {
    conversationId,
    anchorMessageId: getLatestUserMessageId(messages),
    status: toAgentRunStatus(runState),
    isRunning: runState === 'running',
    isActive,
    isAbortable: isActive,
    isQueueable: false,
    isWaitingApproval:
      runState === 'waiting_for_approval' || runState === 'waiting_for_user',
    isWaitingUserInput: runState === 'waiting_for_user',
  }
}

export function CliChatSurface({
  snapshot,
  cliRuntimeScope,
  presentedDraft,
  showEmptyState,
  actions,
  footerContent,
  emptyStateWorkspaceTitle,
  onRewriteUserMessage,
  onPresentedDraftHandled,
  cachedModels,
  assistantQuotes = [],
  onQuoteAssistantSelection = noop,
  onDeleteAssistantQuote = noop,
}: CliChatSurfaceProps) {
  const app = useApp()
  const { t } = useLanguage()
  const [focusedUserMessageId, setFocusedUserMessageId] = useState<
    string | null
  >(null)
  const sessionFallbackBoundaries = snapshot.sessionFallbackBoundaries ?? []
  // Resolves the unreachable profile's display name for the fallback
  // notice. Fetched lazily — only conversations that actually hit a
  // recovery pay for it — and best-effort: a profile deleted after causing
  // the very fallback being described may no longer be discoverable, in
  // which case the notice falls back to showing its raw id.
  const [hermesProfileDisplayNames, setHermesProfileDisplayNames] = useState<
    ReadonlyMap<string, string>
  >(new Map())
  useEffect(() => {
    if (!cliRuntimeScope || sessionFallbackBoundaries.length === 0) return
    let cancelled = false
    void cliRuntimeScope
      .listHermesProfiles()
      .then((profiles) => {
        if (cancelled) return
        setHermesProfileDisplayNames(
          new Map(profiles.map((profile) => [profile.id, profile.displayName])),
        )
      })
      .catch((error: unknown) => {
        console.error(
          '[YOLO] Failed to resolve Hermes profile names for session fallback notice',
          error,
        )
      })
    return () => {
      cancelled = true
    }
  }, [cliRuntimeScope, sessionFallbackBoundaries.length > 0])
  const isConversationBusy =
    snapshot.isCompacting === true || ACTIVE_RUN_STATES.has(snapshot.runState)
  const canRewriteUserMessage =
    RUNTIME_CAPABILITIES[snapshot.runtimeId].supportsMessageRewrite
  const cliSubagentReadModel = useMemo(
    () => buildCliSubagentReadModel(snapshot.messages, snapshot.runtimeId),
    [snapshot.messages, snapshot.runtimeId],
  )
  const messages = cliSubagentReadModel.visibleMessages
  const conversationId = snapshot.surfaceId
  const readModel = useChatTimelineReadModel({ messages })
  const {
    windowedGroupedChatMessages,
    hasEarlierMessages,
    hasNewerMessages,
    loadEarlier,
    loadNewer,
    growWindowToFillViewport,
    historyWindowKey,
    resetToLatest,
  } = useChatHistoryWindow({
    conversationId,
    groupedChatMessages: readModel.groupedChatMessages,
  })
  const activeStreamingMessageId = getActiveStreamingMessageId(
    messages,
    snapshot.runState,
  )
  const pendingResponseUserMessageId = getPendingResponseUserMessageId(
    messages,
    snapshot.runState,
  )
  const pendingCompactionAnchorMessageId = snapshot.isCompacting
    ? (messages.at(-1)?.id ?? null)
    : null
  const sessionFallbackDividers = useMemo(
    () =>
      sessionFallbackBoundaries.map((boundary) => {
        const profileId = boundary.requestedRef.profileId
        const profileName =
          (profileId ? hermesProfileDisplayNames.get(profileId) : undefined) ??
          profileId ??
          t('chat.cliSurface.sessionFallbackUnknownProfile', 'previous')
        return {
          id: `${boundary.id}-divider`,
          anchorMessageId: boundary.afterMessageId,
          title: t(
            'chat.cliSurface.sessionFallbackDividerTitle',
            'Switched to default',
          ),
          description: t(
            'chat.cliSurface.sessionFallbackDividerDescription',
            'The original agent "{profile}" is unavailable, so this conversation switched to default — earlier messages are not in its memory.',
          ).replace('{profile}', profileName),
        }
      }),
    [hermesProfileDisplayNames, sessionFallbackBoundaries, t],
  )
  const timelineItems = useMemo(() => {
    const items = buildChatTimelineItems({
      groupedChatMessages: windowedGroupedChatMessages,
      revisionsById: readModel.revisionsById,
      compactionDividerAnchorMessageIds: snapshot.compactionBoundaries.flatMap(
        (boundary) =>
          boundary.afterMessageId ? [boundary.afterMessageId] : [],
      ),
      compactionDividers: snapshot.compactionBoundaries.map((boundary) => ({
        id: `${boundary.id}-divider`,
        anchorMessageId: boundary.afterMessageId,
        compaction: null,
      })),
      latestCompaction: null,
      pendingCompactionAnchorMessageId,
      sessionFallbackDividers,
      activeEditableMessageId: null,
      activeStreamingMessageId,
    })
    const itemsWithPending = [...items]

    if (pendingResponseUserMessageId) {
      const pendingResponseItem: ChatTimelineItem = {
        kind: 'pending-response',
        id: `pending-response:${pendingResponseUserMessageId}`,
        renderKey: `pending-response:${pendingResponseUserMessageId}`,
        sourceUserMessageId: pendingResponseUserMessageId,
        spacingBefore: 24,
        isPinnedForRender: true,
        isStreaming: true,
      }
      const bottomAnchorIndex = itemsWithPending.findIndex(
        (item) => item.kind === 'bottom-anchor',
      )
      itemsWithPending.splice(
        bottomAnchorIndex < 0 ? itemsWithPending.length : bottomAnchorIndex,
        0,
        pendingResponseItem,
      )
    }
    return itemsWithPending
  }, [
    activeStreamingMessageId,
    pendingCompactionAnchorMessageId,
    pendingResponseUserMessageId,
    readModel,
    sessionFallbackDividers,
    snapshot.compactionBoundaries,
    windowedGroupedChatMessages,
  ])
  const stableTimelineItems = useStableChatTimelineItems(timelineItems)
  const cliSubagentRenderVersion = useMemo(
    () =>
      [...cliSubagentReadModel.presentationsByToolCallId.values()]
        .map(
          (presentation) =>
            `${presentation.toolCallId}:${presentation.taskId ?? ''}:${
              presentation.status
            }:${presentation.subtitle ?? ''}`,
        )
        .join('|'),
    [cliSubagentReadModel.presentationsByToolCallId],
  )
  const runSummary = useMemo(
    () =>
      buildRunSummary({
        conversationId,
        messages: snapshot.messages,
        runState: snapshot.runState,
      }),
    [conversationId, snapshot.messages, snapshot.runState],
  )
  const runSummaryAssistantGroupId = useMemo(
    () =>
      findAssistantGroupIdForRunAnchor({
        groupedChatMessages: readModel.groupedChatMessages,
        anchorMessageId: runSummary.anchorMessageId,
      }),
    [readModel.groupedChatMessages, runSummary.anchorMessageId],
  )
  const handleOpenEditSummaryFile = useCallback(
    ({ path }: GroupEditSummary['files'][number]) => {
      const targetFile = app.vault.getAbstractFileByPath(path)
      if (!(targetFile instanceof TFile)) {
        new Notice(t('chat.editSummary.fileMissing', '文件不存在或已被移动。'))
        return
      }
      void app.workspace.getLeaf(false).openFile(targetFile)
    },
    [app.vault, app.workspace, t],
  )

  const chatMessagesRef = useRef<HTMLDivElement>(null)
  const [chatMessagesElement, setChatMessagesElement] =
    useState<HTMLElement | null>(null)
  const [bottomSentinelElement, setBottomSentinelElement] =
    useState<HTMLElement | null>(null)
  const dismissHistoricalUserMessage = useCallback(() => {
    setFocusedUserMessageId(null)
  }, [])
  const {
    onControlPopoverOpenChange: onHistoricalUserMessageControlPopoverOpenChange,
  } = useHistoricalUserMessageDismiss({
    activeMessageId: focusedUserMessageId,
    containerRef: chatMessagesRef,
    onDismiss: dismissHistoricalUserMessage,
  })
  const {
    autoScrollToBottom,
    forceScrollToBottom,
    isAutoFollowEnabled,
    scrollController,
  } = useAutoScroll({
    scrollContainerRef: chatMessagesRef,
    scrollContainerElement: chatMessagesElement,
    bottomSentinelElement,
    followKey: conversationId,
    canFollowLiveEdge: !hasNewerMessages,
  })
  useEffect(() => {
    if (isConversationBusy) resetToLatest()
  }, [isConversationBusy, resetToLatest])
  useLayoutEffect(() => {
    autoScrollToBottom()
  }, [autoScrollToBottom, snapshot.messages])
  const handleForceScrollToBottom = useCallback(() => {
    resetToLatest()
    // popout 是独立 BrowserWindow：帧调度必须取滚动容器所属窗口。
    getNodeWindow(chatMessagesRef.current).requestAnimationFrame(() =>
      forceScrollToBottom(),
    )
  }, [chatMessagesRef, forceScrollToBottom, resetToLatest])
  const handledPresentedMessageIdRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (
      !presentedDraft ||
      handledPresentedMessageIdRef.current === presentedDraft.userMessage.id
    ) {
      return
    }

    const handled = handleVisiblePresentedCliDraft({
      presentedDraft,
      messages: snapshot.messages,
      forceScrollToBottom: handleForceScrollToBottom,
      onHandled: onPresentedDraftHandled,
    })
    if (handled) {
      handledPresentedMessageIdRef.current = presentedDraft.userMessage.id
    }
  }, [
    handleForceScrollToBottom,
    onPresentedDraftHandled,
    presentedDraft,
    snapshot.messages,
  ])

  const surfacePreset = getChatSurfacePreset('cli')
  const timelineRendererContract =
    useMemo<ConversationTimelineRendererContract>(
      () => ({
        messagesById: readModel.messagesById,
        preset: surfacePreset,
        compaction: {
          pendingTitle: t('chat.compaction.pendingTitle', '正在压缩上下文'),
          pendingDescription: t(
            'chat.compaction.pendingStatus',
            '正在整理上下文，稍后将从新的上下文继续。',
          ),
          dividerTitle: t('chat.compaction.dividerTitle', '从这里继续当前任务'),
          dividerDescription: t(
            'chat.compaction.dividerDescription',
            '以上对话已压缩为摘要，以下回复基于摘要继续',
          ),
        },
        renderUserMessage: (message) => (
          <CliUserMessage
            key={message.id}
            message={message}
            isFocused={
              canRewriteUserMessage && focusedUserMessageId === message.id
            }
            isActionDisabled={isConversationBusy}
            canEdit={canRewriteUserMessage}
            onSubmit={(editedMessage, configuration) => {
              if (!canRewriteUserMessage) return
              if (
                editorStateToPlainText(editedMessage.content).trim() === '' &&
                editedMessage.mentionables.length === 0
              ) {
                return
              }
              setFocusedUserMessageId(null)
              void onRewriteUserMessage(
                message,
                editedMessage,
                configuration,
              ).catch(() => {
                setFocusedUserMessageId(message.id)
              })
            }}
            onFocus={() => {
              if (!isConversationBusy && canRewriteUserMessage) {
                setFocusedUserMessageId(message.id)
              }
            }}
            runtimeId={snapshot.runtimeId}
            configuration={snapshot.configuration}
            turnConfiguration={
              snapshot.turnConfigurationByUserMessageId?.[message.id]
            }
            cachedModels={cachedModels}
            onControlPopoverOpenChange={
              onHistoricalUserMessageControlPopoverOpenChange
            }
            preset={surfacePreset}
          />
        ),
        getAssistantGroupProps: (messageGroup, timelineItem) => {
          if (!snapshot.sessionRef) return null
          const sourceUserMessage = getSourceUserMessageForGroup(
            snapshot.messages,
            timelineItem.messageIds,
          )
          return {
            conversationId: getNativeConversationId(snapshot.sessionRef),
            conversationRunSummary:
              timelineItem.groupId === runSummaryAssistantGroupId
                ? runSummary
                : undefined,
            isApplying: false,
            activeApplyRequestKey: null,
            onApply: noop,
            onToolMessageUpdate: noopToolMessageUpdate,
            onRecoverAnswerUserQuestion: noop,
            onEditStart: noop,
            onEditCancel: noop,
            onEditSave: noop,
            onDeleteGroup: noop,
            onRetryGroup: () => {
              if (!sourceUserMessage) return
              void onRewriteUserMessage(
                sourceUserMessage,
                toEditableUserMessage(sourceUserMessage),
                snapshot.turnConfigurationByUserMessageId?.[
                  sourceUserMessage.id
                ],
              ).catch(() => undefined)
            },
            onBranchGroup: noop,
            onQuoteAssistantSelection,
            assistantQuotes,
            onDeleteAssistantQuote,
            onOpenEditSummaryFile: handleOpenEditSummaryFile,
          }
        },
        getAssistantActionOverrides: (_messageGroup, timelineItem) => ({
          showRetryAction:
            canRewriteUserMessage &&
            getSourceUserMessageForGroup(
              snapshot.messages,
              timelineItem.messageIds,
            ) !== null,
        }),
        wrapAssistantGroup: (content) => {
          if (!snapshot.sessionRef) return content
          return (
            <CliSubagentProvider
              value={{
                actions,
                sessionRef: snapshot.sessionRef,
                presentationsByToolCallId:
                  cliSubagentReadModel.presentationsByToolCallId,
              }}
            >
              <ChatRuntimeActionsProvider
                actions={actions}
                conversation={snapshot.sessionRef}
              >
                {content}
              </ChatRuntimeActionsProvider>
            </CliSubagentProvider>
          )
        },
        renderUnboundAssistantGroup: (messageGroup) => {
          const failedMessage = messageGroup.find(
            (message) =>
              message.role === 'assistant' &&
              message.metadata?.generationState === 'error' &&
              message.metadata.errorMessage,
          )
          const failedMetadata =
            failedMessage?.role === 'assistant'
              ? failedMessage.metadata
              : undefined
          return (
            <div className="yolo-chat-messages-assistant">
              <AssistantErrorCard
                errorMessage={
                  failedMetadata?.errorMessage ??
                  snapshot.error ??
                  t(
                    'chat.cliSurface.unboundMessageError',
                    'CLI 会话尚未建立，无法显示这条 Provider 消息。',
                  )
                }
                errorDetail={failedMetadata?.errorDetail}
              />
            </div>
          )
        },
        renderPendingResponse: () => (
          <div className="yolo-chat-messages-assistant">
            <AssistantMessageReasoning
              reasoning=""
              hasAnswerContent={false}
              generationState="streaming"
            />
          </div>
        ),
        bottomAnchorClassName: 'yolo-cli-chat-surface__bottom-anchor',
      }),
      [
        actions,
        assistantQuotes,
        focusedUserMessageId,
        handleOpenEditSummaryFile,
        cachedModels,
        cliSubagentReadModel.presentationsByToolCallId,
        canRewriteUserMessage,
        isConversationBusy,
        onHistoricalUserMessageControlPopoverOpenChange,
        onDeleteAssistantQuote,
        onQuoteAssistantSelection,
        onRewriteUserMessage,
        readModel.messagesById,
        runSummary,
        runSummaryAssistantGroupId,
        snapshot.sessionRef,
        snapshot.configuration,
        snapshot.messages,
        snapshot.runtimeId,
        snapshot.turnConfigurationByUserMessageId,
        t,
      ],
    )
  const renderVersion = useCallback(
    (timelineItem: ChatTimelineItem): string => {
      const baseVersion = getCliTimelineRenderVersion(
        timelineItem,
        snapshot.runState,
        focusedUserMessageId,
      )
      if (timelineItem.kind !== 'assistant-group') return baseVersion
      const quoteVersion = assistantQuotes
        .filter((quote) => timelineItem.messageIds.includes(quote.messageId))
        .map(
          (quote) =>
            `${quote.id ?? ''}:${quote.selector?.start ?? ''}:${quote.selector?.end ?? ''}:${quote.comment ?? ''}`,
        )
        .join(',')
      return `${baseVersion}:${cliSubagentRenderVersion}:${quoteVersion}`
    },
    [
      assistantQuotes,
      cliSubagentRenderVersion,
      focusedUserMessageId,
      snapshot.runState,
    ],
  )

  return (
    // CLI 消息经由 CLI runtime 快照而非 agent render stream，但这一层的
    // markdown 播放器共用同一套跟随通道，缺省 no-op 会让流式跟随失效。
    <LiveEdgeFollowProvider onFollowLiveEdge={autoScrollToBottom}>
      <ConversationSurface
        chatMode="agent"
        yoloEnabled={false}
        showEmptyState={showEmptyState}
        groupedChatMessagesLength={windowedGroupedChatMessages.length}
        isAutoFollowEnabled={isAutoFollowEnabled}
        currentConversationId={conversationId}
        chatTimelineItems={stableTimelineItems}
        timelineRenderVersion={renderVersion}
        chatMessagesRef={chatMessagesRef}
        onScrollContainerChange={setChatMessagesElement}
        onBottomSentinelChange={setBottomSentinelElement}
        scrollController={scrollController}
        timelineRendererContract={timelineRendererContract}
        editingAssistantMessageId={null}
        hasEarlierMessages={hasEarlierMessages}
        hasNewerMessages={hasNewerMessages}
        onLoadEarlier={loadEarlier}
        onLoadNewer={loadNewer}
        onGrowWindowToFillViewport={growWindowToFillViewport}
        historyWindowKey={historyWindowKey}
        onForceScrollToBottom={handleForceScrollToBottom}
        hasStreamingMessages={isConversationBusy}
        scrollToBottomLabel={t('chat.scrollToBottom', '回到底部')}
        scrollToBottomWhileStreamingLabel={t(
          'chat.scrollToBottomWhileStreaming',
          '回到底部继续跟随',
        )}
        emptyStateAskTitle={t('chat.cliSurface.emptyTitle', '使用 CLI Agent')}
        emptyStateAgentTitle={t('chat.cliSurface.emptyTitle', '使用 CLI Agent')}
        emptyStateAgentFullTitle={t(
          'chat.cliSurface.emptyTitle',
          '使用 CLI Agent',
        )}
        emptyStateWorkspaceTitle={emptyStateWorkspaceTitle}
        emptyStateAskDescription={t(
          'chat.cliSurface.emptyDescription',
          '连接 Claude Code 或 Codex，直接在本机执行复杂任务',
        )}
        emptyStateAgentDescription={t(
          'chat.cliSurface.emptyDescription',
          '连接 Claude Code 或 Codex，直接在本机执行复杂任务',
        )}
        emptyStateAgentFullDescription={t(
          'chat.cliSurface.emptyDescription',
          '连接 Claude Code 或 Codex，直接在本机执行复杂任务',
        )}
        emptyStateIcon={<SquareTerminal size={18} strokeWidth={2} />}
        emptyStateIconMode="cli"
        footerContent={footerContent}
      />
    </LiveEdgeFollowProvider>
  )
}

export default CliChatSurface
