import type { QueryProgressState } from '../../components/chat-view/QueryProgress'
import type {
  AssistantToolMessageGroup,
  ChatConversationCompaction,
  ChatUserMessage,
} from '../../types/chat'
import type { ChatTimelineItem } from '../../types/chat-timeline'

const USER_MESSAGE_ESTIMATED_HEIGHT = 92
const ASSISTANT_GROUP_ESTIMATED_HEIGHT = 180
const COMPACTION_ESTIMATED_HEIGHT = 72
const QUERY_PROGRESS_ESTIMATED_HEIGHT = 84
const CONTINUE_RESPONSE_ESTIMATED_HEIGHT = 52
const BOTTOM_ANCHOR_ESTIMATED_HEIGHT = 8
const TIMELINE_START_SPACING = 12
const USER_TO_ASSISTANT_SPACING = 16

export const getDefaultTimelineEstimatedHeight = (
  item: ChatTimelineItem,
): number => {
  switch (item.kind) {
    case 'user-message':
      return USER_MESSAGE_ESTIMATED_HEIGHT
    case 'assistant-group':
      return ASSISTANT_GROUP_ESTIMATED_HEIGHT
    case 'compaction-divider':
    case 'compaction-pending':
      return COMPACTION_ESTIMATED_HEIGHT
    case 'query-progress':
      return QUERY_PROGRESS_ESTIMATED_HEIGHT
    case 'continue-response':
      return CONTINUE_RESPONSE_ESTIMATED_HEIGHT
    case 'bottom-anchor':
      return BOTTOM_ANCHOR_ESTIMATED_HEIGHT
  }
}

type BuildMessageTimelineItemsParams = {
  groupedChatMessages: (ChatUserMessage | AssistantToolMessageGroup)[]
  activeEditableMessageId?: string | null
  activeStreamingMessageId?: string | null
}

export const buildMessageTimelineItems = ({
  groupedChatMessages,
  activeEditableMessageId,
  activeStreamingMessageId,
}: BuildMessageTimelineItemsParams): ChatTimelineItem[] => {
  return groupedChatMessages.map((messageOrGroup, index) => {
    const previousItem = groupedChatMessages[index - 1]
    const spacingBefore =
      (index === 0 ? TIMELINE_START_SPACING : 0) +
      (Array.isArray(messageOrGroup) &&
      previousItem &&
      !Array.isArray(previousItem)
        ? USER_TO_ASSISTANT_SPACING
        : 0)

    if (Array.isArray(messageOrGroup)) {
      const firstMessageId = messageOrGroup.at(0)?.id ?? 'assistant-group'
      const lastMessageId = messageOrGroup.at(-1)?.id ?? firstMessageId
      return {
        kind: 'assistant-group',
        id: firstMessageId,
        renderKey: firstMessageId,
        estimatedHeight: ASSISTANT_GROUP_ESTIMATED_HEIGHT,
        spacingBefore,
        messages: messageOrGroup,
        isPinnedForRender:
          activeStreamingMessageId !== null &&
          lastMessageId === activeStreamingMessageId,
        isStreaming: lastMessageId === activeStreamingMessageId,
      }
    }

    return {
      kind: 'user-message',
      id: messageOrGroup.id,
      renderKey: messageOrGroup.id,
      estimatedHeight: USER_MESSAGE_ESTIMATED_HEIGHT,
      spacingBefore,
      message: messageOrGroup,
      isEditable: true,
      isActive: messageOrGroup.id === activeEditableMessageId,
      isPinnedForRender: messageOrGroup.id === activeEditableMessageId,
    }
  })
}

type BuildChatTimelineItemsParams = {
  groupedChatMessages: (ChatUserMessage | AssistantToolMessageGroup)[]
  compactionDividerAnchorMessageIds: string[]
  latestCompaction: ChatConversationCompaction | null
  pendingCompactionAnchorMessageId?: string | null
  queryProgress?: QueryProgressState
  showContinueResponseButton?: boolean
  activeEditableMessageId?: string | null
  activeEditingAssistantMessageId?: string | null
  activeStreamingMessageId?: string | null
}

