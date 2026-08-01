import type { SerializedEditorState } from 'lexical'
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
import { buildMessageTimelineItems } from '../../utils/chat/timeline'

import AssistantMessageReasoning from './AssistantMessageReasoning'
import AssistantToolMessageGroupItem from './AssistantToolMessageGroupItem'
import { CliRuntimeControls } from './chat-input/CliRuntimeControls'
import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'
import { ChatRuntimeActionsProvider } from './chat-runtime-actions-context'
import { ChatConversationPane } from './ChatConversationPane'
import { useAutoScroll } from './useAutoScroll'
import {
  useChatTimelineReadModel,
  useStableChatTimelineItems,
} from './useChatTimelineReadModel'
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
  onModelChange?: (modelId: string | null) => void
  onReasoningEffortChange?: (effort: string | null) => void
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
  onModelChange,
  onReasoningEffortChange,
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
  onModelChange?: (modelId: string | null) => void
  onReasoningEffortChange?: (effort: string | null) => void
}) {
  const [draft, setDraft] = useState<ChatUserMessage>(() =>
    toEditableUserMessage(message),
  )
  const [draftConfiguration, setDraftConfiguration] =
    useState<CliTurnConfiguration | null>(null)
  useEffect(() => {
    if (!isFocused) {
      setDraft(toEditableUserMessage(message))
      setDraftConfiguration(null)
    }
  }, [isFocused, message])
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

  return (
    <UserMessageItem
      message={draft}
      displayMentionables={draft.mentionables}
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
            onModelChange?.(modelId)
          }}
          onReasoningEffortChange={(reasoningEffort) => {
            setDraftConfiguration((current) => ({
              modelId:
                current?.modelId ?? editorConfiguration?.modelId ?? null,
              reasoningEffort,
            }))
            onReasoningEffortChange?.(reasoningEffort)
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

const getLatestAssistantGroupId = (
  groupedChatMessages: (ChatUserMessage | AssistantToolMessageGroup)[],
): string | null => {
  for (let index = groupedChatMessages.length - 1; index >= 0; index -= 1) {
    const messageOrGroup = groupedChatMessages[index]
    if (Array.isArray(messageOrGroup)) {
      return messageOrGroup[0]?.id ?? null
    }
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

const getPendingResponseUserMessageId = (
  messages: readonly ChatMessage[],
  runState: CliRuntimeRunState,
): string | null => {
  if (runState !== 'running') return null
  const latestMessage = messages.at(-1)
  return latestMessage?.role === 'user' ? latestMessage.id : null
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
  onModelChange,
  onReasoningEffortChange,
}: CliChatSurfaceProps) {
  const app = useApp()
  const { t } = useLanguage()
  const [focusedUserMessageId, setFocusedUserMessageId] = useState<
    string | null
  >(null)
  const messages = useMemo(() => [...snapshot.messages], [snapshot.messages])
  const readModel = useChatTimelineReadModel({ messages })
  const activeStreamingMessageId = getActiveStreamingMessageId(
    snapshot.messages,
    snapshot.runState,
  )
  const pendingResponseUserMessageId = getPendingResponseUserMessageId(
    snapshot.messages,
    snapshot.runState,
  )
  const timelineItems = useMemo(() => {
    const items = buildMessageTimelineItems({
      groupedChatMessages: readModel.groupedChatMessages,
      revisionsById: readModel.revisionsById,
      activeEditableMessageId: null,
      activeStreamingMessageId,
      includeBottomAnchor: true,
    })
    if (!pendingResponseUserMessageId) return items

    const bottomAnchorIndex = items.findIndex(
      (item) => item.kind === 'bottom-anchor',
    )
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
    if (bottomAnchorIndex < 0) return [...items, pendingResponseItem]
    return [
      ...items.slice(0, bottomAnchorIndex),
      pendingResponseItem,
      ...items.slice(bottomAnchorIndex),
    ]
  }, [activeStreamingMessageId, pendingResponseUserMessageId, readModel])
  const stableTimelineItems = useStableChatTimelineItems(timelineItems)
  const latestAssistantGroupId = getLatestAssistantGroupId(
    readModel.groupedChatMessages,
  )
  const conversationId = snapshot.surfaceId
  const runSummary = useMemo(
    () =>
      buildRunSummary({
        conversationId,
        messages: snapshot.messages,
        runState: snapshot.runState,
      }),
    [conversationId, snapshot.messages, snapshot.runState],
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
  const { autoScrollToBottom, forceScrollToBottom, isAutoFollowEnabled } =
    useAutoScroll({
      scrollContainerRef: chatMessagesRef,
      scrollContainerElement: chatMessagesElement,
      bottomSentinelElement,
      followKey: conversationId,
    })
  useLayoutEffect(() => {
    autoScrollToBottom()
  }, [autoScrollToBottom, snapshot.messages])

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
            isActionDisabled={ACTIVE_RUN_STATES.has(snapshot.runState)}
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
              if (!ACTIVE_RUN_STATES.has(snapshot.runState)) {
                setFocusedUserMessageId(message.id)
              }
            }}
            runtimeId={snapshot.runtimeId}
            configuration={snapshot.configuration}
            turnConfiguration={
              snapshot.turnConfigurationByUserMessageId?.[message.id]
            }
            cachedModels={cachedModels}
            onModelChange={onModelChange}
            onReasoningEffortChange={onReasoningEffortChange}
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

      return (
        <ChatRuntimeActionsProvider
          actions={actions}
          conversation={snapshot.sessionRef}
        >
          <AssistantToolMessageGroupItem
            messages={messageGroup}
            conversationId={nativeConversationId}
            conversationRunSummary={
              timelineItem.groupId === latestAssistantGroupId
                ? runSummary
                : undefined
            }
            showInlineInfo={false}
            showRetryAction={false}
            showInsertAction={false}
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
            onRetryGroup={noop}
            onBranchGroup={noop}
            onQuoteAssistantSelection={noop}
            onOpenEditSummaryFile={handleOpenEditSummaryFile}
          />
        </ChatRuntimeActionsProvider>
      )
    },
    [
      actions,
      conversationId,
      focusedUserMessageId,
      handleOpenEditSummaryFile,
      latestAssistantGroupId,
      cachedModels,
      onModelChange,
      onReasoningEffortChange,
      onRewriteUserMessage,
      readModel.messagesById,
      runSummary,
      snapshot.sessionRef,
      snapshot.configuration,
      snapshot.runtimeId,
      snapshot.turnConfigurationByUserMessageId,
    ],
  )

  const renderVersion = useCallback(
    (timelineItem: ChatTimelineItem): string =>
      getCliTimelineRenderVersion(
        timelineItem,
        snapshot.runState,
        focusedUserMessageId,
      ),
    [focusedUserMessageId, snapshot.runState],
  )

  return (
    <ChatConversationPane
      chatMode="agent"
      yoloEnabled={false}
      showEmptyState={showEmptyState}
      groupedChatMessagesLength={readModel.groupedChatMessages.length}
      isAutoFollowEnabled={isAutoFollowEnabled}
      currentConversationId={conversationId}
      chatTimelineItems={stableTimelineItems}
      timelineRenderVersion={renderVersion}
      chatMessagesRef={chatMessagesRef}
      onScrollContainerChange={setChatMessagesElement}
      onBottomSentinelChange={setBottomSentinelElement}
      renderChatTimelineItem={renderTimelineItem}
      editingAssistantMessageId={null}
      onForceScrollToBottom={forceScrollToBottom}
      hasStreamingMessages={ACTIVE_RUN_STATES.has(snapshot.runState)}
      scrollToBottomLabel={t('chat.scrollToBottom', '回到底部')}
      scrollToBottomWhileStreamingLabel={t(
        'chat.scrollToBottomWhileStreaming',
        '回到底部继续跟随',
      )}
      emptyStateAskTitle={t('chat.cliSurface.emptyTitle', '开始一个 CLI 会话')}
      emptyStateAgentTitle={t(
        'chat.cliSurface.emptyTitle',
        '开始一个 CLI 会话',
      )}
      emptyStateAgentFullTitle={t(
        'chat.cliSurface.emptyTitle',
        '开始一个 CLI 会话',
      )}
      emptyStateWorkspaceTitle={emptyStateWorkspaceTitle}
      emptyStateAskDescription={t(
        'chat.cliSurface.emptyDescription',
        '发送消息后，原生 CLI 对话会显示在这里。',
      )}
      emptyStateAgentDescription={t(
        'chat.cliSurface.emptyDescription',
        '发送消息后，原生 CLI 对话会显示在这里。',
      )}
      emptyStateAgentFullDescription={t(
        'chat.cliSurface.emptyDescription',
        '发送消息后，原生 CLI 对话会显示在这里。',
      )}
      footerContent={footerContent}
    />
  )
}

export default CliChatSurface
