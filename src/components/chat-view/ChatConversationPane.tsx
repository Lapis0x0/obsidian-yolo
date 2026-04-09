import { ArrowDown, Bot, CircleStop, MessageCircle } from 'lucide-react'
import type { ReactNode, RefObject } from 'react'
import type { FollowOutput } from 'react-virtuoso'

import type { ChatMode } from './chat-input/ChatModeSelect'
import { SharedConversationSurface } from './SharedConversationSurface'
import type { ChatTimelineItem } from '../../types/chat-timeline'

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
  currentConversationRunSummaryIsRunning: boolean
  onAbortConversationRun: () => void
  onForceScrollToBottom: () => void
  hasStreamingMessages: boolean
  scrollToBottomLabel: string
  scrollToBottomWhileStreamingLabel: string
  emptyStateChatTitle: string
  emptyStateAgentTitle: string
  emptyStateChatDescription: string
  emptyStateAgentDescription: string
  footerContent: ReactNode
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
  currentConversationRunSummaryIsRunning,
  onAbortConversationRun,
  onForceScrollToBottom,
  hasStreamingMessages,
  scrollToBottomLabel,
  scrollToBottomWhileStreamingLabel,
  emptyStateChatTitle,
  emptyStateAgentTitle,
  emptyStateChatDescription,
  emptyStateAgentDescription,
  footerContent,
}: ChatConversationPaneProps) {
  const showEmptyState =
    groupedChatMessagesLength === 0 && !isCurrentConversationRunActive
  const showScrollToBottomButton =
    !showEmptyState && groupedChatMessagesLength > 0 && !isAutoFollowEnabled

  return (
    <>
      {showEmptyState && (
        <div className="smtcmp-chat-empty-state-overlay" aria-hidden="true">
          <div className="smtcmp-chat-empty-state">
            <div
              key={chatMode}
              className="smtcmp-chat-empty-state-icon"
              data-mode={chatMode}
            >
              {chatMode === 'agent' ? (
                <Bot size={18} strokeWidth={2} />
              ) : (
                <MessageCircle size={18} strokeWidth={2} />
              )}
            </div>
            <div className="smtcmp-chat-empty-state-title">
              {chatMode === 'agent'
                ? emptyStateAgentTitle
                : emptyStateChatTitle}
            </div>
            <div className="smtcmp-chat-empty-state-description">
              {chatMode === 'agent'
                ? emptyStateAgentDescription
                : emptyStateChatDescription}
            </div>
          </div>
        </div>
      )}
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
        scrollContainerClassName="smtcmp-chat-messages"
      />
      <div
        className={`smtcmp-chat-footer${
          isCurrentConversationRunActive ? ' is-generating' : ''
        }`}
      >
        {(isCurrentConversationRunActive || showScrollToBottomButton) && (
          <div className="smtcmp-chat-floating-actions" aria-hidden="true">
            {currentConversationRunSummaryIsRunning && (
              <button
                type="button"
                onClick={onAbortConversationRun}
                className="smtcmp-stop-gen-btn"
              >
                <CircleStop size={16} />
                <div>Stop generation</div>
              </button>
            )}
            {showScrollToBottomButton && (
              <button
                type="button"
                className="smtcmp-chat-scroll-to-bottom-button"
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
            )}
          </div>
        )}
        {footerContent}
      </div>
    </>
  )
}
