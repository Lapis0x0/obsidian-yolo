import type { ReactNode } from 'react'

import type { AssistantToolMessageGroup } from '../../types/chat'
import type { ChatTimelineItem } from '../../types/chat-timeline'
import DotLoader from '../common/DotLoader'

import AssistantToolMessageGroupItem from './AssistantToolMessageGroupItem'
import type { ConversationTimelineRendererContract } from './conversation-surface-contract'

export function renderConversationTimelineItem(
  item: ChatTimelineItem,
  contract: ConversationTimelineRendererContract,
): ReactNode {
  if (item.kind === 'compaction-pending') {
    return (
      <div
        className="yolo-chat-compaction-pending"
        data-anchor-message-id={item.anchorMessageId}
      >
        <div className="yolo-chat-compaction-pending__loader">
          <DotLoader text={contract.compaction.pendingTitle} />
        </div>
        <div className="yolo-chat-compaction-pending__description">
          {contract.compaction.pendingDescription}
        </div>
      </div>
    )
  }

  if (item.kind === 'compaction-divider') {
    const enteringClass = contract.compaction.isDividerEntering?.(item)
      ? ' is-entering'
      : ''
    return (
      <div className={`yolo-chat-compaction-divider${enteringClass}`}>
        <div className="yolo-chat-compaction-divider__title">
          {contract.compaction.dividerTitle}
        </div>
        <div className="yolo-chat-compaction-divider__line" />
        <div className="yolo-chat-compaction-divider__content">
          <div className="yolo-chat-compaction-divider__description">
            {contract.compaction.dividerDescription}
          </div>
        </div>
      </div>
    )
  }

  if (item.kind === 'session-fallback-divider') {
    // Structurally identical to the compaction divider above (see
    // `ChatTimelineSessionFallbackDividerItem`'s doc comment) — same
    // classes, but per-item text instead of the surface-wide
    // `contract.compaction` copy, since each notice names a different
    // unreachable profile.
    return (
      <div className="yolo-chat-compaction-divider">
        <div className="yolo-chat-compaction-divider__title">{item.title}</div>
        <div className="yolo-chat-compaction-divider__line" />
        <div className="yolo-chat-compaction-divider__content">
          <div className="yolo-chat-compaction-divider__description">
            {item.description}
          </div>
        </div>
      </div>
    )
  }

  if (item.kind === 'user-message') {
    const message = contract.messagesById.get(item.messageId)
    return message?.role === 'user'
      ? contract.renderUserMessage(message, item)
      : null
  }

  if (item.kind === 'assistant-group') {
    const messages = item.messageIds
      .map((messageId) => contract.messagesById.get(messageId))
      .filter(
        (message): message is AssistantToolMessageGroup[number] =>
          message !== undefined && message.role !== 'user',
      )
    if (messages.length === 0) return null

    const assistantGroupProps = contract.getAssistantGroupProps(messages, item)
    if (!assistantGroupProps) {
      return contract.renderUnboundAssistantGroup?.(messages, item) ?? null
    }
    const actions = {
      ...contract.preset.assistantActions,
      ...contract.getAssistantActionOverrides?.(messages, item),
    }
    const content = (
      <AssistantToolMessageGroupItem
        messages={messages}
        {...assistantGroupProps}
        showInlineInfo={actions.showInlineInfo}
        showRetryAction={actions.showRetryAction}
        showInsertAction={actions.showInsertAction}
        showCopyAction={actions.showCopyAction}
        showBranchAction={actions.showBranchAction}
        showEditAction={actions.showEditAction}
        showDeleteAction={actions.showDeleteAction}
        showQuoteAction={actions.showQuoteAction}
      />
    )
    return contract.wrapAssistantGroup?.(content, item) ?? content
  }

  if (item.kind === 'query-progress') {
    return contract.renderQueryProgress?.(item) ?? null
  }
  if (item.kind === 'pending-response') {
    return contract.renderPendingResponse?.(item) ?? null
  }
  if (item.kind === 'continue-response') {
    return contract.renderContinueResponse?.(item) ?? null
  }

  if (item.kind === 'bottom-anchor') {
    return <div className={contract.bottomAnchorClassName} aria-hidden="true" />
  }

  return null
}
