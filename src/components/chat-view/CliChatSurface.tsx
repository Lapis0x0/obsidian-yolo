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
import type {
  ChatRuntimeActions,
  CliConversationSnapshot,
  CliRuntimeModel,
  CliRuntimeRunState,
  CliSessionRef,
  CliTurnConfiguration,
} from '../../core/cli-runtime'
import type {
  AssistantToolMessageGroup,
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'
import type { ChatTimelineItem } from '../../types/chat-timeline'
import type { GroupEditSummary } from '../../utils/chat/editSummary'
import { buildChatTimelineItems } from '../../utils/chat/timeline'
import DotLoader from '../common/DotLoader'

import AssistantMessageReasoning from './AssistantMessageReasoning'
import AssistantToolMessageGroupItem from './AssistantToolMessageGroupItem'
import { CliRuntimeControls } from './chat-input/CliRuntimeControls'
import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'
import { ChatRuntimeActionsProvider } from './chat-runtime-actions-context'
import { ChatConversationPane } from './ChatConversationPane'
import { CliSubagentProvider } from './cli-subagent-context'
import { buildCliSubagentReadModel } from './cliSubagentReadModel'
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
const PENDING_RESPONSE_ESTIMATED_HEIGHT = 56

export type CliChatSurfaceProps = {
  snapshot: CliConversationSnapshot
  showEmptyState: boolean
  actions: ChatRuntimeActions
  footerContent: ReactNode
  emptyStateWorkspaceTitle?: ReactNode
  onRewriteUserMessage: (
    sourceMessage: ChatUserMessage,
    editedMessage: ChatUserMessage,
    configuration?: CliTurnConfiguration,
  ) => Promise<void>
  cachedModels?: readonly CliRuntimeModel[]
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
  onFocus,
  onSubmit,
  runtimeId,
  configuration,
  turnConfiguration,
  cachedModels,
  onControlPopoverOpenChange,
}: {
  message: ChatUserMessage
  isFocused: boolean
  isActionDisabled: boolean
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
      showReasoningSelect={false}
      showModelControl={false}
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
      showPlaceholder={false}
      allowAgentModeOption={false}
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

const getActiveStreamingMessageId = (
  messages: readonly ChatMessage[],
  runState: CliRuntimeRunState,
): string | null => {
  if (!ACTIVE_RUN_STATES.has(runState)) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') return message.id
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
  showEmptyState,
  actions,
  footerContent,
  emptyStateWorkspaceTitle,
  onRewriteUserMessage,
  cachedModels,
}: CliChatSurfaceProps) {
  const app = useApp()
  const { t } = useLanguage()
  const [focusedUserMessageId, setFocusedUserMessageId] = useState<
    string | null
  >(null)
  const isConversationBusy =
    snapshot.isCompacting === true || ACTIVE_RUN_STATES.has(snapshot.runState)
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
        estimatedHeight: PENDING_RESPONSE_ESTIMATED_HEIGHT,
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
  const { autoScrollToBottom, forceScrollToBottom, isAutoFollowEnabled } =
    useAutoScroll({
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
    requestAnimationFrame(() => forceScrollToBottom())
  }, [forceScrollToBottom, resetToLatest])

  const renderTimelineItem = useCallback(
    (timelineItem: ChatTimelineItem): ReactNode => {
      if (timelineItem.kind === 'bottom-anchor') {
        return <div className="yolo-cli-chat-surface__bottom-anchor" />
      }

      if (timelineItem.kind === 'user-message') {
        const message = readModel.messagesById.get(timelineItem.messageId)
        if (message?.role !== 'user') return null
        return (
          <CliUserMessage
            key={message.id}
            message={message}
            isFocused={focusedUserMessageId === message.id}
            isActionDisabled={isConversationBusy}
            onSubmit={(editedMessage, configuration) => {
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
              if (!isConversationBusy) {
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
          />
        )
      }

      if (timelineItem.kind === 'pending-response') {
        return (
          <div className="yolo-chat-messages-assistant">
            <AssistantMessageReasoning
              reasoning=""
              hasAnswerContent={false}
              generationState="streaming"
            />
          </div>
        )
      }

      if (timelineItem.kind === 'compaction-pending') {
        return (
          <div
            className="yolo-chat-compaction-pending"
            data-anchor-message-id={timelineItem.anchorMessageId}
          >
            <div className="yolo-chat-compaction-pending__loader">
              <DotLoader
                text={t('chat.compaction.pendingTitle', '正在压缩上下文')}
              />
            </div>
            <div className="yolo-chat-compaction-pending__description">
              {t(
                'chat.compaction.pendingStatus',
                '正在整理上下文，稍后将从新的上下文继续。',
              )}
            </div>
          </div>
        )
      }

      if (timelineItem.kind === 'compaction-divider') {
        return (
          <div className="yolo-chat-compaction-divider">
            <div className="yolo-chat-compaction-divider__title">
              {t('chat.compaction.dividerTitle', '从这里继续当前任务')}
            </div>
            <div className="yolo-chat-compaction-divider__line" />
            <div className="yolo-chat-compaction-divider__content">
              <div className="yolo-chat-compaction-divider__description">
                {t(
                  'chat.compaction.dividerDescription',
                  '以上对话已压缩为摘要，以下回复基于摘要继续',
                )}
              </div>
            </div>
          </div>
        )
      }

      if (timelineItem.kind !== 'assistant-group') return null

      const messageGroup = timelineItem.messageIds
        .map((messageId) => readModel.messagesById.get(messageId))
        .filter(
          (message): message is AssistantToolMessageGroup[number] =>
            message !== undefined && message.role !== 'user',
        )
      if (messageGroup.length === 0) return null
      if (!snapshot.sessionRef) {
        throw new Error(
          'CLI assistant/tool groups require a bound provider session.',
        )
      }
      const nativeConversationId = getNativeConversationId(snapshot.sessionRef)
      const sourceUserMessage = getSourceUserMessageForGroup(
        snapshot.messages,
        timelineItem.messageIds,
      )

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
            <AssistantToolMessageGroupItem
              messages={messageGroup}
              conversationId={nativeConversationId}
              conversationRunSummary={
                timelineItem.groupId === runSummaryAssistantGroupId
                  ? runSummary
                  : undefined
              }
              showInlineInfo
              showRetryAction={sourceUserMessage !== null}
              showInsertAction
              showCopyAction
              showBranchAction={false}
              showEditAction={false}
              showDeleteAction={false}
              showQuoteAction={false}
              isApplying={false}
              activeApplyRequestKey={null}
              onApply={noop}
              onToolMessageUpdate={noopToolMessageUpdate}
              onRecoverAnswerUserQuestion={noop}
              onEditStart={noop}
              onEditCancel={noop}
              onEditSave={noop}
              onDeleteGroup={noop}
              onRetryGroup={() => {
                if (!sourceUserMessage) return
                void onRewriteUserMessage(
                  sourceUserMessage,
                  toEditableUserMessage(sourceUserMessage),
                  snapshot.turnConfigurationByUserMessageId?.[
                    sourceUserMessage.id
                  ],
                ).catch(() => undefined)
              }}
              onBranchGroup={noop}
              onQuoteAssistantSelection={noop}
              onOpenEditSummaryFile={handleOpenEditSummaryFile}
            />
          </ChatRuntimeActionsProvider>
        </CliSubagentProvider>
      )
    },
    [
      actions,
      conversationId,
      focusedUserMessageId,
      handleOpenEditSummaryFile,
      cachedModels,
      cliSubagentReadModel.presentationsByToolCallId,
      isConversationBusy,
      onHistoricalUserMessageControlPopoverOpenChange,
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
      return timelineItem.kind === 'assistant-group'
        ? `${baseVersion}:${cliSubagentRenderVersion}`
        : baseVersion
    },
    [cliSubagentRenderVersion, focusedUserMessageId, snapshot.runState],
  )

  return (
    <ChatConversationPane
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
      renderChatTimelineItem={renderTimelineItem}
      editingAssistantMessageId={null}
      hasEarlierMessages={hasEarlierMessages}
      hasNewerMessages={hasNewerMessages}
      onLoadEarlier={loadEarlier}
      onLoadNewer={loadNewer}
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
  )
}

export default CliChatSurface
