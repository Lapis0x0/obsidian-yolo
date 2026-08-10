import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  ArrowDown,
  Bot,
  Infinity as InfinityIcon,
  MessageCircle,
} from 'lucide-react'
import type { ReactNode, RefObject } from 'react'

import {
  MOTION_DURATION_ENTER_S,
  MOTION_DURATION_EXIT_S,
  MOTION_EASE_IN,
  MOTION_EASE_OUT,
  MOTION_LAYOUT_SPRING,
} from '../../styles/tokens/motion'
import type { ChatTimelineItem } from '../../types/chat-timeline'

import type { ChatMode } from './chat-input/ChatModeSelect'
import { isAgentChatMode } from './chat-input/ChatModeSelect'
import type {
  ChatTimelineRenderVersion,
  UserMessageViewportState,
} from './ChatTimelineList'
import { InstallationIncompleteBanner } from './InstallationIncompleteBanner'
import type { ScrollController } from './scroll/scrollController'
import { SharedConversationSurface } from './SharedConversationSurface'

export type ChatConversationPaneProps = {
  chatMode: ChatMode
  yoloEnabled: boolean
  showEmptyState: boolean
  groupedChatMessagesLength: number
  isAutoFollowEnabled: boolean
  currentConversationId: string
  chatTimelineItems: ChatTimelineItem[]
  chatMessagesRef: RefObject<HTMLDivElement>
  onScrollContainerChange: (element: HTMLElement | null) => void
  onBottomSentinelChange: (element: HTMLElement | null) => void
  scrollController?: ScrollController
  renderChatTimelineItem: (timelineItem: ChatTimelineItem) => ReactNode
  timelineRenderVersion?: ChatTimelineRenderVersion<ChatTimelineItem>
  editingAssistantMessageId: string | null
  onForceScrollToBottom: () => void
  hasStreamingMessages: boolean
  scrollToBottomLabel: string
  scrollToBottomWhileStreamingLabel: string
  emptyStateAskTitle: string
  emptyStateAgentTitle: string
  emptyStateAgentFullTitle: string
  emptyStateWorkspaceTitle?: ReactNode
  emptyStateAskDescription: string
  emptyStateAgentDescription: string
  emptyStateAgentFullDescription: string
  emptyStateIcon?: ReactNode
  emptyStateIconMode?: string
  footerContent: ReactNode
  onTimelineVirtualizationChange?: (isVirtualized: boolean) => void
  onUserMessageViewportChange?: (state: UserMessageViewportState) => void
  windowNavigationKey?: number
  windowNavigationTargetMessageId?: string | null
  messageNavigatorContent?: ReactNode
  hasEarlierMessages?: boolean
  hasNewerMessages?: boolean
  onLoadEarlier?: () => void
  onLoadNewer?: () => void
  bottomSpacerHeight?: number
}

