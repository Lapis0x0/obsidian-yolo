import type {
  Dispatch,
  MutableRefObject,
  ReactNode,
  SetStateAction,
} from 'react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { useLanguage } from '../../contexts/language-context'
import type { AgentConversationRunSummary } from '../../core/agent/service'
import type {
  ChatRuntimeActions,
  YoloConversationRef,
} from '../../core/cli-runtime'
import type {
  AssistantToolMessageGroup,
  ChatConversationCompactionState,
  ChatMessage,
  ChatSubagentResultMessage,
  ChatTerminalCommandResultMessage,
  ChatUserMessage,
} from '../../types/chat'
import { getLatestChatConversationCompaction } from '../../types/chat'
import type {
  ChatTimelineAssistantGroupItem,
  ChatTimelineItem,
} from '../../types/chat-timeline'
import type { MentionableAssistantQuote } from '../../types/mentionable'
import type { ReasoningLevel } from '../../types/reasoning'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import type { ForegroundAgentVisualTurnPlan } from '../../utils/chat/foregroundAgentVisualTurns'
import {
  buildForegroundAgentVisualTurnPlan,
  getForegroundAgentFooterForGroup,
  reuseForegroundAgentVisualTurnPlan,
} from '../../utils/chat/foregroundAgentVisualTurns'
import {
  getMentionableKey,
  serializeMentionable,
} from '../../utils/chat/mentionable'
import { collectRemovedSelectionHighlightIds } from '../../utils/chat/selection-mentionables'
import { buildChatTimelineItems } from '../../utils/chat/timeline'
import {
  buildSubagentResultMap,
  buildTerminalCommandResultMap,
  collectToolCallIdsFromGroupedMessages,
  reuseShallowEqualMap,
} from '../../utils/chat/tool-result-index'
import { getNodeWindow } from '../../utils/dom/window-context'
import { formatTokenCount } from '../../utils/llm/formatTokenCount'
import { stampUserMessageTimeContext } from '../../utils/prompt/timeContext'

import type { ChatMode } from './chat-input/ChatModeSelect'
import type { ChatUserInputRef } from './chat-input/ChatUserInput'
import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'
import { ChatRuntimeActionsProvider } from './chat-runtime-actions-context'
import { getChatSurfacePreset } from './chat-surface-presets'
import {
  buildAssistantErrorContinuation,
  getDisplayedAssistantToolMessages,
  getSourceUserMessageIdForGroup,
} from './chatRetry'
import type {
  ConversationAssistantGroupProps,
  ConversationTimelineRendererContract,
} from './conversation-surface-contract'
import { ConversationSurface } from './ConversationSurface'
import { syncRenderedLatexSelection } from './latex-copy'
import { LiveEdgeFollowProvider } from './live-edge-follow-context'
import MessageNavigator from './MessageNavigator'
import type { MessageNavigatorAnchor } from './MessageNavigator'
import {
  getNavigatorAssistantText,
  getPromptContentText,
  normalizeNavigatorPreview,
} from './messageNavigatorUtils'
import QueryProgress from './QueryProgress'
import type { QueryProgressState } from './QueryProgress'
import { useAutoScroll } from './useAutoScroll'
import type { useChatDomainActions } from './useChatDomainActions'
import { useChatHistoryWindow } from './useChatHistoryWindow'
import type { useChatInputController } from './useChatInputController'
import type { useChatRuntimePreferences } from './useChatRuntimePreferences'
import type { ChatTimelineReadModel } from './useChatTimelineReadModel'
import {
  findAssistantGroupIdForRunAnchor,
  useStableChatTimelineItems,
} from './useChatTimelineReadModel'
import { useHistoricalUserMessageDismiss } from './useHistoricalUserMessageDismiss'
import UserMessageItem from './UserMessageItem'
import type { useYoloChatSession } from './useYoloChatSession'

const MESSAGE_NAVIGATOR_MIN_ANCHORS = 3
const MESSAGE_NAVIGATOR_USER_PREVIEW_MAX_LENGTH = 90
const MESSAGE_NAVIGATOR_ASSISTANT_PREVIEW_MAX_LENGTH = 180

// 流式渲染热路径的稳定缓存：必须是模块级单例，与迁移前在 Chat.tsx 顶层的
// 生命周期完全一致——不得随组件重渲染重建。
const renderVersionObjectIds = new WeakMap<object, number>()
let nextRenderVersionObjectId = 1

function getRenderVersionObjectId(value: object | null | undefined): number {
  if (!value) {
    return 0
  }
  const existing = renderVersionObjectIds.get(value)
  if (existing !== undefined) {
    return existing
  }
  const id = nextRenderVersionObjectId
  nextRenderVersionObjectId += 1
  renderVersionObjectIds.set(value, id)
  return id
}

function useLatestRef<T>(value: T) {
  const ref = useRef(value)
  ref.current = value
  return ref
}

const shouldShowContinueResponse = (
  messages: ChatMessage[],
  isPending: boolean,
): boolean => {
  if (isPending) {
    return false
  }

  const lastMessage = messages.at(-1)
  if (lastMessage?.role !== 'tool') {
    return false
  }

  return lastMessage.toolCalls.every((toolCall) =>
    [
      ToolCallResponseStatus.Aborted,
      ToolCallResponseStatus.Rejected,
      ToolCallResponseStatus.Error,
      ToolCallResponseStatus.Success,
    ].includes(toolCall.response.status),
  )
}

const extractSelectedModelIds = (
  mentionables: ChatUserMessage['mentionables'],
): string[] => {
  const seen = new Set<string>()
  const modelIds: string[] = []
  for (const mentionable of mentionables) {
    if (mentionable.type !== 'model' || seen.has(mentionable.modelId)) {
      continue
    }
    seen.add(mentionable.modelId)
    modelIds.push(mentionable.modelId)
  }
  return modelIds
}

type ChatDomainActions = ReturnType<typeof useChatDomainActions>
type ChatInputController = ReturnType<typeof useChatInputController>
type ChatRuntimePreferences = ReturnType<typeof useChatRuntimePreferences>
type YoloChatSessionActions = ReturnType<typeof useYoloChatSession>

