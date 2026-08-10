import { useCallback } from 'react'

import type { ChatTimelineItem } from '../../types/chat-timeline'

import {
  ChatConversationPane,
  type ChatConversationPaneProps,
} from './ChatConversationPane'
import type { ConversationTimelineRendererContract } from './conversation-surface-contract'
import { renderConversationTimelineItem } from './conversation-timeline-renderer'

export type ConversationSurfaceContract = Omit<
  ChatConversationPaneProps,
  'renderChatTimelineItem'
> & {
  timelineRendererContract: ConversationTimelineRendererContract
}

export function ConversationSurface({
  timelineRendererContract,
  ...surfaceProps
}: ConversationSurfaceContract) {
  const renderTimelineItem = useCallback(
    (item: ChatTimelineItem) =>
      renderConversationTimelineItem(item, timelineRendererContract),
    [timelineRendererContract],
  )

  return (
    <ChatConversationPane
      {...surfaceProps}
      renderChatTimelineItem={renderTimelineItem}
    />
  )
}
