import { useCallback, useEffect, useRef } from 'react'

import { ChatMessage } from '../types/chat'

const MIN_STREAM_FLUSH_INTERVAL_MS = 16
const FAST_STREAM_FLUSH_INTERVAL_MS = 24
const BALANCED_STREAM_FLUSH_INTERVAL_MS = 32
const IDLE_STREAM_FLUSH_INTERVAL_MS = 40

function getNowMs(): number {
  if (typeof performance !== 'undefined') {
    return performance.now()
  }

  return Date.now()
}

function getAssistantVisibleTextLength(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => {
    if (message.role !== 'assistant') {
      return total
    }

    return total + message.content.length + (message.reasoning?.length ?? 0)
  }, 0)
}

function hasStreamingAssistantMessage(messages: ChatMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.metadata?.generationState === 'streaming',
  )
}

function getStreamFlushInterval(charsPerSecond: number): number {
  if (charsPerSecond >= 220) {
    return MIN_STREAM_FLUSH_INTERVAL_MS
  }

  if (charsPerSecond >= 120) {
    return FAST_STREAM_FLUSH_INTERVAL_MS
  }

  if (charsPerSecond >= 48) {
    return BALANCED_STREAM_FLUSH_INTERVAL_MS
  }

  return IDLE_STREAM_FLUSH_INTERVAL_MS
}

export const reconcileAssistantGenerationState = (
  previousMessages: ChatMessage[],
  nextMessages: ChatMessage[],
): ChatMessage[] => {
  const previousAssistantStateMap = new Map(
    previousMessages
      .filter((message) => message.role === 'assistant')
      .map((message) => [message.id, message.metadata?.generationState]),
  )

  return nextMessages.map((message) => {
    if (message.role !== 'assistant') {
      return message
    }

    const previousGenerationState = previousAssistantStateMap.get(message.id)
    if (
      previousGenerationState === 'aborted' &&
      message.metadata?.generationState === 'streaming'
    ) {
      return {
        ...message,
        metadata: {
          ...message.metadata,
          generationState: 'aborted',
        },
      }
    }

    return message
  })
}

export function mergeRunnerMessagesFromAnchor(
  baseMessages: ChatMessage[],
  anchorMessageId: string,
  responseMessages: ChatMessage[],
): ChatMessage[] | null {
  const anchorIndex = baseMessages.findIndex(
    (message) => message.id === anchorMessageId,
  )
  if (anchorIndex === -1) {
    return null
  }

  const responseAnchorIndex = responseMessages.findIndex(
    (message) => message.id === anchorMessageId,
  )
  const mergedMessages =
    responseAnchorIndex === -1
      ? [...baseMessages.slice(0, anchorIndex + 1), ...responseMessages]
      : [
          ...baseMessages.slice(0, anchorIndex),
          ...responseMessages.slice(responseAnchorIndex),
        ]

  return reconcileAssistantGenerationState(baseMessages, [
    ...mergedMessages,
  ])
}

type UseBufferedRunnerMessagesParams = {
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
  autoScrollToBottom?: () => void
}

type QueueBufferedRunnerMessagesParams = {
  responseMessages: ChatMessage[]
  anchorMessageId: string
  abortController?: AbortController | null
}

