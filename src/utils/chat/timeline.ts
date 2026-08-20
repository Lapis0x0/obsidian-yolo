import type { QueryProgressState } from '../../components/chat-view/QueryProgress'
import type {
  AssistantToolMessageGroup,
  ChatConversationCompaction,
  ChatUserMessage,
} from '../../types/chat'
import type { ChatTimelineItem } from '../../types/chat-timeline'

const TIMELINE_START_SPACING = 12
const USER_TO_ASSISTANT_SPACING = 24

type BuildMessageTimelineItemsParams = {
  groupedChatMessages: (ChatUserMessage | AssistantToolMessageGroup)[]
  revisionsById?: ReadonlyMap<string, number>
  assistantGroupBoundaryMessageIds?: readonly string[]
  activeEditableMessageId?: string | null
  activeStreamingMessageId?: string | null
  includeBottomAnchor?: boolean
}

const getMessageRevision = (
  revisionsById: ReadonlyMap<string, number> | undefined,
  messageId: string,
): number => revisionsById?.get(messageId) ?? 0

const getGroupRevision = (
  messages: AssistantToolMessageGroup,
  revisionsById: ReadonlyMap<string, number> | undefined,
): number =>
  messages.reduce(
    (revision, message) =>
      revision + getMessageRevision(revisionsById, message.id),
    messages.length,
  )

