import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  ArrowDown,
  Bot,
  Infinity as InfinityIcon,
  MessageCircle,
} from 'lucide-react'
import type { ReactNode, RefObject } from 'react'

import type { ChatTimelineItem } from '../../types/chat-timeline'

import type { ChatMode } from './chat-input/ChatModeSelect'
import { isAgentChatMode } from './chat-input/ChatModeSelect'
import type {
  ChatTimelineRenderVersion,
  UserMessageViewportState,
} from './ChatTimelineList'
import { InstallationIncompleteBanner } from './InstallationIncompleteBanner'
import { SharedConversationSurface } from './SharedConversationSurface'

type ChatConversationPaneProps = {
  chatMode: ChatMode
  yoloEnabled: boolean
  showEmptyState: boolean
  groupedChatMessagesLength: number
  isAutoFollowEnabled: boolean
  currentConversationId: string
  chatTimelineItems: ChatTimelineItem[]
  chatMessagesRef: RefObject<HTMLDivElement>
  onScrollContainerChange: (element: HTMLElement | null) => void
  onContentElementChange: (element: HTMLElement | null) => void
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
  onContentElementChange,
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

  return (
    <>
      <InstallationIncompleteBanner />
      <SharedConversationSurface
        key={`${currentConversationId}:${groupedChatMessagesLength > 0 ? 'ready' : 'empty'}`}
        items={chatTimelineItems}
        conversationId={currentConversationId}
        scrollContainerRef={chatMessagesRef}
        onScrollContainerChange={onScrollContainerChange}
        onContentElementChange={onContentElementChange}
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
                    duration: reduceMotion ? 0 : 0.12,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                >
                  <div className="yolo-chat-empty-state-overlay-inner">
                    <div className="yolo-chat-empty-state">
                      <div
                        key={`${chatMode}-${isYoloAgent ? 'yolo' : 'std'}`}
                        className="yolo-chat-empty-state-icon"
                        data-mode={isYoloAgent ? 'agent-full' : chatMode}
                      >
                        {isYoloAgent ? (
                          <InfinityIcon size={18} strokeWidth={2} />
                        ) : isAgentChatMode(chatMode) ? (
                          <Bot size={18} strokeWidth={2} />
                        ) : (
                          <MessageCircle size={18} strokeWidth={2} />
                        )}
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
        scrollContainerClassName={`yolo-chat-messages${isAutoFollowEnabled ? ' yolo-chat-messages--following' : ''}`}
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
      <motion.div
        layout="position"
        className="yolo-chat-footer"
        transition={{
          layout: {
            duration: reduceMotion ? 0 : 0.28,
            ease: [0.22, 1, 0.36, 1],
          },
        }}
      >
        {showScrollToBottomButton && (
          <div className="yolo-chat-floating-actions">
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
          </div>
        )}
        {footerContent}
      </motion.div>
    </>
  )
}
