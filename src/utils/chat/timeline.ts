import type { QueryProgressState } from '../../components/chat-view/QueryProgress'
import type {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
  ChatConversationCompaction,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'
import { getToolCallArgumentsText } from '../../types/tool-call.types'
import type { ChatTimelineItem } from '../../types/chat-timeline'
import { editorStateToPlainText } from '../../components/chat-view/chat-input/utils/editor-state-to-plain-text'

const USER_MESSAGE_ESTIMATED_HEIGHT = 92
const ASSISTANT_GROUP_ESTIMATED_HEIGHT = 180
const COMPACTION_ESTIMATED_HEIGHT = 72
const QUERY_PROGRESS_ESTIMATED_HEIGHT = 84
const CONTINUE_RESPONSE_ESTIMATED_HEIGHT = 52
const BOTTOM_ANCHOR_ESTIMATED_HEIGHT = 8
const TIMELINE_START_SPACING = 12
const USER_TO_ASSISTANT_SPACING = 16
const USER_MESSAGE_MAX_ESTIMATED_HEIGHT = 420
const ASSISTANT_GROUP_MAX_ESTIMATED_HEIGHT = 2800
const TOOL_MESSAGE_MAX_ESTIMATED_HEIGHT = 720

function clampEstimatedHeight(
  value: number,
  { min, max }: { min: number; max: number },
): number {
  return Math.max(min, Math.min(max, Math.ceil(value)))
}

function countMatches(content: string, pattern: RegExp): number {
  return content.match(pattern)?.length ?? 0
}

function estimateMarkdownTextHeight(
  content: string,
  {
    baseHeight,
    charsPerLine,
    lineHeight,
    maxHeight,
  }: {
    baseHeight: number
    charsPerLine: number
    lineHeight: number
    maxHeight: number
  },
): number {
  const trimmed = content.trim()
  if (!trimmed) {
    return baseHeight
  }

  const explicitLineCount = trimmed.split('\n').length
  const wrappedLineCount = Math.ceil(trimmed.length / charsPerLine)
  const effectiveLineCount = Math.max(explicitLineCount, wrappedLineCount)
  const paragraphCount =
    countMatches(trimmed, /\n\s*\n/g) + 1
  const headingCount = countMatches(trimmed, /^#{1,6}\s/gm)
  const listItemCount = countMatches(trimmed, /^\s*(?:[-*+]|\d+\.)\s/gm)
  const quoteCount = countMatches(trimmed, /^\s*>\s/gm)
  const codeFenceCount = Math.floor(countMatches(trimmed, /^```/gm) / 2)

  const estimated =
    baseHeight +
    effectiveLineCount * lineHeight +
    paragraphCount * 10 +
    headingCount * 18 +
    listItemCount * 6 +
    quoteCount * 8 +
    codeFenceCount * 120

  return clampEstimatedHeight(estimated, {
    min: baseHeight,
    max: maxHeight,
  })
}

function estimateUserMessageHeight(message: ChatUserMessage): number {
  const text = editorStateToPlainText(message.content)
  const mentionableCount = message.mentionables.length
  const selectedSkillCount = message.selectedSkills?.length ?? 0
  const similarityResultCount = message.similaritySearchResults?.length ?? 0
  const estimated =
    estimateMarkdownTextHeight(text, {
      baseHeight: USER_MESSAGE_ESTIMATED_HEIGHT,
      charsPerLine: 34,
      lineHeight: 18,
      maxHeight: USER_MESSAGE_MAX_ESTIMATED_HEIGHT,
    }) +
    mentionableCount * 22 +
    selectedSkillCount * 18 +
    similarityResultCount * 56

  return clampEstimatedHeight(estimated, {
    min: USER_MESSAGE_ESTIMATED_HEIGHT,
    max: USER_MESSAGE_MAX_ESTIMATED_HEIGHT,
  })
}

function estimateAssistantMessageHeight(message: ChatAssistantMessage): number {
  const contentHeight = estimateMarkdownTextHeight(message.content, {
    baseHeight: 96,
    charsPerLine: 38,
    lineHeight: 20,
    maxHeight: ASSISTANT_GROUP_MAX_ESTIMATED_HEIGHT,
  })
  const reasoningHeight = message.reasoning
    ? estimateMarkdownTextHeight(message.reasoning, {
        baseHeight: 54,
        charsPerLine: 42,
        lineHeight: 18,
        maxHeight: 520,
      })
    : 0
  const annotationHeight = (message.annotations?.length ?? 0) * 42
  const toolRequestHeight = (message.toolCallRequests?.length ?? 0) * 36

  return contentHeight + reasoningHeight + annotationHeight + toolRequestHeight
}

function estimateToolMessageHeight(message: ChatToolMessage): number {
  const toolCallCount = message.toolCalls.length
  const payloadWeight = message.toolCalls.reduce((sum, toolCall) => {
    const requestArgsLength =
      getToolCallArgumentsText(toolCall.request.arguments)?.length ?? 0
    const responseLength = JSON.stringify(toolCall.response ?? {}).length
    return sum + requestArgsLength + responseLength
  }, 0)

  const estimated = 72 + toolCallCount * 64 + Math.ceil(payloadWeight / 180)
  return clampEstimatedHeight(estimated, {
    min: 72,
    max: TOOL_MESSAGE_MAX_ESTIMATED_HEIGHT,
  })
}

function estimateAssistantGroupHeight(messages: AssistantToolMessageGroup): number {
  const estimated = messages.reduce((sum, message) => {
    if (message.role === 'assistant') {
      return sum + estimateAssistantMessageHeight(message)
    }

    return sum + estimateToolMessageHeight(message)
  }, 0)

  return clampEstimatedHeight(estimated + 20, {
    min: ASSISTANT_GROUP_ESTIMATED_HEIGHT,
    max: ASSISTANT_GROUP_MAX_ESTIMATED_HEIGHT,
  })
}

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
  assistantGroupBoundaryMessageIds?: readonly string[]
  activeEditableMessageId?: string | null
  activeStreamingMessageId?: string | null
  includeBottomAnchor?: boolean
}

export const buildMessageTimelineItems = ({
  groupedChatMessages,
  assistantGroupBoundaryMessageIds = [],
  activeEditableMessageId,
  activeStreamingMessageId,
  includeBottomAnchor = false,
}: BuildMessageTimelineItemsParams): ChatTimelineItem[] => {
  const assistantGroupBoundaryMessageIdSet = new Set(
    assistantGroupBoundaryMessageIds,
  )
  const items: ChatTimelineItem[] = groupedChatMessages.map((messageOrGroup, index) => {
    const previousItem = groupedChatMessages[index - 1]
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
        estimatedHeight: estimateAssistantGroupHeight(messageOrGroup),
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
      estimatedHeight: estimateUserMessageHeight(messageOrGroup),
      spacingBefore,
      message: messageOrGroup,
      isEditable: true,
      isActive: messageOrGroup.id === activeEditableMessageId,
      isPinnedForRender: messageOrGroup.id === activeEditableMessageId,
    }
  })

  if (includeBottomAnchor) {
    items.push({
      kind: 'bottom-anchor',
      id: 'bottom-anchor',
      renderKey: 'bottom-anchor',
      estimatedHeight: BOTTOM_ANCHOR_ESTIMATED_HEIGHT,
      isPinnedForRender: true,
    })
  }

  return items
}

type BuildChatTimelineItemsParams = {
  groupedChatMessages: (ChatUserMessage | AssistantToolMessageGroup)[]
  assistantGroupBoundaryMessageIds?: readonly string[]
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
  assistantGroupBoundaryMessageIds = [],
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
    assistantGroupBoundaryMessageIds,
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