export type YoloChatSurfaceProps = {
  // 呈现配置，原样转发给 ConversationSurface
  chatMode: ChatMode
  yoloEnabled: boolean
  showEmptyState: boolean
  currentConversationId: string
  editingAssistantMessageId: string | null
  setEditingAssistantMessageId: Dispatch<SetStateAction<string | null>>
  emptyStateWorkspaceTitle?: ReactNode
  /** See `ChatConversationPaneProps['emptyStateModuleContent']`. */
  emptyStateModuleContent?: {
    title: ReactNode
    description: ReactNode
    icon?: ReactNode
  }
  bottomSpacerHeight: number
  footerContent: ReactNode
  runtimeActions: ChatRuntimeActions
  // ref 注入桥：Chat.tsx 侧 useChatStreamManager / useChatDomainActions 需要
  // 触发本组件内部的滚动动作（详见调用处注释）。
  autoScrollToBottomRef: MutableRefObject<() => void>
  forceScrollToBottomRef: MutableRefObject<() => void>

  // 会话数据（所有权仍在 Chat.tsx / 会话 hooks，此处只读，除非另有说明）
  chatMessages: ChatMessage[]
  chatMessagesStateRef: MutableRefObject<ChatMessage[]>
  chatTimelineReadModel: ChatTimelineReadModel
  activeBranchByUserMessageId: Map<string, string>
  activeBranchByUserMessageIdRef: MutableRefObject<Map<string, string>>
  setActiveBranchByUserMessageId: Dispatch<SetStateAction<Map<string, string>>>
  effectiveCompactionState: ChatConversationCompactionState
  pendingCompactionAnchorMessageId: string | null
  queryProgress: QueryProgressState
  currentConversationRunSummary: AgentConversationRunSummary
  isCurrentConversationRunActive: boolean
  isApplying: boolean
  activeApplyRequestKey: string | null
  undoingEditSummaryTarget: string | null

  // 每消息 / 每会话模型与推理档位状态
  messageModelMap: Map<string, string>
  setMessageModelMap: Dispatch<SetStateAction<Map<string, string>>>
  messageReasoningMap: Map<string, ReasoningLevel>
  setMessageReasoningMap: Dispatch<SetStateAction<Map<string, ReasoningLevel>>>
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>
  conversationModelId: string
  setConversationModelId: Dispatch<SetStateAction<string>>
  conversationModelIdRef: MutableRefObject<Map<string, string>>
  conversationAssistantId: string
  reasoningLevel: ReasoningLevel
  setReasoningLevel: Dispatch<SetStateAction<ReasoningLevel>>
  conversationReasoningLevelRef: MutableRefObject<Map<string, ReasoningLevel>>
  selectedAssistantTimeContextEnabled: boolean
  getReasoningLevelForModelId: (modelId?: string | null) => ReasoningLevel
  persistReasoningLevelForModel: (
    modelId: string,
    level: ReasoningLevel,
  ) => Promise<void>
  normalizeReasoningLevel: (value?: string) => ReasoningLevel | null
  setInputMessage: Dispatch<SetStateAction<ChatUserMessage>>

  // 输入 / 编辑态 bundle
  focusedMessageId: string | null
  setFocusedMessageId: Dispatch<SetStateAction<string | null>>
  inputMessageId: string
  activeAssistantQuotes: MentionableAssistantQuote[]
  chatUserInputRefs: MutableRefObject<Map<string, ChatUserInputRef>>
  registerChatUserInputRef: ChatInputController['registerChatUserInputRef']
  handleQuoteAssistantSelection: ChatInputController['handleQuoteAssistantSelection']
  handleDeleteAssistantQuote: ChatInputController['handleDeleteAssistantQuote']
  releaseHighlightIds: (ids: Iterable<string>) => void

  // 领域动作
  persistActiveBranchSelection: YoloChatSessionActions['persistActiveBranchSelection']
  updateHistoricalUserMessage: YoloChatSessionActions['updateHistoricalUserMessage']
  finalizeHistoricalUserMessageEdit: YoloChatSessionActions['finalizeHistoricalUserMessageEdit']
  dismissHistoricalUserMessage: YoloChatSessionActions['dismissHistoricalUserMessage']
  handleAssistantMessageEditSave: YoloChatSessionActions['handleAssistantMessageEditSave']
  handleAssistantMessageEditCancel: YoloChatSessionActions['handleAssistantMessageEditCancel']
  handleAssistantMessageGroupDelete: YoloChatSessionActions['handleAssistantMessageGroupDelete']
  handleHistoricalUserMessageDelete: YoloChatSessionActions['handleHistoricalUserMessageDelete']
  handleAssistantMessageGroupBranch: YoloChatSessionActions['handleAssistantMessageGroupBranch']
  handleChatModeChange: ChatRuntimePreferences['handleChatModeChange']
  handleUserMessageSubmit: ChatDomainActions['handleUserMessageSubmit']
  handleRecoverPendingToolCall: ChatDomainActions['handleRecoverPendingToolCall']
  // 架构治理第三步分期 C3：retry/continue/recover 收编进
  // ChatSessionController——类型不再从 useChatDomainActions 派生,直接写
  // 消费方（AssistantToolMessageGroupItem）期望的函数签名。
  handleRecoverAnswerUserQuestion: (payload: {
    resolvedMessages: ChatMessage[]
    toolCallId: string
  }) => void
  handleAssistantMessageGroupRetry: (messageIds: string[]) => void
  handleAssistantErrorContinue: (assistantMessageId: string) => void
  handleApply: ChatDomainActions['handleApply']
  handleUndoEditSummary: ChatDomainActions['handleUndoEditSummary']
  handleOpenEditSummaryFile: ChatDomainActions['handleOpenEditSummaryFile']
  handleToolMessageUpdate: ChatDomainActions['handleToolMessageUpdate']
  handleToolCallResponseUpdate: ChatDomainActions['handleToolCallResponseUpdate']
  handleContinueResponse: () => void
}