export function useBufferedRunnerMessages({
  setChatMessages,
  autoScrollToBottom,
}: UseBufferedRunnerMessagesParams) {
  const latestMessagesRef = useRef<ChatMessage[]>([])
  const pendingRunnerMessagesRef = useRef<ChatMessage[] | null>(null)
  const pendingAnchorMessageIdRef = useRef<string | null>(null)
  const pendingAbortControllerRef = useRef<AbortController | null>(null)
  const streamFlushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const streamFlushRafRef = useRef<number | null>(null)
  const lastFlushAtRef = useRef(0)
  const smoothedCharsPerSecondRef = useRef(0)
  const lastObservedRunnerSnapshotRef = useRef({ at: 0, textLength: 0 })

  const resetBufferedRunnerMessages = useCallback(() => {
    pendingRunnerMessagesRef.current = null
    pendingAnchorMessageIdRef.current = null
    pendingAbortControllerRef.current = null
    lastFlushAtRef.current = 0
    smoothedCharsPerSecondRef.current = 0
    lastObservedRunnerSnapshotRef.current = { at: 0, textLength: 0 }
  }, [])

  const cancelBufferedRunnerFlush = useCallback(() => {
    if (streamFlushTimeoutRef.current) {
      clearTimeout(streamFlushTimeoutRef.current)
      streamFlushTimeoutRef.current = null
    }

    if (streamFlushRafRef.current !== null) {
      cancelAnimationFrame(streamFlushRafRef.current)
      streamFlushRafRef.current = null
    }
  }, [])

  const flushBufferedRunnerMessages = useCallback(() => {
    const responseMessages = pendingRunnerMessagesRef.current
    const anchorMessageId = pendingAnchorMessageIdRef.current
    if (!responseMessages || !anchorMessageId) {
      return latestMessagesRef.current
    }

    pendingRunnerMessagesRef.current = null
    pendingAnchorMessageIdRef.current = null
    pendingAbortControllerRef.current = null
    lastFlushAtRef.current = getNowMs()

    const nextMessages = mergeRunnerMessagesFromAnchor(
      latestMessagesRef.current,
      anchorMessageId,
      responseMessages,
    )

    if (!nextMessages) {
      return latestMessagesRef.current
    }

    latestMessagesRef.current = nextMessages
    setChatMessages(nextMessages)

    if (!hasStreamingAssistantMessage(responseMessages)) {
      requestAnimationFrame(() => {
        autoScrollToBottom?.()
        requestAnimationFrame(() => {
          autoScrollToBottom?.()
        })
      })
    }

    return nextMessages
  }, [autoScrollToBottom, setChatMessages])

  const scheduleBufferedRunnerFlush = useCallback(
    (options?: { immediate?: boolean }) => {
      const immediate = options?.immediate ?? false
      cancelBufferedRunnerFlush()

      const requestFlush = () => {
        streamFlushRafRef.current = requestAnimationFrame(() => {
          streamFlushRafRef.current = null
          flushBufferedRunnerMessages()
        })
      }

      if (immediate) {
        flushBufferedRunnerMessages()
        return
      }

      const now = getNowMs()
      const targetInterval = getStreamFlushInterval(
        smoothedCharsPerSecondRef.current,
      )
      const elapsedSinceLastFlush = lastFlushAtRef.current
        ? now - lastFlushAtRef.current
        : targetInterval
      const waitMs = Math.max(0, targetInterval - elapsedSinceLastFlush)

      if (waitMs === 0) {
        requestFlush()
        return
      }

      streamFlushTimeoutRef.current = setTimeout(() => {
        streamFlushTimeoutRef.current = null
        requestFlush()
      }, waitMs)
    },
    [cancelBufferedRunnerFlush, flushBufferedRunnerMessages],
  )

  useEffect(() => {
    return () => {
      cancelBufferedRunnerFlush()
      resetBufferedRunnerMessages()
    }
  }, [cancelBufferedRunnerFlush, resetBufferedRunnerMessages])

  const beginBufferedRunnerSession = useCallback(
    (baseMessages: ChatMessage[]) => {
      cancelBufferedRunnerFlush()
      resetBufferedRunnerMessages()
      latestMessagesRef.current = baseMessages
    },
    [cancelBufferedRunnerFlush, resetBufferedRunnerMessages],
  )

  const queueBufferedRunnerMessages = useCallback(
    ({
      responseMessages,
      anchorMessageId,
      abortController,
    }: QueueBufferedRunnerMessagesParams) => {
      const now = getNowMs()
      const nextVisibleTextLength =
        getAssistantVisibleTextLength(responseMessages)
      const previousSnapshot = lastObservedRunnerSnapshotRef.current
      const textDelta = nextVisibleTextLength - previousSnapshot.textLength
      const timeDelta = now - previousSnapshot.at

      if (textDelta > 0 && timeDelta > 0) {
        const instantaneousCharsPerSecond = (textDelta * 1000) / timeDelta
        smoothedCharsPerSecondRef.current = smoothedCharsPerSecondRef.current
          ? smoothedCharsPerSecondRef.current * 0.65 +
            instantaneousCharsPerSecond * 0.35
          : instantaneousCharsPerSecond
      }

      lastObservedRunnerSnapshotRef.current = {
        at: now,
        textLength: nextVisibleTextLength,
      }
      pendingRunnerMessagesRef.current = responseMessages
      pendingAnchorMessageIdRef.current = anchorMessageId
      pendingAbortControllerRef.current = abortController ?? null

      const shouldImmediateFlush =
        !hasStreamingAssistantMessage(responseMessages) &&
        responseMessages.at(-1)?.role === 'assistant'

      scheduleBufferedRunnerFlush({ immediate: shouldImmediateFlush })
    },
    [scheduleBufferedRunnerFlush],
  )

  const abortBufferedRunnerSession = useCallback(() => {
    cancelBufferedRunnerFlush()
    resetBufferedRunnerMessages()
    setChatMessages((prevChatMessages) => {
      let hasUpdates = false
      const nextChatMessages = prevChatMessages.map((message) => {
        if (
          message.role !== 'assistant' ||
          message.metadata?.generationState !== 'streaming'
        ) {
          return message
        }

        hasUpdates = true
        return {
          ...message,
          metadata: {
            ...message.metadata,
            generationState: 'aborted' as const,
          },
        }
      })

      if (hasUpdates) {
        latestMessagesRef.current = nextChatMessages
      }

      return hasUpdates ? nextChatMessages : prevChatMessages
    })
  }, [cancelBufferedRunnerFlush, resetBufferedRunnerMessages, setChatMessages])

  const getLatestBufferedMessages = useCallback(() => {
    return latestMessagesRef.current
  }, [])

  return {
    beginBufferedRunnerSession,
    queueBufferedRunnerMessages,
    flushBufferedRunnerMessages,
    cancelBufferedRunnerFlush,
    resetBufferedRunnerMessages,
    abortBufferedRunnerSession,
    getLatestBufferedMessages,
  }
}