export const buildMessageTimelineItems = ({
  groupedChatMessages,
  revisionsById,
  assistantGroupBoundaryMessageIds = [],
  activeEditableMessageId,
  activeStreamingMessageId,
  includeBottomAnchor = false,
}: BuildMessageTimelineItemsParams): ChatTimelineItem[] => {
  const assistantGroupBoundaryMessageIdSet = new Set(
    assistantGroupBoundaryMessageIds,
  )
  const renderableGroupedChatMessages = groupedChatMessages.filter(
    (messageOrGroup) => {
      if (!Array.isArray(messageOrGroup) || messageOrGroup.length !== 1) {
        return true
      }

      const message = messageOrGroup[0]
      return (
        message?.role !== 'subagent_result' &&
        message?.role !== 'terminal_command_result'
      )
    },
  )
  const items: ChatTimelineItem[] = renderableGroupedChatMessages.map(
    (messageOrGroup, index) => {
      const previousItem = renderableGroupedChatMessages[index - 1]
      const firstMessageId = Array.isArray(messageOrGroup)
        ? (messageOrGroup.at(0)?.id ?? 'assistant-group')
        : messageOrGroup.id
      const spacingBefore =
        (index === 0 ? TIMELINE_START_SPACING : 0) +
        ((Array.isArray(messageOrGroup) &&
          previousItem &&
          !Array.isArray(previousItem)) ||
        (Array.isArray(messageOrGroup) &&
          previousItem &&
          Array.isArray(previousItem) &&
          assistantGroupBoundaryMessageIdSet.has(firstMessageId))
          ? USER_TO_ASSISTANT_SPACING
          : 0)

      if (Array.isArray(messageOrGroup)) {
        const lastMessageId = messageOrGroup.at(-1)?.id ?? firstMessageId
        return {
          kind: 'assistant-group',
          id: firstMessageId,
          renderKey: firstMessageId,
          spacingBefore,
          groupId: firstMessageId,
          messageIds: messageOrGroup.map((message) => message.id),
          revision: getGroupRevision(messageOrGroup, revisionsById),
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
        spacingBefore,
        messageId: messageOrGroup.id,
        revision: getMessageRevision(revisionsById, messageOrGroup.id),
        isEditable: true,
        isActive: messageOrGroup.id === activeEditableMessageId,
        isPinnedForRender: messageOrGroup.id === activeEditableMessageId,
      }
    },
  )

  if (includeBottomAnchor) {
    items.push({
      kind: 'bottom-anchor',
      id: 'bottom-anchor',
      renderKey: 'bottom-anchor',
      isPinnedForRender: true,
    })
  }

  return items
}

type BuildChatTimelineItemsParams = {
  groupedChatMessages: (ChatUserMessage | AssistantToolMessageGroup)[]
  revisionsById?: ReadonlyMap<string, number>
  assistantGroupBoundaryMessageIds?: readonly string[]
  compactionDividerAnchorMessageIds: string[]
  compactionDividers?: readonly {
    id: string
    anchorMessageId: string | null
    compaction: ChatConversationCompaction | null
  }[]
  latestCompaction: ChatConversationCompaction | null
  pendingCompactionAnchorMessageId?: string | null
  /**
   * "Resumed session couldn't be reached, started a fresh one instead"
   * notices (see `CliSessionFallbackBoundary` / `ChatTimelineSessionFallbackDividerItem`).
   * Anchored and inserted the same way as `compactionDividers`, but kept as
   * a separate stream since the two boundary kinds are unrelated events
   * that happen to share one divider visual.
   */
  sessionFallbackDividers?: readonly {
    id: string
    anchorMessageId: string | null
    title: string
    description: string
  }[]
  queryProgress?: QueryProgressState
  showContinueResponseButton?: boolean
  activeEditableMessageId?: string | null
  activeEditingAssistantMessageId?: string | null
  activeStreamingMessageId?: string | null
}

export const buildChatTimelineItems = ({
  groupedChatMessages,
  revisionsById,
  assistantGroupBoundaryMessageIds = [],
  compactionDividerAnchorMessageIds,
  compactionDividers,
  latestCompaction,
  pendingCompactionAnchorMessageId = null,
  sessionFallbackDividers = [],
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
  const resolvedCompactionDividers =
    compactionDividers ??
    compactionDividerAnchorMessageIds.map((anchorMessageId) => ({
      id: `${anchorMessageId}-compact-divider`,
      anchorMessageId,
      compaction: latestCompaction,
    }))
  const compactionDividersByAnchor = new Map<
    string | null,
    Array<(typeof resolvedCompactionDividers)[number]>
  >()
  for (const divider of resolvedCompactionDividers) {
    const anchored = compactionDividersByAnchor.get(divider.anchorMessageId)
    if (anchored) anchored.push(divider)
    else compactionDividersByAnchor.set(divider.anchorMessageId, [divider])
  }
  const insertCompactionDividers = (anchorMessageId: string | null) => {
    for (const divider of compactionDividersByAnchor.get(anchorMessageId) ??
      []) {
      items.push({
        kind: 'compaction-divider',
        id: divider.id,
        renderKey: divider.id,
        anchorMessageId,
        compaction: divider.compaction,
      })
    }
  }
  const sessionFallbackAnchorMessageIdSet = new Set(
    sessionFallbackDividers.map((divider) => divider.anchorMessageId),
  )
  const sessionFallbackDividersByAnchor = new Map<
    string | null,
    Array<(typeof sessionFallbackDividers)[number]>
  >()
  for (const divider of sessionFallbackDividers) {
    const anchored = sessionFallbackDividersByAnchor.get(
      divider.anchorMessageId,
    )
    if (anchored) anchored.push(divider)
    else sessionFallbackDividersByAnchor.set(divider.anchorMessageId, [divider])
  }
  const insertSessionFallbackDividers = (anchorMessageId: string | null) => {
    for (const divider of sessionFallbackDividersByAnchor.get(
      anchorMessageId,
    ) ?? []) {
      items.push({
        kind: 'session-fallback-divider',
        id: divider.id,
        renderKey: divider.id,
        anchorMessageId,
        title: divider.title,
        description: divider.description,
      })
    }
  }
  const insertBoundaryDividers = (anchorMessageId: string | null) => {
    insertCompactionDividers(anchorMessageId)
    insertSessionFallbackDividers(anchorMessageId)
  }
  const messagesById = new Map<
    string,
    ChatUserMessage | AssistantToolMessageGroup[number]
  >()
  groupedChatMessages.forEach((messageOrGroup) => {
    if (Array.isArray(messageOrGroup)) {
      messageOrGroup.forEach((message) => {
        messagesById.set(message.id, message)
      })
      return
    }

    messagesById.set(messageOrGroup.id, messageOrGroup)
  })
  const messageItems = buildMessageTimelineItems({
    groupedChatMessages,
    revisionsById,
    assistantGroupBoundaryMessageIds,
    activeEditableMessageId,
    activeStreamingMessageId,
  })

  insertBoundaryDividers(null)

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
      anchorMessageId: pendingCompactionAnchorMessageId,
      isPinnedForRender: true,
    })
    hasInsertedPendingItem = true
  }

  messageItems.forEach((item) => {
    if (item.kind === 'assistant-group') {
      const groupMessages = item.messageIds
        .map((messageId) => messagesById.get(messageId))
        .filter(
          (message): message is AssistantToolMessageGroup[number] =>
            message !== undefined && message.role !== 'user',
        )
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
          groupId: item.groupId,
          messageIds: currentSlice.map((message) => message.id),
          revision: getGroupRevision(currentSlice, revisionsById),
          isPinnedForRender:
            currentSlice.at(-1)?.id === activeStreamingMessageId ||
            currentSlice.some(
              (message) => message.id === activeEditingAssistantMessageId,
            ),
          isStreaming: currentSlice.at(-1)?.id === activeStreamingMessageId,
        })
        insertPendingItem(currentSlice.at(-1)?.id ?? '')
        currentSlice = []
        sliceIndex += 1
      }

      groupMessages.forEach((message) => {
        currentSlice.push(message)
        if (
          !compactionAnchorMessageIdSet.has(message.id) &&
          !sessionFallbackAnchorMessageIdSet.has(message.id)
        ) {
          return
        }

        pushCurrentGroup()
        insertBoundaryDividers(message.id)
      })

      pushCurrentGroup()
      return
    }

    items.push(item)
    insertPendingItem(item.id)
    insertBoundaryDividers(item.id)
  })

  if (queryProgress && queryProgress.type !== 'idle') {
    items.push({
      kind: 'query-progress',
      id: 'query-progress',
      renderKey: 'query-progress',
      isPinnedForRender: true,
    })
  }

  if (showContinueResponseButton) {
    items.push({
      kind: 'continue-response',
      id: 'continue-response',
      renderKey: 'continue-response',
      isPinnedForRender: true,
    })
  }

  items.push({
    kind: 'bottom-anchor',
    id: 'bottom-anchor',
    renderKey: 'bottom-anchor',
    isPinnedForRender: true,
  })

  return items
}
