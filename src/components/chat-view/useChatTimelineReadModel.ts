import isEqual from 'lodash.isequal'
import { useMemo, useRef } from 'react'

import type {
  AssistantToolMessageGroup,
  ChatMessage,
  ChatUserMessage,
} from '../../types/chat'
import type { ChatTimelineItem } from '../../types/chat-timeline'
import { groupAssistantAndToolMessages } from '../../utils/chat/message-groups'

type GroupedChatMessage = ChatUserMessage | AssistantToolMessageGroup

export type ChatTimelineReadModel = {
  messageIds: string[]
  assistantGroupBoundaryMessageIds: readonly string[]
  messagesById: ReadonlyMap<string, ChatMessage>
  revisionsById: ReadonlyMap<string, number>
  groupedChatMessages: GroupedChatMessage[]
  groupsById: ReadonlyMap<string, AssistantToolMessageGroup>
  groupMessageIdsById: ReadonlyMap<string, readonly string[]>
  groupRevisionsById: ReadonlyMap<string, number>
}

type MutableChatTimelineReadModel = {
  messageIds: string[]
  assistantGroupBoundaryMessageIds: readonly string[]
  messagesById: Map<string, ChatMessage>
  revisionsById: Map<string, number>
  groupedChatMessages: GroupedChatMessage[]
  groupsById: Map<string, AssistantToolMessageGroup>
  groupMessageIdsById: Map<string, readonly string[]>
  groupRevisionsById: Map<string, number>
}

export const EMPTY_CHAT_TIMELINE_READ_MODEL: ChatTimelineReadModel = {
  messageIds: [],
  assistantGroupBoundaryMessageIds: [],
  messagesById: new Map(),
  revisionsById: new Map(),
  groupedChatMessages: [],
  groupsById: new Map(),
  groupMessageIdsById: new Map(),
  groupRevisionsById: new Map(),
}

const EMPTY_ASSISTANT_GROUP_BOUNDARY_MESSAGE_IDS: readonly string[] = []

const getGroupId = (messages: AssistantToolMessageGroup): string =>
  messages.at(0)?.id ?? 'assistant-group'

export function findAssistantGroupIdForRunAnchor({
  groupedChatMessages,
  anchorMessageId,
}: {
  groupedChatMessages: GroupedChatMessage[]
  anchorMessageId?: string
}): string | null {
  if (!anchorMessageId) {
    return null
  }

  let sourceMatchedGroupId: string | null = null
  for (const messageOrGroup of groupedChatMessages) {
    if (!Array.isArray(messageOrGroup)) {
      continue
    }

    const hasMatchingSource = messageOrGroup.some(
      (message) =>
        message.role !== 'external_agent_result' &&
        message.role !== 'subagent_result' &&
        message.role !== 'terminal_command_result' &&
        message.metadata?.sourceUserMessageId === anchorMessageId,
    )
    if (hasMatchingSource) {
      sourceMatchedGroupId = getGroupId(messageOrGroup)
    }
  }
  if (sourceMatchedGroupId) {
    return sourceMatchedGroupId
  }

  let isWithinAnchoredTurn = false
  let positionalGroupId: string | null = null
  for (const messageOrGroup of groupedChatMessages) {
    if (!Array.isArray(messageOrGroup)) {
      if (messageOrGroup.id === anchorMessageId) {
        isWithinAnchoredTurn = true
        positionalGroupId = null
      } else if (isWithinAnchoredTurn) {
        break
      }
      continue
    }

    if (!isWithinAnchoredTurn) {
      continue
    }

    const onlyMessage = messageOrGroup.length === 1 ? messageOrGroup[0] : null
    if (
      onlyMessage?.role === 'subagent_result' ||
      onlyMessage?.role === 'terminal_command_result'
    ) {
      continue
    }
    positionalGroupId = getGroupId(messageOrGroup)
  }

  return positionalGroupId
}

const getGroupRevision = (
  messageIds: readonly string[],
  revisionsById: ReadonlyMap<string, number>,
): number =>
  messageIds.reduce(
    (revision, messageId) => revision + (revisionsById.get(messageId) ?? 0),
    messageIds.length,
  )

const sameStringArray = (
  left: readonly string[] | undefined,
  right: readonly string[],
): boolean =>
  left !== undefined &&
  left.length === right.length &&
  left.every((value, index) => value === right[index])

