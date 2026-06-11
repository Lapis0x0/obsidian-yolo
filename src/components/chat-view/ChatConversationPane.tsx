import {
  ArrowDown,
  Bot,
  Infinity as InfinityIcon,
  MessageCircle,
} from 'lucide-react'
import type { ReactNode, RefObject } from 'react'
import type { FollowOutput } from 'react-virtuoso'

import type { ChatTimelineItem } from '../../types/chat-timeline'

import type { ChatMode } from './chat-input/ChatModeSelect'
import { isAgentChatMode } from './chat-input/ChatModeSelect'
import { InstallationIncompleteBanner } from './InstallationIncompleteBanner'
import { SharedConversationSurface } from './SharedConversationSurface'

type ChatConversationPaneProps = {
  chatMode: ChatMode
  groupedChatMessagesLength: number
  isCurrentConversationRunActive: boolean
  isAutoFollowEnabled: boolean
  currentConversationId: string
  chatTimelineItems: ChatTimelineItem[]
  chatMessagesRef: RefObject<HTMLDivElement>
  renderChatTimelineItem: (timelineItem: ChatTimelineItem) => ReactNode
  followOutput: FollowOutput
  onAtBottomStateChange: (atBottom: boolean) => void
  editingAssistantMessageId: string | null
  onForceScrollToBottom: () => void
  hasStreamingMessages: boolean
  scrollToBottomLabel: string
  scrollToBottomWhileStreamingLabel: string
  emptyStateAskTitle: string
  emptyStateAgentTitle: string
  emptyStateAgentFullTitle: string
  emptyStateAskDescription: string
  emptyStateAgentDescription: string
  emptyStateAgentFullDescription: string
  footerContent: ReactNode
  onTimelineVirtualizationChange?: (isVirtualized: boolean) => void
  onActiveUserMessageChange?: (messageId: string | null) => void
  windowNavigationKey?: number
  messageNavigatorContent?: ReactNode
  hasEarlierMessages?: boolean
  hasNewerMessages?: boolean
  onLoadEarlier?: () => void
  onLoadNewer?: () => void
  loadEarlierLabel?: string
  loadNewerLabel?: string
  bottomSpacerHeight?: number
}

export function ChatConversationPane({
  chatMode,
  groupedChatMessagesLength,
  isCurrentConversationRunActive,
  isAutoFollowEnabled,
  currentConversationId,
  chatTimelineItems,
  chatMessagesRef,
  renderChatTimelineItem,
  followOutput,
  onAtBottomStateChange,
  editingAssistantMessageId,
  onForceScrollToBottom,
  hasStreamingMessages,
  scrollToBottomLabel,
  scrollToBottomWhileStreamingLabel,
  emptyStateAskTitle,
  emptyStateAgentTitle,
  emptyStateAgentFullTitle,
  emptyStateAskDescription,
  emptyStateAgentDescription,
  emptyStateAgentFullDescription,
  footerContent,
  onTimelineVirtualizationChange,
  onActiveUserMessageChange,
  windowNavigationKey,
  messageNavigatorContent,
  hasEarlierMessages,
  hasNewerMessages,
  onLoadEarlier,
  onLoadNewer,
  loadEarlierLabel,
  loadNewerLabel,
  bottomSpacerHeight,
}: ChatConversationPaneProps) {
  const showEmptyState =
    groupedChatMessagesLength === 0 && !isCurrentConversationRunActive
  const showScrollToBottomButton =
    !showEmptyState &&
    groupedChatMessagesLength > 0 &&
    (!isAutoFollowEnabled || hasNewerMessages)

  const emptyStateTitle =
    chatMode === 'agent-full'
      ? emptyStateAgentFullTitle
      : isAgentChatMode(chatMode)
        ? emptyStateAgentTitle
        : emptyStateAskTitle
  const emptyStateDescription =
    chatMode === 'agent-full'
      ? emptyStateAgentFullDescription
      : isAgentChatMode(chatMode)
        ? emptyStateAgentDescription
        : emptyStateAskDescription

  return (
    <>
      <InstallationIncompleteBanner />
      <SharedConversationSurface
        items={chatTimelineItems}
        conversationId={currentConversationId}
        scrollContainerRef={chatMessagesRef}
        renderItem={renderChatTimelineItem}
        forceRenderItemIds={['bottom-anchor']}
        followOutput={followOutput}
        onAtBottomStateChange={onAtBottomStateChange}
        virtualizationThreshold={
          editingAssistantMessageId ? chatTimelineItems.length : undefined
        }
        containerClassName="yolo-chat-conversation-surface"
        overlaySlot={
          showEmptyState || messageNavigatorContent ? (
            <>
              {showEmptyState ? (
                <div className="yolo-chat-empty-state-overlay">
                  <div className="yolo-chat-empty-state-overlay-inner">
                    <div className="yolo-chat-empty-state">
                      <div
                        key={chatMode}
                        className="yolo-chat-empty-state-icon"
                        data-mode={chatMode}
                      >
                        {chatMode === 'agent-full' ? (
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
                </div>
              ) : null}
              {messageNavigatorContent}
            </>
          ) : undefined
        }
        scrollContainerClassName="yolo-chat-messages"
        onVirtualizationChange={onTimelineVirtualizationChange}
        onActiveUserMessageChange={onActiveUserMessageChange}
        windowNavigationKey={windowNavigationKey}
        hasEarlierMessages={hasEarlierMessages}
        hasNewerMessages={hasNewerMessages}
        onLoadEarlier={onLoadEarlier}
        onLoadNewer={onLoadNewer}
        loadEarlierLabel={loadEarlierLabel}
        loadNewerLabel={loadNewerLabel}
        bottomSpacerHeight={bottomSpacerHeight}
      />
      <div className="yolo-chat-footer">
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
      </div>
    </>
  )
}