export function ChatConversationPane({
  chatMode,
  yoloEnabled,
  showEmptyState,
  groupedChatMessagesLength,
  isAutoFollowEnabled,
  currentConversationId,
  chatTimelineItems,
  chatMessagesRef,
  onScrollContainerChange,
  onBottomSentinelChange,
  scrollController,
  renderChatTimelineItem,
  timelineRenderVersion,
  editingAssistantMessageId,
  onForceScrollToBottom,
  hasStreamingMessages,
  scrollToBottomLabel,
  scrollToBottomWhileStreamingLabel,
  emptyStateAskTitle,
  emptyStateAgentTitle,
  emptyStateAgentFullTitle,
  emptyStateWorkspaceTitle,
  emptyStateAskDescription,
  emptyStateAgentDescription,
  emptyStateAgentFullDescription,
  emptyStateIcon,
  emptyStateIconMode,
  footerContent,
  onTimelineVirtualizationChange,
  onUserMessageViewportChange,
  windowNavigationKey,
  windowNavigationTargetMessageId,
  messageNavigatorContent,
  hasEarlierMessages,
  hasNewerMessages,
  onLoadEarlier,
  onLoadNewer,
  bottomSpacerHeight,
}: ChatConversationPaneProps) {
  const reduceMotion = useReducedMotion()
  const showScrollToBottomButton =
    !showEmptyState &&
    groupedChatMessagesLength > 0 &&
    (!isAutoFollowEnabled || hasNewerMessages)

  const isYoloAgent = isAgentChatMode(chatMode) && yoloEnabled
  const emptyStateTitle =
    emptyStateWorkspaceTitle ??
    (isYoloAgent
      ? emptyStateAgentFullTitle
      : isAgentChatMode(chatMode)
        ? emptyStateAgentTitle
        : emptyStateAskTitle)
  const emptyStateDescription = isYoloAgent
    ? emptyStateAgentFullDescription
    : isAgentChatMode(chatMode)
      ? emptyStateAgentDescription
      : emptyStateAskDescription
  const resolvedEmptyStateIconMode =
    emptyStateIconMode ?? (isYoloAgent ? 'agent-full' : chatMode)
  const resolvedEmptyStateIcon =
    emptyStateIcon ??
    (isYoloAgent ? (
      <InfinityIcon size={18} strokeWidth={2} />
    ) : isAgentChatMode(chatMode) ? (
      <Bot size={18} strokeWidth={2} />
    ) : (
      <MessageCircle size={18} strokeWidth={2} />
    ))

  return (
    <>
      <InstallationIncompleteBanner />
      <SharedConversationSurface
        key={currentConversationId}
        items={chatTimelineItems}
        conversationId={currentConversationId}
        scrollContainerRef={chatMessagesRef}
        onScrollContainerChange={onScrollContainerChange}
        onBottomSentinelChange={onBottomSentinelChange}
        scrollController={scrollController}
        renderItem={renderChatTimelineItem}
        renderVersion={timelineRenderVersion}
        forceRenderItemIds={['bottom-anchor']}
        virtualizationThreshold={
          editingAssistantMessageId ? chatTimelineItems.length : undefined
        }
        containerClassName="yolo-chat-conversation-surface"
        overlaySlot={
          <>
            <AnimatePresence initial={false}>
              {showEmptyState ? (
                <motion.div
                  key="empty-state"
                  className="yolo-chat-empty-state-overlay"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{
                    duration: reduceMotion ? 0 : MOTION_DURATION_EXIT_S,
                    ease: MOTION_EASE_OUT,
                  }}
                >
                  <div className="yolo-chat-empty-state-overlay-inner">
                    <div className="yolo-chat-empty-state">
                      <div
                        key={resolvedEmptyStateIconMode}
                        className="yolo-chat-empty-state-icon"
                        data-mode={resolvedEmptyStateIconMode}
                      >
                        {resolvedEmptyStateIcon}
                      </div>
                      <div className="yolo-chat-empty-state-title">
                        {emptyStateTitle}
                      </div>
                      <div className="yolo-chat-empty-state-description">
                        {emptyStateDescription}
                      </div>
                    </div>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
            {messageNavigatorContent}
          </>
        }
        scrollContainerClassName="yolo-chat-messages"
        onVirtualizationChange={onTimelineVirtualizationChange}
        onUserMessageViewportChange={onUserMessageViewportChange}
        windowNavigationKey={windowNavigationKey}
        windowNavigationTargetMessageId={windowNavigationTargetMessageId}
        hasEarlierMessages={hasEarlierMessages}
        hasNewerMessages={hasNewerMessages}
        onLoadEarlier={onLoadEarlier}
        onLoadNewer={onLoadNewer}
        bottomSpacerHeight={bottomSpacerHeight}
      />
      {/* Animate only the empty-state layout transition. Internal composer
       * changes such as mounting the first badge must not move the footer. */}
      <motion.div
        layout="position"
        layoutDependency={showEmptyState}
        className="yolo-chat-footer"
        transition={{
          layout: reduceMotion ? { duration: 0 } : MOTION_LAYOUT_SPRING,
        }}
      >
        <div className="yolo-chat-floating-actions">
          <AnimatePresence initial={false}>
            {showScrollToBottomButton ? (
              <motion.div
                key="scroll-to-bottom"
                className="yolo-chat-scroll-to-bottom-anchor"
                initial={{ opacity: 0, scale: 0.9, y: 6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{
                  opacity: 0,
                  scale: 0.9,
                  y: 6,
                  transition: {
                    duration: reduceMotion ? 0 : MOTION_DURATION_EXIT_S,
                    ease: MOTION_EASE_IN,
                  },
                }}
                transition={{
                  duration: reduceMotion ? 0 : MOTION_DURATION_ENTER_S,
                  ease: MOTION_EASE_OUT,
                }}
              >
                <button
                  type="button"
                  className="yolo-chat-scroll-to-bottom-button"
                  onClick={onForceScrollToBottom}
                  aria-label={
                    hasStreamingMessages
                      ? scrollToBottomWhileStreamingLabel
                      : scrollToBottomLabel
                  }
                >
                  <ArrowDown size={14} strokeWidth={2.25} />
                </button>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
        {footerContent}
      </motion.div>
    </>
  )
}
