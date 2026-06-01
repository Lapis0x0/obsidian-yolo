import { ArrowDown, Bot, MessageCircle } from 'lucide-react'
import type { ReactNode, RefObject } from 'react'
import type { FollowOutput } from 'react-virtuoso'

import type { ChatTimelineItem } from '../../types/chat-timeline'

import type { ChatMode } from './chat-input/ChatModeSelect'
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
  emptyStateChatTitle: string
  emptyStateAgentTitle: string
  emptyStateChatDescription: string
  emptyStateAgentDescription: string
  footerContent: ReactNode
  onTimelineVirtualizationChange?: (isVirtualized: boolean) => void
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
  emptyStateChatTitle,
  emptyStateAgentTitle,
  emptyStateChatDescription,
  emptyStateAgentDescription,
  footerContent,
  onTimelineVirtualizationChange,
  bottomSpacerHeight,
}: ChatConversationPaneProps) {
  const showEmptyState =
    groupedChatMessagesLength === 0 && !isCurrentConversationRunActive
  const showScrollToBottomButton =
    !showEmptyState && groupedChatMessagesLength > 0 && !isAutoFollowEnabled

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
          showEmptyState ? (
            <div className="yolo-chat-empty-state-overlay">
              <div className="yolo-chat-empty-state-overlay-inner">
                <div className="yolo-chat-empty-state">
                  <div
                    key={chatMode}
                    className="yolo-chat-empty-state-icon"
                    data-mode={chatMode}
                  >
                    {chatMode === 'agent' ? (
                      <Bot size={18} strokeWidth={2} />
                    ) : (
                      <MessageCircle size={18} strokeWidth={2} />
                    )}
                  </div>
                  <div className="yolo-chat-empty-state-title">
                    {chatMode === 'agent'
                      ? emptyStateAgentTitle
                      : emptyStateChatTitle}
                  </div>
                  <div className="yolo-chat-empty-state-description">
                    {chatMode === 'agent'
                      ? emptyStateAgentDescription
                      : emptyStateChatDescription}
                  </div>
                </div>
              </div>
            </div>
          ) : undefined
        }
        scrollContainerClassName="yolo-chat-messages"
        onVirtualizationChange={onTimelineVirtualizationChange}
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
              title={
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