export function materializeChatTimelineReadModel({
  messages,
  assistantGroupBoundaryMessageIds,
  previous,
}: {
  messages: ChatMessage[]
  assistantGroupBoundaryMessageIds: readonly string[]
  previous: ChatTimelineReadModel
}): MutableChatTimelineReadModel {
  const incomingMessageIds = messages.map((message) => message.id)
  const canReusePrevious =
    sameStringArray(previous.messageIds, incomingMessageIds) &&
    sameStringArray(
      previous.assistantGroupBoundaryMessageIds,
      assistantGroupBoundaryMessageIds,
    ) &&
    messages.every((incomingMessage) => {
      const previousMessage = previous.messagesById.get(incomingMessage.id)
      return (
        previousMessage !== undefined &&
        (previousMessage === incomingMessage ||
          isEqual(previousMessage, incomingMessage))
      )
    })

  if (canReusePrevious) {
    return previous as MutableChatTimelineReadModel
  }

  const messageIds: string[] = []
  const messagesById = new Map<string, ChatMessage>()
  const revisionsById = new Map<string, number>()

  for (const incomingMessage of messages) {
    const previousMessage = previous.messagesById.get(incomingMessage.id)
    const previousRevision = previous.revisionsById.get(incomingMessage.id) ?? 0
    const isUnchanged =
      previousMessage !== undefined &&
      (previousMessage === incomingMessage ||
        isEqual(previousMessage, incomingMessage))
    const message = isUnchanged ? previousMessage : incomingMessage

    messageIds.push(incomingMessage.id)
    messagesById.set(incomingMessage.id, message)
    revisionsById.set(
      incomingMessage.id,
      isUnchanged ? previousRevision : previousRevision + 1,
    )
  }

  const groupedChatMessages = groupAssistantAndToolMessages(
    messageIds
      .map((messageId) => messagesById.get(messageId))
      .filter((message): message is ChatMessage => message !== undefined),
    assistantGroupBoundaryMessageIds,
  ).map((messageOrGroup): GroupedChatMessage => {
    if (!Array.isArray(messageOrGroup)) {
      return messageOrGroup
    }

    const groupId = getGroupId(messageOrGroup)
    const messageIds = messageOrGroup.map((message) => message.id)
    const revision = getGroupRevision(messageIds, revisionsById)
    const previousMessageIds = previous.groupMessageIdsById.get(groupId)
    const previousRevision = previous.groupRevisionsById.get(groupId)
    const previousGroup = previous.groupsById.get(groupId)

    if (
      previousGroup &&
      previousRevision === revision &&
      sameStringArray(previousMessageIds, messageIds)
    ) {
      return previousGroup
    }

    return messageOrGroup
  })

  const groupsById = new Map<string, AssistantToolMessageGroup>()
  const groupMessageIdsById = new Map<string, readonly string[]>()
  const groupRevisionsById = new Map<string, number>()

  groupedChatMessages.forEach((messageOrGroup) => {
    if (!Array.isArray(messageOrGroup)) {
      return
    }

    const groupId = getGroupId(messageOrGroup)
    const groupMessageIds = messageOrGroup.map((message) => message.id)
    groupsById.set(groupId, messageOrGroup)
    groupMessageIdsById.set(groupId, groupMessageIds)
    groupRevisionsById.set(
      groupId,
      getGroupRevision(groupMessageIds, revisionsById),
    )
  })

  return {
    messageIds,
    assistantGroupBoundaryMessageIds,
    messagesById,
    revisionsById,
    groupedChatMessages,
    groupsById,
    groupMessageIdsById,
    groupRevisionsById,
  }
}

export function useChatTimelineReadModel({
  messages,
  assistantGroupBoundaryMessageIds = EMPTY_ASSISTANT_GROUP_BOUNDARY_MESSAGE_IDS,
}: {
  messages: ChatMessage[]
  assistantGroupBoundaryMessageIds?: readonly string[]
}): ChatTimelineReadModel {
  const previousRef = useRef<MutableChatTimelineReadModel>(
    EMPTY_CHAT_TIMELINE_READ_MODEL as MutableChatTimelineReadModel,
  )

  return useMemo(() => {
    const next = materializeChatTimelineReadModel({
      messages,
      assistantGroupBoundaryMessageIds,
      previous: previousRef.current,
    })
    previousRef.current = next
    return next
  }, [assistantGroupBoundaryMessageIds, messages])
}

const sameTimelineItem = (
  previous: ChatTimelineItem,
  next: ChatTimelineItem,
): boolean => {
  if (previous.kind !== next.kind) {
    return false
  }

  const previousEntries = Object.entries(previous)
  const nextEntries = Object.entries(next)
  if (previousEntries.length !== nextEntries.length) {
    return false
  }

  return nextEntries.every(([key, value]) => {
    const previousValue = (previous as Record<string, unknown>)[key]
    if (Array.isArray(value) && Array.isArray(previousValue)) {
      return sameStringArray(previousValue, value)
    }
    return Object.is(previousValue, value)
  })
}

export function useStableChatTimelineItems<TItem extends ChatTimelineItem>(
  items: TItem[],
): TItem[] {
  const previousItemsByRenderKeyRef = useRef<Map<string, TItem>>(new Map())

  return useMemo(() => {
    const nextItemsByRenderKey = new Map<string, TItem>()
    const stableItems = items.map((item) => {
      const previous = previousItemsByRenderKeyRef.current.get(item.renderKey)
      const stableItem =
        previous && sameTimelineItem(previous, item) ? previous : item
      nextItemsByRenderKey.set(item.renderKey, stableItem)
      return stableItem
    })
    previousItemsByRenderKeyRef.current = nextItemsByRenderKey
    return stableItems
  }, [items])
}
