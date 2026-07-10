import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  AssistantToolMessageGroup,
  ChatUserMessage,
} from '../../types/chat'

const INITIAL_WINDOW_TURNS = 6
const PAGE_TURNS = 6
const MAX_WINDOW_TURNS = 12

export type GroupedChatMessage = ChatUserMessage | AssistantToolMessageGroup

type TurnRange = {
  startIndex: number
  endIndex: number
}

export type ChatHistoryWindow = {
  startTurnIndex: number
  endTurnIndex: number
}

type UserMessageTurnIndex = {
  messageId: string
  turnIndex: number
}

export function createChatHistoryWindowSelector() {
  let previousMessages: GroupedChatMessage[] | null = null
  let previousStartIndex = -1
  let previousEndIndex = -1
  let previousResult: GroupedChatMessage[] = []

  return (
    groupedChatMessages: GroupedChatMessage[],
    startIndex: number,
    endIndex: number,
  ): GroupedChatMessage[] => {
    if (
      previousMessages === groupedChatMessages &&
      previousStartIndex === startIndex &&
      previousEndIndex === endIndex
    ) {
      return previousResult
    }

    previousMessages = groupedChatMessages
    previousStartIndex = startIndex
    previousEndIndex = endIndex
    previousResult =
      startIndex >= 0 && endIndex >= 0
        ? groupedChatMessages.slice(startIndex, endIndex + 1)
        : []
    return previousResult
  }
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

export function getNavigationWindowForTurn(
  targetTurnIndex: number,
  totalTurns: number,
): ChatHistoryWindow {
  if (totalTurns === 0) {
    return getLatestWindow(totalTurns)
  }

  const safeTargetTurnIndex = Math.min(
    Math.max(targetTurnIndex, 0),
    totalTurns - 1,
  )
  const maxStartTurnIndex = Math.max(0, totalTurns - INITIAL_WINDOW_TURNS)
  const centeredStartTurnIndex =
    safeTargetTurnIndex - Math.floor(INITIAL_WINDOW_TURNS / 2)
  const startTurnIndex = Math.max(
    0,
    Math.min(centeredStartTurnIndex, maxStartTurnIndex),
  )

  return {
    startTurnIndex,
    endTurnIndex: Math.min(
      totalTurns - 1,
      startTurnIndex + INITIAL_WINDOW_TURNS - 1,
    ),
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

export function getWindowAfterTurnCountChange(
  currentWindow: ChatHistoryWindow,
  previousTotalTurns: number,
  totalTurns: number,
): ChatHistoryWindow {
  if (totalTurns === 0) {
    return getLatestWindow(totalTurns)
  }

  const normalizedWindow = normalizeWindow(currentWindow, totalTurns)
  const wasAtLatest =
    previousTotalTurns === 0 ||
    currentWindow.endTurnIndex >= previousTotalTurns - 1

  if (!wasAtLatest) {
    return normalizedWindow
  }

  const currentWindowTurns =
    currentWindow.endTurnIndex - currentWindow.startTurnIndex + 1
  const windowTurns = Math.min(
    totalTurns,
    Math.max(
      INITIAL_WINDOW_TURNS,
      Math.min(MAX_WINDOW_TURNS, currentWindowTurns),
    ),
  )
  const endTurnIndex = Math.max(0, totalTurns - 1)

  return {
    startTurnIndex: Math.max(0, endTurnIndex - windowTurns + 1),
    endTurnIndex,
  }
}

export function getEarlierWindow(
  currentWindow: ChatHistoryWindow,
  totalTurns: number,
): ChatHistoryWindow {
  if (totalTurns === 0 || currentWindow.startTurnIndex === 0) {
    return currentWindow
  }

  const startTurnIndex = Math.max(0, currentWindow.startTurnIndex - PAGE_TURNS)
  const endTurnIndex = Math.min(
    currentWindow.endTurnIndex,
    startTurnIndex + MAX_WINDOW_TURNS - 1,
  )

  return {
    startTurnIndex,
    endTurnIndex,
  }
}

export function getNewerWindow(
  currentWindow: ChatHistoryWindow,
  totalTurns: number,
): ChatHistoryWindow {
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
  const [windowNavigationTargetMessageId, setWindowNavigationTargetMessageId] =
    useState<string | null>(null)
  const previousConversationIdRef = useRef(conversationId)
  const previousTotalTurnsRef = useRef(totalTurns)
  const windowSelectorRef = useRef(createChatHistoryWindowSelector())

  useEffect(() => {
    const previousConversationId = previousConversationIdRef.current
    const previousTotalTurns = previousTotalTurnsRef.current
    previousConversationIdRef.current = conversationId
    previousTotalTurnsRef.current = totalTurns

    if (previousConversationId !== conversationId) {
      setWindow(getLatestWindow(totalTurns))
      setWindowNavigationTargetMessageId(null)
      return
    }

    setWindow((currentWindow) =>
      getWindowAfterTurnCountChange(
        currentWindow,
        previousTotalTurns,
        totalTurns,
      ),
    )
  }, [conversationId, totalTurns])

  const loadEarlier = useCallback(() => {
    setWindow((currentWindow) => getEarlierWindow(currentWindow, totalTurns))
  }, [totalTurns])

  const loadNewer = useCallback(() => {
    setWindow((currentWindow) => getNewerWindow(currentWindow, totalTurns))
  }, [totalTurns])

  const resetToLatest = useCallback(() => {
    setWindow(getLatestWindow(totalTurns))
    setWindowNavigationTargetMessageId(null)
  }, [totalTurns])

  const jumpToUserMessage = useCallback(
    (messageId: string) => {
      const target = userMessageTurnIndices.find(
        (entry) => entry.messageId === messageId,
      )
      if (!target) {
        return false
      }

      setWindow(getNavigationWindowForTurn(target.turnIndex, totalTurns))
      setWindowNavigationTargetMessageId(messageId)
      setWindowNavigationKey((currentKey) => currentKey + 1)
      return true
    },
    [totalTurns, userMessageTurnIndices],
  )

  const normalizedWindow = useMemo(
    () => normalizeWindow(window, totalTurns),
    [totalTurns, window],
  )
  const startRange = turnRanges[normalizedWindow.startTurnIndex]
  const endRange = turnRanges[normalizedWindow.endTurnIndex]
  const startMessageIndex = startRange?.startIndex ?? -1
  const endMessageIndex = endRange?.endIndex ?? -1
  const windowedGroupedChatMessages = windowSelectorRef.current(
    groupedChatMessages,
    startMessageIndex,
    endMessageIndex,
  )

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
    windowNavigationTargetMessageId,
  }
}
