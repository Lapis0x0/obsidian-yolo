import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  AssistantToolMessageGroup,
  ChatUserMessage,
} from '../../types/chat'

const INITIAL_WINDOW_TURNS = 10
const PAGE_TURNS = 8
const MAX_WINDOW_TURNS = 40

type GroupedChatMessage = ChatUserMessage | AssistantToolMessageGroup

type TurnRange = {
  startIndex: number
  endIndex: number
}

type ChatHistoryWindow = {
  startTurnIndex: number
  endTurnIndex: number
}

type UserMessageTurnIndex = {
  messageId: string
  turnIndex: number
}

function buildTurnRanges(
  groupedChatMessages: GroupedChatMessage[],
): TurnRange[] {
  if (groupedChatMessages.length === 0) {
    return []
  }

  const ranges: TurnRange[] = []
  let currentStartIndex = 0
  let hasUserTurn = false

  groupedChatMessages.forEach((messageOrGroup, index) => {
    if (Array.isArray(messageOrGroup)) {
      return
    }

    if (hasUserTurn) {
      ranges.push({
        startIndex: currentStartIndex,
        endIndex: index - 1,
      })
    } else if (index > 0) {
      ranges.push({
        startIndex: 0,
        endIndex: index - 1,
      })
    }

    currentStartIndex = index
    hasUserTurn = true
  })

  ranges.push({
    startIndex: hasUserTurn ? currentStartIndex : 0,
    endIndex: groupedChatMessages.length - 1,
  })

  return ranges
}

function buildUserMessageTurnIndices(
  groupedChatMessages: GroupedChatMessage[],
): UserMessageTurnIndex[] {
  const indices: UserMessageTurnIndex[] = []

  groupedChatMessages.forEach((messageOrGroup) => {
    if (Array.isArray(messageOrGroup)) {
      return
    }

    indices.push({
      messageId: messageOrGroup.id,
      turnIndex: indices.length,
    })
  })

  return indices
}

function getLatestWindow(totalTurns: number): ChatHistoryWindow {
  if (totalTurns === 0) {
    return {
      startTurnIndex: 0,
      endTurnIndex: -1,
    }
  }

  return {
    startTurnIndex: Math.max(0, totalTurns - INITIAL_WINDOW_TURNS),
    endTurnIndex: totalTurns - 1,
  }
}

function normalizeWindow(
  window: ChatHistoryWindow,
  totalTurns: number,
): ChatHistoryWindow {
  if (totalTurns === 0) {
    return getLatestWindow(totalTurns)
  }

  const endTurnIndex = Math.min(
    Math.max(window.endTurnIndex, 0),
    totalTurns - 1,
  )
  const startTurnIndex = Math.min(
    Math.max(window.startTurnIndex, 0),
    endTurnIndex,
  )

  return {
    startTurnIndex,
    endTurnIndex,
  }
}

export function useChatHistoryWindow({
  conversationId,
  groupedChatMessages,
}: {
  conversationId: string
  groupedChatMessages: GroupedChatMessage[]
}) {
  const turnRanges = useMemo(
    () => buildTurnRanges(groupedChatMessages),
    [groupedChatMessages],
  )
  const userMessageTurnIndices = useMemo(
    () => buildUserMessageTurnIndices(groupedChatMessages),
    [groupedChatMessages],
  )
  const totalTurns = turnRanges.length
  const [window, setWindow] = useState<ChatHistoryWindow>(() =>
    getLatestWindow(totalTurns),
  )
  const [windowNavigationKey, setWindowNavigationKey] = useState(0)
  const previousConversationIdRef = useRef(conversationId)
  const previousTotalTurnsRef = useRef(totalTurns)

  useEffect(() => {
    const previousConversationId = previousConversationIdRef.current
    const previousTotalTurns = previousTotalTurnsRef.current
    previousConversationIdRef.current = conversationId
    previousTotalTurnsRef.current = totalTurns

    if (previousConversationId !== conversationId) {
      setWindow(getLatestWindow(totalTurns))
      return
    }

    setWindow((currentWindow) => {
      const normalizedWindow = normalizeWindow(currentWindow, totalTurns)
      const wasAtLatest =
        previousTotalTurns === 0 ||
        currentWindow.endTurnIndex >= previousTotalTurns - 1

      if (!wasAtLatest) {
        return normalizedWindow
      }

      return {
        startTurnIndex: normalizedWindow.startTurnIndex,
        endTurnIndex: Math.max(0, totalTurns - 1),
      }
    })
  }, [conversationId, totalTurns])

  const loadEarlier = useCallback(() => {
    setWindow((currentWindow) => {
      if (totalTurns === 0 || currentWindow.startTurnIndex === 0) {
        return currentWindow
      }

      const startTurnIndex = Math.max(
        0,
        currentWindow.startTurnIndex - PAGE_TURNS,
      )
      const endTurnIndex = Math.min(
        currentWindow.endTurnIndex,
        startTurnIndex + MAX_WINDOW_TURNS - 1,
      )

      return {
        startTurnIndex,
        endTurnIndex,
      }
    })
  }, [totalTurns])

  const loadNewer = useCallback(() => {
    setWindow((currentWindow) => {
      if (totalTurns === 0 || currentWindow.endTurnIndex >= totalTurns - 1) {
        return currentWindow
      }

      const endTurnIndex = Math.min(
        totalTurns - 1,
        currentWindow.endTurnIndex + PAGE_TURNS,
      )
      const startTurnIndex = Math.max(0, endTurnIndex - MAX_WINDOW_TURNS + 1)

      return {
        startTurnIndex,
        endTurnIndex,
      }
    })
  }, [totalTurns])

  const resetToLatest = useCallback(() => {
    setWindow(getLatestWindow(totalTurns))
  }, [totalTurns])

  const jumpToUserMessage = useCallback(
    (messageId: string) => {
      const target = userMessageTurnIndices.find(
        (entry) => entry.messageId === messageId,
      )
      if (!target) {
        return false
      }

      setWindow({
        startTurnIndex: target.turnIndex,
        endTurnIndex: Math.min(
          totalTurns - 1,
          target.turnIndex + INITIAL_WINDOW_TURNS - 1,
        ),
      })
      setWindowNavigationKey((currentKey) => currentKey + 1)
      return true
    },
    [totalTurns, userMessageTurnIndices],
  )

  const normalizedWindow = normalizeWindow(window, totalTurns)
  const startRange = turnRanges[normalizedWindow.startTurnIndex]
  const endRange = turnRanges[normalizedWindow.endTurnIndex]
  const windowedGroupedChatMessages =
    startRange && endRange
      ? groupedChatMessages.slice(startRange.startIndex, endRange.endIndex + 1)
      : []

  return {
    windowedGroupedChatMessages,
    hasEarlierMessages: normalizedWindow.startTurnIndex > 0,
    hasNewerMessages:
      totalTurns > 0 && normalizedWindow.endTurnIndex < totalTurns - 1,
    loadEarlier,
    loadNewer,
    resetToLatest,
    jumpToUserMessage,
    windowNavigationKey,
  }
}