export const buildChatTimelineItems = ({
  groupedChatMessages,
  compactionDividerAnchorMessageIds,
  latestCompaction,
  pendingCompactionAnchorMessageId = null,
  queryProgress,
  showContinueResponseButton = false,
  activeEditableMessageId = null,
  activeEditingAssistantMessageId = null,
  activeStreamingMessageId = null,
}: BuildChatTimelineItemsParams): ChatTimelineItem[] => {
  const items: ChatTimelineItem[] = []
  let hasInsertedPendingItem = false
  const compactionAnchorMessageIdSet = new Set(
    compactionDividerAnchorMessageIds,
  )
  const messageItems = buildMessageTimelineItems({
    groupedChatMessages,
    activeEditableMessageId,
    activeStreamingMessageId,
  })

  const insertPendingItem = (anchorMessageId: string) => {
    if (
      hasInsertedPendingItem ||
      !pendingCompactionAnchorMessageId ||
      pendingCompactionAnchorMessageId !== anchorMessageId
    ) {
      return
    }

    items.push({
      kind: 'compaction-pending',
      id: `${pendingCompactionAnchorMessageId}-compact-pending`,
      renderKey: `${pendingCompactionAnchorMessageId}-compact-pending`,
      estimatedHeight: COMPACTION_ESTIMATED_HEIGHT,
      anchorMessageId: pendingCompactionAnchorMessageId,
      isPinnedForRender: true,
    })
    hasInsertedPendingItem = true
  }

  messageItems.forEach((item) => {
    if (item.kind === 'assistant-group') {
      let currentSlice: AssistantToolMessageGroup = []
      let sliceIndex = 0
      const pushCurrentGroup = () => {
        if (currentSlice.length === 0) {
          return
        }

        const firstMessageId =
          currentSlice.at(0)?.id ?? `${item.id}-slice-${sliceIndex}`
        items.push({
          ...item,
          id: firstMessageId,
          renderKey: `${item.id}-slice-${sliceIndex}`,
          messages: currentSlice,
          isPinnedForRender:
            item.isPinnedForRender ||
            currentSlice.some(
              (message) => message.id === activeEditingAssistantMessageId,
            ),
        })
        insertPendingItem(currentSlice.at(-1)?.id ?? '')
        currentSlice = []
        sliceIndex += 1
      }

      item.messages.forEach((message) => {
        currentSlice.push(message)
        if (!compactionAnchorMessageIdSet.has(message.id)) {
          return
        }

        pushCurrentGroup()
        items.push({
          kind: 'compaction-divider',
          id: `${message.id}-compact-divider`,
          renderKey: `${message.id}-compact-divider`,
          estimatedHeight: COMPACTION_ESTIMATED_HEIGHT,
          anchorMessageId: message.id,
          compaction: latestCompaction,
        })
      })

      pushCurrentGroup()
      return
    }

    items.push(item)
    insertPendingItem(item.id)
  })

  if (queryProgress && queryProgress.type !== 'idle') {
    items.push({
      kind: 'query-progress',
      id: 'query-progress',
      renderKey: 'query-progress',
      estimatedHeight: QUERY_PROGRESS_ESTIMATED_HEIGHT,
      isPinnedForRender: true,
    })
  }

  if (showContinueResponseButton) {
    items.push({
      kind: 'continue-response',
      id: 'continue-response',
      renderKey: 'continue-response',
      estimatedHeight: CONTINUE_RESPONSE_ESTIMATED_HEIGHT,
      isPinnedForRender: true,
    })
  }

  items.push({
    kind: 'bottom-anchor',
    id: 'bottom-anchor',
    renderKey: 'bottom-anchor',
    estimatedHeight: BOTTOM_ANCHOR_ESTIMATED_HEIGHT,
    isPinnedForRender: true,
  })

  return items
}