export function YoloChatSurface({
  chatMode,
  yoloEnabled,
  showEmptyState,
  currentConversationId,
  editingAssistantMessageId,
  setEditingAssistantMessageId,
  emptyStateWorkspaceTitle,
  emptyStateModuleContent,
  bottomSpacerHeight,
  footerContent,
  runtimeActions,
  autoScrollToBottomRef,
  forceScrollToBottomRef,
  chatMessages,
  chatMessagesStateRef,
  chatTimelineReadModel,
  activeBranchByUserMessageId,
  activeBranchByUserMessageIdRef,
  setActiveBranchByUserMessageId,
  effectiveCompactionState,
  pendingCompactionAnchorMessageId,
  queryProgress,
  currentConversationRunSummary,
  isCurrentConversationRunActive,
  isApplying,
  activeApplyRequestKey,
  undoingEditSummaryTarget,
  messageModelMap,
  setMessageModelMap,
  messageReasoningMap,
  setMessageReasoningMap,
  setChatMessages,
  conversationModelId,
  setConversationModelId,
  conversationModelIdRef,
  conversationAssistantId,
  reasoningLevel,
  setReasoningLevel,
  conversationReasoningLevelRef,
  selectedAssistantTimeContextEnabled,
  getReasoningLevelForModelId,
  persistReasoningLevelForModel,
  normalizeReasoningLevel,
  setInputMessage,
  focusedMessageId,
  setFocusedMessageId,
  inputMessageId,
  activeAssistantQuotes,
  chatUserInputRefs,
  registerChatUserInputRef,
  handleQuoteAssistantSelection,
  handleDeleteAssistantQuote,
  releaseHighlightIds,
  persistActiveBranchSelection,
  updateHistoricalUserMessage,
  finalizeHistoricalUserMessageEdit,
  dismissHistoricalUserMessage,
  handleAssistantMessageEditSave,
  handleAssistantMessageEditCancel,
  handleAssistantMessageGroupDelete,
  handleHistoricalUserMessageDelete,
  handleAssistantMessageGroupBranch,
  handleChatModeChange,
  handleUserMessageSubmit,
  handleRecoverPendingToolCall,
  handleRecoverAnswerUserQuestion,
  handleAssistantMessageGroupRetry,
  handleAssistantErrorContinue,
  handleApply,
  handleUndoEditSummary,
  handleOpenEditSummaryFile,
  handleToolMessageUpdate,
  handleToolCallResponseUpdate,
  handleContinueResponse,
}: YoloChatSurfaceProps) {
  const { t } = useLanguage()
  const chatSurfacePreset = getChatSurfacePreset('chat')

  const groupedChatMessages = chatTimelineReadModel.groupedChatMessages
  const groupedChatMessagesRef = useLatestRef(groupedChatMessages)
  const messageModelMapRef = useLatestRef(messageModelMap)
  const messageReasoningMapRef = useLatestRef(messageReasoningMap)
  const conversationModelIdValueRef = useLatestRef(conversationModelId)

  const activeEditableMessageId =
    focusedMessageId && focusedMessageId !== inputMessageId
      ? focusedMessageId
      : null

  const {
    windowedGroupedChatMessages,
    hasEarlierMessages,
    hasNewerMessages,
    loadEarlier,
    loadNewer,
    growWindowToFillViewport,
    historyWindowKey,
    resetToLatest,
    jumpToUserMessage,
    windowNavigationKey,
    windowNavigationTargetMessageId,
  } = useChatHistoryWindow({
    conversationId: currentConversationId,
    groupedChatMessages,
  })

  const messageNavigatorUserPreviewCacheRef = useRef(
    new WeakMap<ChatUserMessage, { emptyLabel: string; preview: string }>(),
  )
  const messageNavigatorAssistantPreviewCacheRef = useRef(
    new WeakMap<
      AssistantToolMessageGroup,
      { activeBranchKey: string | null; preview: string }
    >(),
  )
  const messageNavigatorAnchorCacheRef = useRef<
    Map<string, MessageNavigatorAnchor>
  >(new Map())
  const messageNavigatorAnchors = useMemo<MessageNavigatorAnchor[]>(() => {
    const emptyLabel = t('chat.messageNavigator.emptyMessage', '空消息')
    const assistantTextByUserMessageId = new Map<string, string[]>()
    let precedingUserMessageId: string | null = null

    groupedChatMessages.forEach((messageOrGroup) => {
      if (!Array.isArray(messageOrGroup)) {
        precedingUserMessageId = messageOrGroup.id
        return
      }

      const sourceUserMessageId =
        getSourceUserMessageIdForGroup(messageOrGroup) ?? precedingUserMessageId
      if (!sourceUserMessageId) {
        return
      }

      const activeBranchKey =
        activeBranchByUserMessageId.get(sourceUserMessageId) ?? null
      const cachedPreview =
        messageNavigatorAssistantPreviewCacheRef.current.get(messageOrGroup)
      const assistantPreview =
        cachedPreview?.activeBranchKey === activeBranchKey
          ? cachedPreview.preview
          : normalizeNavigatorPreview(
              getNavigatorAssistantText(
                getDisplayedAssistantToolMessages(
                  messageOrGroup,
                  activeBranchKey,
                ),
              ),
              MESSAGE_NAVIGATOR_ASSISTANT_PREVIEW_MAX_LENGTH,
            )
      if (cachedPreview?.activeBranchKey !== activeBranchKey) {
        messageNavigatorAssistantPreviewCacheRef.current.set(messageOrGroup, {
          activeBranchKey,
          preview: assistantPreview,
        })
      }
      if (!assistantPreview) {
        return
      }

      const existingText = assistantTextByUserMessageId.get(sourceUserMessageId)
      if (existingText) {
        existingText.push(assistantPreview)
      } else {
        assistantTextByUserMessageId.set(sourceUserMessageId, [
          assistantPreview,
        ])
      }
    })

    let userMessageIndex = 0
    const nextAnchorCache = new Map<string, MessageNavigatorAnchor>()
    const anchors = groupedChatMessages.flatMap((messageOrGroup) => {
      if (Array.isArray(messageOrGroup)) {
        return []
      }

      userMessageIndex += 1
      const cachedUserPreview =
        messageNavigatorUserPreviewCacheRef.current.get(messageOrGroup)
      const userPreview =
        cachedUserPreview?.emptyLabel === emptyLabel
          ? cachedUserPreview.preview
          : normalizeNavigatorPreview(
              (messageOrGroup.content
                ? editorStateToPlainText(messageOrGroup.content)
                : '') || getPromptContentText(messageOrGroup.promptContent),
              MESSAGE_NAVIGATOR_USER_PREVIEW_MAX_LENGTH,
              emptyLabel,
            )
      if (cachedUserPreview?.emptyLabel !== emptyLabel) {
        messageNavigatorUserPreviewCacheRef.current.set(messageOrGroup, {
          emptyLabel,
          preview: userPreview,
        })
      }

      const assistantPreview = normalizeNavigatorPreview(
        assistantTextByUserMessageId.get(messageOrGroup.id)?.join(' ') ?? '',
        MESSAGE_NAVIGATOR_ASSISTANT_PREVIEW_MAX_LENGTH,
      )
      const previousAnchor = messageNavigatorAnchorCacheRef.current.get(
        messageOrGroup.id,
      )
      const anchor =
        previousAnchor?.index === userMessageIndex &&
        previousAnchor.userPreview === userPreview &&
        previousAnchor.assistantPreview === assistantPreview
          ? previousAnchor
          : {
              id: messageOrGroup.id,
              index: userMessageIndex,
              userPreview,
              assistantPreview,
            }
      nextAnchorCache.set(anchor.id, anchor)
      return [anchor]
    })
    messageNavigatorAnchorCacheRef.current = nextAnchorCache
    return anchors
  }, [activeBranchByUserMessageId, groupedChatMessages, t])

  const latestCompactionState = useMemo(
    () => getLatestChatConversationCompaction(effectiveCompactionState),
    [effectiveCompactionState],
  )
  const compactionDividerAnchorMessageIds = useMemo(
    () => effectiveCompactionState.map((entry) => entry.anchorMessageId),
    [effectiveCompactionState],
  )
  const compactionDividerAnchorMessageId =
    latestCompactionState?.anchorMessageId ?? null
  const previousPendingCompactionAnchorMessageIdRef = useRef<string | null>(
    null,
  )
  const [
    enteringCompactionDividerAnchorMessageId,
    setEnteringCompactionDividerAnchorMessageId,
  ] = useState<string | null>(null)

  useEffect(() => {
    const previousPendingAnchorMessageId =
      previousPendingCompactionAnchorMessageIdRef.current
    previousPendingCompactionAnchorMessageIdRef.current =
      pendingCompactionAnchorMessageId

    if (
      previousPendingAnchorMessageId === null ||
      pendingCompactionAnchorMessageId !== null ||
      !compactionDividerAnchorMessageId
    ) {
      return
    }

    setEnteringCompactionDividerAnchorMessageId(
      compactionDividerAnchorMessageId,
    )
    const timer = window.setTimeout(() => {
      setEnteringCompactionDividerAnchorMessageId((current) =>
        current === compactionDividerAnchorMessageId ? null : current,
      )
    }, 240)

    return () => {
      window.clearTimeout(timer)
    }
  }, [compactionDividerAnchorMessageId, pendingCompactionAnchorMessageId])

  const compactionDividerTitle = t(
    'chat.compaction.dividerTitle',
    '从这里继续当前任务',
  )
  const compactionPendingTitle = t(
    'chat.compaction.pendingTitle',
    '正在压缩上下文',
  )
  const compactionDividerDescription = (() => {
    const compactedMessageCount = latestCompactionState?.compactedMessageCount
    const estimatedTokensSaved = latestCompactionState?.estimatedTokensSaved
    if (
      typeof compactedMessageCount === 'number' &&
      compactedMessageCount > 0 &&
      typeof estimatedTokensSaved === 'number' &&
      estimatedTokensSaved > 0
    ) {
      return t(
        'chat.compaction.dividerDescriptionWithSavings',
        '{messageCount} 条消息已压缩，节省约 {tokens} tokens',
      )
        .replace('{messageCount}', String(compactedMessageCount))
        .replace('{tokens}', formatTokenCount(estimatedTokensSaved))
    }
    if (typeof latestCompactionState?.estimatedNextContextTokens === 'number') {
      return t(
        'chat.compaction.dividerDescriptionWithEstimate',
        '以上对话已压缩为摘要，下一轮总上下文约为 {count} tokens',
      ).replace(
        '{count}',
        formatTokenCount(latestCompactionState.estimatedNextContextTokens),
      )
    }
    return t(
      'chat.compaction.dividerDescription',
      '以上对话已压缩为摘要，以下回复基于摘要继续',
    )
  })()
  const compactionPendingDescription = t(
    'chat.compaction.pendingStatus',
    '正在整理上下文，稍后将从新的上下文继续。',
  )

  const chatMessagesRef = useRef<HTMLDivElement>(null)
  const [chatMessagesElement, setChatMessagesElement] =
    useState<HTMLElement | null>(null)
  const [chatBottomSentinelElement, setChatBottomSentinelElement] =
    useState<HTMLElement | null>(null)
  const [navigatorViewport, setNavigatorViewport] = useState<{
    activeMessageId: string | null
    visibleMessageIds: string[]
  }>({ activeMessageId: null, visibleMessageIds: [] })
  const latexSelectionSyncFrameRef = useRef<number | null>(null)

  const hasStreamingMessages = useMemo(
    () =>
      chatMessages.some(
        (message) =>
          message.role === 'assistant' &&
          message.metadata?.generationState === 'streaming',
      ),
    [chatMessages],
  )

  const {
    autoScrollToBottom,
    forceScrollToBottom,
    stopAutoFollow,
    isAutoFollowEnabled,
    scrollController,
  } = useAutoScroll({
    scrollContainerRef: chatMessagesRef,
    scrollContainerElement: chatMessagesElement,
    bottomSentinelElement: chatBottomSentinelElement,
    followKey: currentConversationId,
    canFollowLiveEdge: !hasNewerMessages,
  })
  // Chat.tsx 侧的 useChatStreamManager / useChatDomainActions 仍需要触发这
  // 两个滚动动作（流式到达自动滚底、apply/提交后强制滚底），但 DOM 容器与
  // useAutoScroll 现在都归属本组件——通过 ref 注入把最新实现回填给父级，
  // 而不是把滚动状态提回 Chat.tsx。
  autoScrollToBottomRef.current = autoScrollToBottom
  forceScrollToBottomRef.current = forceScrollToBottom
  useLayoutEffect(() => {
    autoScrollToBottom()
  }, [autoScrollToBottom, chatMessages])
  const handleForceScrollToBottom = useCallback(() => {
    resetToLatest()
    // popout 是独立 BrowserWindow：帧调度必须取滚动容器所属窗口。
    getNodeWindow(chatMessagesRef.current).requestAnimationFrame(() => {
      forceScrollToBottom()
    })
  }, [chatMessagesRef, forceScrollToBottom, resetToLatest])
  const handleNavigateToUserMessage = useCallback(
    (messageId: string) => {
      setNavigatorViewport((currentViewport) => ({
        ...currentViewport,
        activeMessageId: messageId,
      }))
      stopAutoFollow()
      jumpToUserMessage(messageId)
    },
    [jumpToUserMessage, stopAutoFollow],
  )

  const {
    onControlPopoverOpenChange: onHistoricalUserMessageControlPopoverOpenChange,
  } = useHistoricalUserMessageDismiss({
    activeMessageId: activeEditableMessageId,
    containerRef: chatMessagesRef,
    onDismiss: dismissHistoricalUserMessage,
  })

  // 与迁移前完全一致：仅在渲染出的 Markdown 上同步渲染态 LaTeX 的选区。
  useEffect(() => {
    const chatMessagesElement = chatMessagesRef.current
    if (!chatMessagesElement) {
      return
    }

    let didSelectionTouchChat = false

    const syncLatexSelectionInView = () => {
      latexSelectionSyncFrameRef.current = null

      const selection = (
        chatMessagesElement.ownerDocument.defaultView ?? window
      ).getSelection()
      const selectionRoot =
        selection?.rangeCount && !selection.isCollapsed
          ? selection.getRangeAt(0).commonAncestorContainer
          : null
      const selectionTouchesChat = selectionRoot
        ? chatMessagesElement.contains(selectionRoot)
        : false

      if (!selectionTouchesChat && !didSelectionTouchChat) {
        return
      }

      didSelectionTouchChat = selectionTouchesChat

      chatMessagesElement
        .querySelectorAll<HTMLElement>('.yolo-markdown-rendered')
        .forEach((containerEl) => {
          syncRenderedLatexSelection(containerEl)
        })
    }

    const scheduleLatexSelectionSync = () => {
      if (latexSelectionSyncFrameRef.current !== null) {
        return
      }

      latexSelectionSyncFrameRef.current = getNodeWindow(
        chatMessagesElement,
      ).requestAnimationFrame(() => {
        syncLatexSelectionInView()
      })
    }

    const doc = chatMessagesElement.ownerDocument
    doc.addEventListener('selectionchange', scheduleLatexSelectionSync)
    doc.addEventListener('mouseup', scheduleLatexSelectionSync)
    doc.addEventListener('keyup', scheduleLatexSelectionSync)

    return () => {
      doc.removeEventListener('selectionchange', scheduleLatexSelectionSync)
      doc.removeEventListener('mouseup', scheduleLatexSelectionSync)
      doc.removeEventListener('keyup', scheduleLatexSelectionSync)
      if (latexSelectionSyncFrameRef.current !== null) {
        getNodeWindow(chatMessagesElement).cancelAnimationFrame(
          latexSelectionSyncFrameRef.current,
        )
        latexSelectionSyncFrameRef.current = null
      }
    }
  }, [])

  const activeStreamingMessageId = useMemo(() => {
    for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
      const message = chatMessages[index]
      if (
        message.role === 'assistant' &&
        message.metadata?.generationState === 'streaming'
      ) {
        return message.id
      }
    }

    return null
  }, [chatMessages])
  const showContinueResponseButton = useMemo(() => {
    return shouldShowContinueResponse(
      chatMessages,
      isCurrentConversationRunActive,
    )
  }, [chatMessages, isCurrentConversationRunActive])

  const chatTimelineItems: ChatTimelineItem[] = useMemo(
    () =>
      buildChatTimelineItems({
        groupedChatMessages: windowedGroupedChatMessages,
        revisionsById: chatTimelineReadModel.revisionsById,
        assistantGroupBoundaryMessageIds:
          chatTimelineReadModel.assistantGroupBoundaryMessageIds,
        compactionDividerAnchorMessageIds,
        latestCompaction: latestCompactionState,
        pendingCompactionAnchorMessageId,
        queryProgress,
        showContinueResponseButton,
        activeEditableMessageId,
        activeEditingAssistantMessageId: editingAssistantMessageId,
        activeStreamingMessageId,
      }),
    [
      editingAssistantMessageId,
      activeStreamingMessageId,
      chatTimelineReadModel.assistantGroupBoundaryMessageIds,
      chatTimelineReadModel.revisionsById,
      compactionDividerAnchorMessageIds,
      focusedMessageId,
      inputMessageId,
      latestCompactionState,
      pendingCompactionAnchorMessageId,
      queryProgress,
      showContinueResponseButton,
      windowedGroupedChatMessages,
    ],
  )
  const stableChatTimelineItems = useStableChatTimelineItems(chatTimelineItems)

  const windowedToolCallIds = useMemo(
    () => collectToolCallIdsFromGroupedMessages(windowedGroupedChatMessages),
    [windowedGroupedChatMessages],
  )
  const terminalCommandResultsByToolCallIdRef = useRef<ReadonlyMap<
    string,
    ChatTerminalCommandResultMessage
  > | null>(null)
  const subagentResultsByToolCallIdRef = useRef<ReadonlyMap<
    string,
    ChatSubagentResultMessage
  > | null>(null)
  const terminalCommandResultsByToolCallId = useMemo(() => {
    const next = buildTerminalCommandResultMap(
      chatMessages,
      windowedToolCallIds,
    )
    const stable = terminalCommandResultsByToolCallIdRef.current
      ? reuseShallowEqualMap(
          terminalCommandResultsByToolCallIdRef.current,
          next,
        )
      : next
    terminalCommandResultsByToolCallIdRef.current = stable
    return stable
  }, [chatMessages, windowedToolCallIds])
  const subagentResultsByToolCallId = useMemo(() => {
    const next = buildSubagentResultMap(chatMessages, windowedToolCallIds)
    const stable = subagentResultsByToolCallIdRef.current
      ? reuseShallowEqualMap(subagentResultsByToolCallIdRef.current, next)
      : next
    subagentResultsByToolCallIdRef.current = stable
    return stable
  }, [chatMessages, windowedToolCallIds])

  const continuableErrorMessageIds = useMemo(() => {
    const ids = new Set<string>()
    for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
      const message = chatMessages[index]
      if (message.role === 'user') {
        break
      }
      if (
        message.role === 'assistant' &&
        buildAssistantErrorContinuation({
          sourceMessages: chatMessages,
          groupedChatMessages,
          assistantMessageId: message.id,
          activeBranchByUserMessageId,
        })
      ) {
        ids.add(message.id)
      }
    }
    return ids
  }, [activeBranchByUserMessageId, chatMessages, groupedChatMessages])

  const shouldHidePendingAssistantPlaceholders = useMemo(() => {
    if (!isCurrentConversationRunActive) {
      return false
    }

    let lastUserIndex = -1
    for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
      if (chatMessages[index].role === 'user') {
        lastUserIndex = index
        break
      }
    }

    if (lastUserIndex === -1) {
      return false
    }

    return chatMessages
      .slice(lastUserIndex + 1)
      .some((message) => message.role === 'tool')
  }, [chatMessages, isCurrentConversationRunActive])

  const currentConversationRef = useMemo<YoloConversationRef>(
    () => ({ runtimeId: 'yolo', conversationId: currentConversationId }),
    [currentConversationId],
  )
  const resolveRuntimeActionConversation = useCallback(
    (conversationId: string): YoloConversationRef => ({
      runtimeId: 'yolo',
      conversationId,
    }),
    [],
  )

  const runSummaryAssistantGroupId = useMemo(
    () =>
      findAssistantGroupIdForRunAnchor({
        groupedChatMessages,
        anchorMessageId: currentConversationRunSummary.anchorMessageId,
      }),
    [currentConversationRunSummary.anchorMessageId, groupedChatMessages],
  )

  // 后台任务结果在渲染上会接回对应 tool card，且 subagent/terminal result
  // standalone group 会被 timeline 过滤掉；因此必须在过滤前的 grouped
  // messages 上决定“视觉回合”的 footer 归属。
  const foregroundAgentVisualTurnPlanRef =
    useRef<ForegroundAgentVisualTurnPlan | null>(null)
  const foregroundAgentVisualTurnPlan = useMemo(() => {
    const next = buildForegroundAgentVisualTurnPlan(groupedChatMessages)
    const stable = foregroundAgentVisualTurnPlanRef.current
      ? reuseForegroundAgentVisualTurnPlan(
          foregroundAgentVisualTurnPlanRef.current,
          next,
        )
      : next
    foregroundAgentVisualTurnPlanRef.current = stable
    return stable
  }, [groupedChatMessages])

  const handleAssistantGroupEditStart = useCallback(
    (messageId: string) => {
      setEditingAssistantMessageId(messageId)
    },
    [setEditingAssistantMessageId],
  )

  const handleAssistantGroupActiveBranchChange = useCallback(
    (sourceUserMessageId: string, branchKey: string | null) => {
      const next = new Map(activeBranchByUserMessageIdRef.current)
      if (!branchKey) {
        next.delete(sourceUserMessageId)
      } else {
        next.set(sourceUserMessageId, branchKey)
      }
      activeBranchByUserMessageIdRef.current = next
      setActiveBranchByUserMessageId(next)
      // 只写 `activeBranchByUserMessageId` 这一项元数据。顺带写一份 messages
      // 快照会用一份可能落后整个生成阶段的正文覆盖数据库——见
      // `persistActiveBranchSelection`。
      void persistActiveBranchSelection()
    },
    [
      activeBranchByUserMessageIdRef,
      persistActiveBranchSelection,
      setActiveBranchByUserMessageId,
    ],
  )

  const timelineHandlersRef = useLatestRef({
    finalizeHistoricalUserMessageEdit,
    handleApply,
    handleAssistantGroupActiveBranchChange,
    handleAssistantGroupEditStart,
    handleAssistantErrorContinue,
    handleAssistantMessageEditCancel,
    handleAssistantMessageEditSave,
    handleAssistantMessageGroupBranch,
    handleAssistantMessageGroupDelete,
    handleAssistantMessageGroupRetry,
    handleChatModeChange,
    handleContinueResponse,
    handleHistoricalUserMessageDelete,
    handleOpenEditSummaryFile,
    handleDeleteAssistantQuote,
    handleQuoteAssistantSelection,
    handleRecoverAnswerUserQuestion,
    handleRecoverPendingToolCall,
    handleToolCallResponseUpdate,
    handleToolMessageUpdate,
    handleUndoEditSummary,
    handleUserMessageSubmit,
    updateHistoricalUserMessage,
  })

  const buildYoloAssistantGroupProps = useCallback(
    (
      messageOrGroup: AssistantToolMessageGroup,
      timelineItem: ChatTimelineAssistantGroupItem,
    ): ConversationAssistantGroupProps => {
      const sourceUserMessageId = getSourceUserMessageIdForGroup(messageOrGroup)
      const foregroundAgentFooter = getForegroundAgentFooterForGroup(
        foregroundAgentVisualTurnPlan,
        messageOrGroup,
      )
      const containsCompactionAnchor =
        compactionDividerAnchorMessageId !== null &&
        messageOrGroup.some(
          (message) => message.id === compactionDividerAnchorMessageId,
        )
      const shouldSuppressCompactionAnchorFooter =
        containsCompactionAnchor &&
        Boolean(latestCompactionState?.triggerToolCallId)

      return {
        conversationId: currentConversationId,
        conversationRunSummary:
          timelineItem.groupId === runSummaryAssistantGroupId
            ? currentConversationRunSummary
            : undefined,
        activeBranchKey: activeBranchByUserMessageId.get(
          sourceUserMessageId ?? '',
        ),
        sourceUserMessageId,
        continuableErrorMessageIds,
        suppressFooter:
          shouldSuppressCompactionAnchorFooter ||
          foregroundAgentFooter?.suppress === true,
        inlineInfoMessages:
          foregroundAgentFooter?.inlineInfoMessages ?? messageOrGroup,
        isApplying,
        activeApplyRequestKey,
        onApply: (...args) => timelineHandlersRef.current.handleApply(...args),
        onToolMessageUpdate: (...args) =>
          timelineHandlersRef.current.handleToolMessageUpdate(...args),
        onToolCallResponseUpdate: (...args) =>
          timelineHandlersRef.current.handleToolCallResponseUpdate(...args),
        terminalCommandResultsByToolCallId,
        subagentResultsByToolCallId,
        onRecoverToolCall: (...args) =>
          timelineHandlersRef.current.handleRecoverPendingToolCall(...args),
        onRecoverAnswerUserQuestion: (...args) =>
          timelineHandlersRef.current.handleRecoverAnswerUserQuestion(...args),
        editingAssistantMessageId,
        onEditStart: (...args) =>
          timelineHandlersRef.current.handleAssistantGroupEditStart(...args),
        onEditCancel: (...args) =>
          timelineHandlersRef.current.handleAssistantMessageEditCancel(...args),
        onEditSave: (...args) =>
          timelineHandlersRef.current.handleAssistantMessageEditSave(...args),
        onDeleteGroup: (...args) =>
          timelineHandlersRef.current.handleAssistantMessageGroupDelete(
            ...args,
          ),
        onRetryGroup: (...args) =>
          timelineHandlersRef.current.handleAssistantMessageGroupRetry(...args),
        onContinueError: (...args) =>
          timelineHandlersRef.current.handleAssistantErrorContinue(...args),
        onBranchGroup: (...args) =>
          timelineHandlersRef.current.handleAssistantMessageGroupBranch(
            ...args,
          ),
        onActiveBranchChange: (...args) =>
          timelineHandlersRef.current.handleAssistantGroupActiveBranchChange(
            ...args,
          ),
        onQuoteAssistantSelection: (...args) =>
          timelineHandlersRef.current.handleQuoteAssistantSelection(...args),
        assistantQuotes: activeAssistantQuotes,
        onDeleteAssistantQuote: (...args) =>
          timelineHandlersRef.current.handleDeleteAssistantQuote(...args),
        onOpenEditSummaryFile: (...args) =>
          timelineHandlersRef.current.handleOpenEditSummaryFile(...args),
        onUndoEditSummary: (...args) =>
          timelineHandlersRef.current.handleUndoEditSummary(...args),
        undoingEditSummaryTarget,
        pendingCompactionAnchorMessageId,
        hidePendingAssistantPlaceholders:
          shouldHidePendingAssistantPlaceholders,
      }
    },
    [
      activeApplyRequestKey,
      activeAssistantQuotes,
      activeBranchByUserMessageId,
      isApplying,
      compactionDividerAnchorMessageId,
      continuableErrorMessageIds,
      currentConversationId,
      currentConversationRunSummary,
      editingAssistantMessageId,
      foregroundAgentVisualTurnPlan,
      latestCompactionState?.triggerToolCallId,
      pendingCompactionAnchorMessageId,
      runSummaryAssistantGroupId,
      shouldHidePendingAssistantPlaceholders,
      subagentResultsByToolCallId,
      terminalCommandResultsByToolCallId,
      undoingEditSummaryTarget,
    ],
  )

  const renderYoloUserMessage = useCallback(
    (message: ChatUserMessage) => {
      const messageReasoningLevel =
        messageReasoningMap.get(message.id) ??
        normalizeReasoningLevel(message.reasoningLevel) ??
        reasoningLevel

      return (
        <UserMessageItem
          message={message}
          isFocused={focusedMessageId === message.id}
          isActionDisabled={isCurrentConversationRunActive}
          onDelete={() => {
            timelineHandlersRef.current.handleHistoricalUserMessageDelete(
              message.id,
            )
            // Focus before the deleted turn unmounts, otherwise the trash
            // button takes DOM focus down with it and lands on `<body>` —
            // most visible when the last turn goes and the composer is the
            // only thing left on screen.
            chatUserInputRefs.current.get(inputMessageId)?.focus()
          }}
          displayMentionables={message.mentionables}
          chatUserInputRef={(ref) => registerChatUserInputRef(message.id, ref)}
          onControlPopoverOpenChange={(isOpen) => {
            onHistoricalUserMessageControlPopoverOpenChange(isOpen)
          }}
          onInputChange={(content) => {
            timelineHandlersRef.current.updateHistoricalUserMessage(
              message.id,
              (message) => ({
                ...message,
                content,
                promptContent: null,
              }),
            )
          }}
          onSubmit={(content) => {
            if (
              editorStateToPlainText(content).trim() === '' &&
              message.mentionables.length === 0 &&
              (message.selectedSkills?.length ?? 0) === 0
            ) {
              timelineHandlersRef.current.finalizeHistoricalUserMessageEdit(
                message.id,
              )
              chatUserInputRefs.current.get(inputMessageId)?.focus()
              return
            }
            const latestGroupedChatMessages = groupedChatMessagesRef.current
            const latestGroupedMessageIndex =
              latestGroupedChatMessages.findIndex(
                (candidate) =>
                  !Array.isArray(candidate) && candidate.id === message.id,
              )
            if (latestGroupedMessageIndex < 0) {
              return
            }
            const currentConversationModelId =
              conversationModelIdValueRef.current
            const modelForThisMessage =
              messageModelMapRef.current.get(message.id) ??
              currentConversationModelId
            const reasoningForThisMessage =
              messageReasoningMapRef.current.get(message.id) ??
              messageReasoningLevel
            const nextMessageModelMap = new Map(messageModelMapRef.current)
            nextMessageModelMap.set(message.id, modelForThisMessage)
            // 历史编辑后重新提交是一个新的用户回合 → 打上新的当前时间。
            const editedUserMessage: ChatUserMessage =
              stampUserMessageTimeContext(
                {
                  role: 'user',
                  content,
                  promptContent: null,
                  id: message.id,
                  reasoningLevel: reasoningForThisMessage,
                  mentionables: message.mentionables,
                  selectedSkills: message.selectedSkills ?? [],
                  selectedModelIds: extractSelectedModelIds(
                    message.mentionables,
                  ),
                },
                selectedAssistantTimeContextEnabled,
              )
            const inputChatMessages = [
              ...latestGroupedChatMessages
                .slice(0, latestGroupedMessageIndex)
                .flatMap((candidate): ChatMessage[] =>
                  !Array.isArray(candidate) ? [candidate] : candidate,
                ),
              editedUserMessage,
            ]
            const requestChatMessages = [
              ...latestGroupedChatMessages
                .slice(0, latestGroupedMessageIndex)
                .flatMap((candidate): ChatMessage[] =>
                  !Array.isArray(candidate)
                    ? [candidate]
                    : getDisplayedAssistantToolMessages(
                        candidate,
                        activeBranchByUserMessageIdRef.current.get(
                          getSourceUserMessageIdForGroup(candidate) ?? '',
                        ),
                      ),
                ),
              editedUserMessage,
            ]
            void timelineHandlersRef.current.handleUserMessageSubmit({
              inputChatMessages,
              requestChatMessages,
              persistedMessageModelMap: nextMessageModelMap,
            })
            chatUserInputRefs.current.get(inputMessageId)?.focus()
            setMessageModelMap(nextMessageModelMap)
            setMessageReasoningMap((prev) => {
              const next = new Map(prev)
              next.set(message.id, reasoningForThisMessage)
              return next
            })
          }}
          onFocus={() => {
            setFocusedMessageId(message.id)
          }}
          onMentionablesChange={(mentionables) => {
            const currentMessage = chatMessagesStateRef.current.find(
              (candidate): candidate is ChatUserMessage =>
                candidate.role === 'user' && candidate.id === message.id,
            )
            if (currentMessage) {
              releaseHighlightIds(
                collectRemovedSelectionHighlightIds(
                  currentMessage.mentionables,
                  mentionables,
                ),
              )
            }
            timelineHandlersRef.current.updateHistoricalUserMessage(
              message.id,
              (message) => {
                const prevKeys = message.mentionables.map((m) =>
                  getMentionableKey(serializeMentionable(m)),
                )
                const nextKeys = mentionables.map((m) =>
                  getMentionableKey(serializeMentionable(m)),
                )
                const nextKeySet = new Set(nextKeys)
                const isSameMentionables =
                  prevKeys.length === nextKeys.length &&
                  prevKeys.every((key) => nextKeySet.has(key))

                return {
                  ...message,
                  mentionables,
                  promptContent: isSameMentionables
                    ? message.promptContent
                    : null,
                }
              },
            )
          }}
          onSelectedSkillsChange={(selectedSkills) => {
            timelineHandlersRef.current.updateHistoricalUserMessage(
              message.id,
              (message) => ({
                ...message,
                selectedSkills,
                promptContent: null,
                snapshotRef: undefined,
              }),
            )
          }}
          modelId={messageModelMap.get(message.id) ?? conversationModelId}
          onModelChange={(id) => {
            setMessageModelMap((prev) => {
              const next = new Map(prev)
              next.set(message.id, id)
              return next
            })
            setConversationModelId(id)
            conversationModelIdRef.current.set(currentConversationId, id)
            const nextReasoningLevel = getReasoningLevelForModelId(id)
            setReasoningLevel(nextReasoningLevel)
            conversationReasoningLevelRef.current.set(
              currentConversationId,
              nextReasoningLevel,
            )
            setInputMessage((prev) => ({
              ...prev,
              reasoningLevel: nextReasoningLevel,
            }))
          }}
          reasoningLevel={messageReasoningLevel}
          onReasoningChange={(level) => {
            setMessageReasoningMap((prev) => {
              const next = new Map(prev)
              next.set(message.id, level)
              return next
            })
            setChatMessages((prevChatHistory) =>
              prevChatHistory.map((msg) =>
                msg.role === 'user' && msg.id === message.id
                  ? {
                      ...msg,
                      reasoningLevel: level,
                    }
                  : msg,
              ),
            )
            setReasoningLevel(level)
            conversationReasoningLevelRef.current.set(
              currentConversationId,
              level,
            )
            void persistReasoningLevelForModel(
              conversationModelIdValueRef.current,
              level,
            )
          }}
          currentAssistantId={conversationAssistantId}
          currentChatMode={chatMode}
          onSelectChatModeForConversation={(...args) =>
            timelineHandlersRef.current.handleChatModeChange(...args)
          }
          showReasoningSelect={
            chatSurfacePreset.userMessage.showReasoningSelect
          }
          allowAgentModeOption={
            chatSurfacePreset.userMessage.allowAgentModeOption
          }
        />
      )
    },
    [
      chatSurfacePreset,
      chatMode,
      conversationAssistantId,
      conversationModelId,
      currentConversationId,
      focusedMessageId,
      getReasoningLevelForModelId,
      inputMessageId,
      isCurrentConversationRunActive,
      messageModelMap,
      messageReasoningMap,
      onHistoricalUserMessageControlPopoverOpenChange,
      persistReasoningLevelForModel,
      reasoningLevel,
      registerChatUserInputRef,
      releaseHighlightIds,
      selectedAssistantTimeContextEnabled,
    ],
  )

  const renderYoloQueryProgress = useCallback(
    () => <QueryProgress state={queryProgress} />,
    [queryProgress],
  )

  const renderYoloContinueResponse = useCallback(
    () => (
      <div className="yolo-continue-response-button-container">
        <button
          type="button"
          className="yolo-continue-response-button"
          onClick={handleContinueResponse}
        >
          <div>Continue response</div>
        </button>
      </div>
    ),
    [handleContinueResponse],
  )

  const yoloTimelineRendererContract =
    useMemo<ConversationTimelineRendererContract>(
      () => ({
        messagesById: chatTimelineReadModel.messagesById,
        preset: chatSurfacePreset,
        compaction: {
          pendingTitle: compactionPendingTitle,
          pendingDescription: compactionPendingDescription,
          dividerTitle: compactionDividerTitle,
          dividerDescription: compactionDividerDescription,
          isDividerEntering: (item) =>
            item.renderKey ===
            `${enteringCompactionDividerAnchorMessageId}-compact-divider`,
        },
        renderUserMessage: renderYoloUserMessage,
        getAssistantGroupProps: buildYoloAssistantGroupProps,
        wrapAssistantGroup: (content) => (
          <ChatRuntimeActionsProvider
            actions={runtimeActions}
            conversation={currentConversationRef}
            resolveConversationScope={resolveRuntimeActionConversation}
          >
            {content}
          </ChatRuntimeActionsProvider>
        ),
        renderQueryProgress: renderYoloQueryProgress,
        renderContinueResponse: renderYoloContinueResponse,
        bottomAnchorClassName: 'yolo-chat-bottom-anchor',
      }),
      [
        chatSurfacePreset,
        chatTimelineReadModel.messagesById,
        compactionDividerDescription,
        compactionDividerTitle,
        compactionPendingDescription,
        compactionPendingTitle,
        currentConversationRef,
        enteringCompactionDividerAnchorMessageId,
        buildYoloAssistantGroupProps,
        renderYoloContinueResponse,
        renderYoloQueryProgress,
        renderYoloUserMessage,
        resolveRuntimeActionConversation,
        runtimeActions,
      ],
    )

  const chatTimelineRenderVersion = useCallback(
    (timelineItem: ChatTimelineItem): string => {
      if (timelineItem.kind === 'compaction-pending') {
        return [
          timelineItem.renderKey,
          compactionPendingTitle,
          compactionPendingDescription,
        ].join('|')
      }

      if (timelineItem.kind === 'compaction-divider') {
        return [
          timelineItem.renderKey,
          compactionDividerTitle,
          compactionDividerDescription,
          timelineItem.renderKey ===
            `${enteringCompactionDividerAnchorMessageId}-compact-divider`,
        ].join('|')
      }

      if (timelineItem.kind === 'assistant-group') {
        const messages = timelineItem.messageIds
          .map((messageId) => chatTimelineReadModel.messagesById.get(messageId))
          .filter(
            (message): message is AssistantToolMessageGroup[number] =>
              message !== undefined && message.role !== 'user',
          )
        const sourceUserMessageId = getSourceUserMessageIdForGroup(messages)
        const foregroundAgentFooter = getForegroundAgentFooterForGroup(
          foregroundAgentVisualTurnPlan,
          messages,
        )
        const containsCompactionAnchor =
          compactionDividerAnchorMessageId !== null &&
          timelineItem.messageIds.includes(compactionDividerAnchorMessageId)
        const shouldSuppressCompactionAnchorFooter =
          containsCompactionAnchor &&
          Boolean(latestCompactionState?.triggerToolCallId)
        const isRunSummaryGroup =
          timelineItem.groupId === runSummaryAssistantGroupId
        const isEditingGroup =
          editingAssistantMessageId !== null &&
          timelineItem.messageIds.includes(editingAssistantMessageId)

        return [
          'assistant',
          timelineItem.revision,
          currentConversationId,
          activeBranchByUserMessageId.get(sourceUserMessageId ?? '') ?? '',
          foregroundAgentFooter?.suppress === true,
          getRenderVersionObjectId(foregroundAgentFooter?.inlineInfoMessages),
          shouldSuppressCompactionAnchorFooter,
          chatSurfacePreset.assistantActions.showInlineInfo,
          chatSurfacePreset.assistantActions.showRetryAction,
          chatSurfacePreset.assistantActions.showInsertAction,
          chatSurfacePreset.assistantActions.showCopyAction,
          chatSurfacePreset.assistantActions.showBranchAction,
          chatSurfacePreset.assistantActions.showEditAction,
          chatSurfacePreset.assistantActions.showDeleteAction,
          chatSurfacePreset.assistantActions.showQuoteAction,
          activeAssistantQuotes
            .filter((quote) =>
              timelineItem.messageIds.includes(quote.messageId),
            )
            .map(
              (quote) =>
                `${quote.id ?? ''}:${quote.selector?.start ?? ''}:${quote.selector?.end ?? ''}:${quote.comment ?? ''}`,
            )
            .join(','),
          isApplying,
          activeApplyRequestKey ?? '',
          getRenderVersionObjectId(terminalCommandResultsByToolCallId),
          getRenderVersionObjectId(subagentResultsByToolCallId),
          isEditingGroup ? editingAssistantMessageId : '',
          pendingCompactionAnchorMessageId ?? '',
          shouldHidePendingAssistantPlaceholders,
          undoingEditSummaryTarget ?? '',
          isRunSummaryGroup,
          isRunSummaryGroup ? currentConversationRunSummary.status : '',
          isRunSummaryGroup ? currentConversationRunSummary.isRunning : '',
          isRunSummaryGroup
            ? currentConversationRunSummary.isWaitingApproval
            : '',
          isRunSummaryGroup
            ? currentConversationRunSummary.isWaitingUserInput
            : '',
          isRunSummaryGroup ? currentConversationRunSummary.isAbortable : '',
        ].join('|')
      }

      if (timelineItem.kind === 'user-message') {
        const message = chatTimelineReadModel.messagesById.get(
          timelineItem.messageId,
        )
        const reasoning =
          message?.role === 'user'
            ? (messageReasoningMap.get(message.id) ??
              normalizeReasoningLevel(message.reasoningLevel) ??
              reasoningLevel)
            : reasoningLevel

        return [
          'user',
          timelineItem.revision,
          focusedMessageId === timelineItem.messageId,
          isCurrentConversationRunActive,
          messageModelMap.get(timelineItem.messageId) ?? conversationModelId,
          reasoning,
          conversationAssistantId,
          selectedAssistantTimeContextEnabled,
          chatMode,
          chatSurfacePreset.userMessage.showReasoningSelect,
          chatSurfacePreset.userMessage.allowAgentModeOption,
        ].join('|')
      }

      if (timelineItem.kind === 'query-progress') {
        return `query|${getRenderVersionObjectId(queryProgress ?? null)}`
      }

      if (timelineItem.kind === 'continue-response') {
        return `continue|${isCurrentConversationRunActive}`
      }

      return timelineItem.renderKey
    },
    [
      activeAssistantQuotes,
      activeApplyRequestKey,
      activeBranchByUserMessageId,
      isApplying,
      chatMode,
      chatSurfacePreset,
      chatTimelineReadModel.messagesById,
      compactionDividerAnchorMessageId,
      compactionDividerDescription,
      compactionDividerTitle,
      compactionPendingDescription,
      compactionPendingTitle,
      conversationAssistantId,
      conversationModelId,
      currentConversationId,
      currentConversationRunSummary,
      editingAssistantMessageId,
      enteringCompactionDividerAnchorMessageId,
      focusedMessageId,
      foregroundAgentVisualTurnPlan,
      isCurrentConversationRunActive,
      runSummaryAssistantGroupId,
      latestCompactionState?.triggerToolCallId,
      messageModelMap,
      messageReasoningMap,
      pendingCompactionAnchorMessageId,
      queryProgress,
      reasoningLevel,
      selectedAssistantTimeContextEnabled,
      shouldHidePendingAssistantPlaceholders,
      subagentResultsByToolCallId,
      terminalCommandResultsByToolCallId,
      undoingEditSummaryTarget,
    ],
  )

  const getMessageNavigatorItemLabel = useCallback(
    (index: number, label: string) =>
      t(
        'chat.messageNavigator.itemAriaLabel',
        '跳转到第 {index} 条消息：{label}',
      )
        .replace('{index}', String(index))
        .replace('{label}', label),
    [t],
  )
  const messageNavigatorContent =
    messageNavigatorAnchors.length >= MESSAGE_NAVIGATOR_MIN_ANCHORS ? (
      <MessageNavigator
        anchors={messageNavigatorAnchors}
        activeMessageId={navigatorViewport.activeMessageId}
        visibleMessageIds={navigatorViewport.visibleMessageIds}
        itemLabel={getMessageNavigatorItemLabel}
        onSelect={handleNavigateToUserMessage}
      />
    ) : undefined

  return (
    // 流式正文不再随会话快照到达，跟随由播放器在可见帧 commit 后直接触发。
    <LiveEdgeFollowProvider onFollowLiveEdge={autoScrollToBottom}>
      <ConversationSurface
        chatMode={chatMode}
        yoloEnabled={yoloEnabled}
        showEmptyState={showEmptyState}
        groupedChatMessagesLength={groupedChatMessages.length}
        isAutoFollowEnabled={isAutoFollowEnabled}
        currentConversationId={currentConversationId}
        chatTimelineItems={stableChatTimelineItems}
        timelineRenderVersion={chatTimelineRenderVersion}
        chatMessagesRef={chatMessagesRef}
        onScrollContainerChange={setChatMessagesElement}
        onBottomSentinelChange={setChatBottomSentinelElement}
        scrollController={scrollController}
        timelineRendererContract={yoloTimelineRendererContract}
        editingAssistantMessageId={editingAssistantMessageId}
        hasEarlierMessages={hasEarlierMessages}
        hasNewerMessages={hasNewerMessages}
        onLoadEarlier={loadEarlier}
        onLoadNewer={loadNewer}
        onGrowWindowToFillViewport={growWindowToFillViewport}
        historyWindowKey={historyWindowKey}
        onForceScrollToBottom={handleForceScrollToBottom}
        hasStreamingMessages={hasStreamingMessages}
        scrollToBottomLabel={t('chat.scrollToBottom', '回到底部')}
        scrollToBottomWhileStreamingLabel={t(
          'chat.scrollToBottomWhileStreaming',
          '回到底部继续跟随',
        )}
        emptyStateAskTitle={t('chat.emptyState.askTitle', '先想清楚，再落笔')}
        emptyStateAgentTitle={t('chat.emptyState.agentTitle', '让 AI 去执行')}
        emptyStateAgentFullTitle={t(
          'chat.emptyState.agentFullTitle',
          '让 AI 自主执行 · YOLO 模式',
        )}
        emptyStateWorkspaceTitle={emptyStateWorkspaceTitle}
        emptyStateModuleContent={emptyStateModuleContent}
        emptyStateAskDescription={t(
          'chat.emptyState.askDescription',
          '适合提问、润色与改写，专注表达本身',
        )}
        emptyStateAgentDescription={t(
          'chat.emptyState.agentDescription',
          '启用工具链，处理搜索、读写与多步骤任务',
        )}
        emptyStateAgentFullDescription={t(
          'chat.emptyState.agentFullDescription',
          '自动放行工具调用，处理搜索、读写与多步骤任务',
        )}
        onUserMessageViewportChange={setNavigatorViewport}
        windowNavigationKey={windowNavigationKey || undefined}
        windowNavigationTargetMessageId={windowNavigationTargetMessageId}
        messageNavigatorContent={messageNavigatorContent}
        bottomSpacerHeight={bottomSpacerHeight}
        footerContent={footerContent}
      />
    </LiveEdgeFollowProvider>
  )
}

export default YoloChatSurface
