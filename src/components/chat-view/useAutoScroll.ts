import { useCallback, useEffect, useRef, useState } from 'react'
import type { FollowOutput } from 'react-virtuoso'

const PROGRAMMATIC_SCROLL_LOCK_MS = 180
const USER_SCROLL_INTENT_WINDOW_MS = 280
const NEAR_BOTTOM_THRESHOLD = 24
const FOLLOW_MAX_FRAMES = 6
const FOLLOW_SETTLE_THRESHOLD_PX = 2

type UseAutoScrollProps = {
  scrollContainerRef: React.RefObject<HTMLElement>
  bottomAnchorRef?: React.RefObject<HTMLElement>
  isStreaming?: boolean
  contentFollowMode?: 'observer' | 'explicit'
}

export function useAutoScroll({
  scrollContainerRef,
  bottomAnchorRef,
  isStreaming = false,
  contentFollowMode = 'observer',
}: UseAutoScrollProps) {
  const scrollContainerElement = scrollContainerRef.current
  const bottomAnchorElement = bottomAnchorRef?.current ?? null
  const autoFollowRef = useRef(true)
  const [autoFollowState, setAutoFollowState] = useState(true)
  const programmaticScrollLockUntilRef = useRef<number>(0)
  const lastUserScrollIntentRef = useRef<number>(0)
  const lastObservedScrollTopRef = useRef<number>(0)
  const followFrameRef = useRef<number | null>(null)
  const followRemainingFramesRef = useRef<number>(0)
  const followForceRef = useRef(false)

  const markUserScrollIntent = useCallback(() => {
    lastUserScrollIntentRef.current = Date.now()
  }, [])

  const updateAutoFollow = useCallback((nextValue: boolean) => {
    autoFollowRef.current = nextValue
    setAutoFollowState((previousValue) =>
      previousValue === nextValue ? previousValue : nextValue,
    )
  }, [])

  const getDistanceToBottom = useCallback(() => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) {
      return 0
    }

    const bottomAnchor = bottomAnchorRef?.current
    if (bottomAnchor) {
      const anchorBottom = bottomAnchor.offsetTop + bottomAnchor.offsetHeight
      const viewportBottom =
        scrollContainer.scrollTop + scrollContainer.clientHeight
      return anchorBottom - viewportBottom
    }

    return (
      scrollContainer.scrollHeight -
      scrollContainer.scrollTop -
      scrollContainer.clientHeight
    )
  }, [bottomAnchorRef, scrollContainerRef])

  const isNearBottom = useCallback(() => {
    return getDistanceToBottom() <= NEAR_BOTTOM_THRESHOLD
  }, [getDistanceToBottom])

  const scrollToBottom = useCallback(() => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) {
      return
    }

    const bottomAnchor = bottomAnchorRef?.current
    const targetScrollTop = bottomAnchor
      ? Math.max(
          0,
          bottomAnchor.offsetTop +
            bottomAnchor.offsetHeight -
            scrollContainer.clientHeight,
        )
      : Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight)

    if (Math.abs(scrollContainer.scrollTop - targetScrollTop) > 1) {
      programmaticScrollLockUntilRef.current =
        Date.now() + PROGRAMMATIC_SCROLL_LOCK_MS
      scrollContainer.scrollTop = targetScrollTop
    }
  }, [bottomAnchorRef, scrollContainerRef])

  const scheduleFollowFrame = useCallback(() => {
    if (followFrameRef.current !== null) {
      return
    }

    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = null
      const shouldFollow = followForceRef.current || autoFollowRef.current
      if (!shouldFollow) {
        followRemainingFramesRef.current = 0
        followForceRef.current = false
        return
      }

      scrollToBottom()
      const settled =
        Math.abs(getDistanceToBottom()) <= FOLLOW_SETTLE_THRESHOLD_PX
      if (settled) {
        followRemainingFramesRef.current = 0
        followForceRef.current = false
        return
      }

      if (followRemainingFramesRef.current > 0) {
        followRemainingFramesRef.current -= 1
        scheduleFollowFrame()
        return
      }

      followForceRef.current = false
    })
  }, [getDistanceToBottom, scrollToBottom])

  const requestFollow = useCallback(
    (options?: { force?: boolean }) => {
      const force = options?.force ?? false
      if (!force && !autoFollowRef.current) {
        return
      }

      followForceRef.current = followForceRef.current || force
      followRemainingFramesRef.current = Math.max(
        followRemainingFramesRef.current,
        FOLLOW_MAX_FRAMES,
      )
      scheduleFollowFrame()
    },
    [scheduleFollowFrame],
  )

  const syncFollowToBottom = useCallback(
    (options?: { force?: boolean }) => {
      const force = options?.force ?? false
      if (!force && !autoFollowRef.current) {
        return
      }

      scrollToBottom()

      if (Math.abs(getDistanceToBottom()) <= FOLLOW_SETTLE_THRESHOLD_PX) {
        followRemainingFramesRef.current = 0
        if (!force) {
          followForceRef.current = false
        }
        return
      }

      requestFollow({ force })
    },
    [getDistanceToBottom, requestFollow, scrollToBottom],
  )

  const handleAtBottomStateChange = useCallback(
    (atBottom: boolean) => {
      if (atBottom) {
        updateAutoFollow(true)
        return
      }

      const hasRecentUserScrollIntent =
        Date.now() - lastUserScrollIntentRef.current <
        USER_SCROLL_INTENT_WINDOW_MS
      if (hasRecentUserScrollIntent) {
        updateAutoFollow(false)
      }
    },
    [updateAutoFollow],
  )

  const followOutput: FollowOutput = useCallback((isAtBottom: boolean) => {
    if (followForceRef.current) {
      return 'auto'
    }

    return autoFollowRef.current || isAtBottom ? 'auto' : false
  }, [])

  useEffect(() => {
    if (!scrollContainerElement) return

    lastObservedScrollTopRef.current = scrollContainerElement.scrollTop

    const handleScroll = () => {
      const currentScrollTop = scrollContainerElement.scrollTop
      const scrolledUp = currentScrollTop < lastObservedScrollTopRef.current
      lastObservedScrollTopRef.current = currentScrollTop
      const hasRecentUserScrollIntent =
        Date.now() - lastUserScrollIntentRef.current <
        USER_SCROLL_INTENT_WINDOW_MS

      if (
        Date.now() < programmaticScrollLockUntilRef.current &&
        !hasRecentUserScrollIntent
      ) {
        return
      }

      if (!hasRecentUserScrollIntent) {
        return
      }

      const nearBottom = isNearBottom()
      if (scrolledUp) {
        updateAutoFollow(false)
        return
      }

      if (nearBottom) {
        updateAutoFollow(true)
      }
    }

    scrollContainerElement.addEventListener('wheel', markUserScrollIntent, {
      passive: true,
    })
    scrollContainerElement.addEventListener('touchmove', markUserScrollIntent, {
      passive: true,
    })
    scrollContainerElement.addEventListener('pointerdown', markUserScrollIntent)
    scrollContainerElement.addEventListener('scroll', handleScroll)
    return () => {
      scrollContainerElement.removeEventListener('wheel', markUserScrollIntent)
      scrollContainerElement.removeEventListener(
        'touchmove',
        markUserScrollIntent,
      )
      scrollContainerElement.removeEventListener(
        'pointerdown',
        markUserScrollIntent,
      )
      scrollContainerElement.removeEventListener('scroll', handleScroll)
    }
  }, [
    isNearBottom,
    markUserScrollIntent,
    scrollContainerElement,
    updateAutoFollow,
  ])

  useEffect(() => {
    if (
      contentFollowMode !== 'observer' ||
      !isStreaming ||
      !autoFollowState ||
      !scrollContainerElement
    ) {
      return
    }

    requestFollow()
  }, [
    autoFollowState,
    contentFollowMode,
    isStreaming,
    requestFollow,
    scrollContainerElement,
  ])

  useEffect(() => {
    if (
      contentFollowMode !== 'observer' ||
      !scrollContainerElement ||
      typeof MutationObserver === 'undefined'
    ) {
      return
    }

    const observer = new MutationObserver(() => {
      syncFollowToBottom()
    })

    observer.observe(scrollContainerElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'aria-expanded'],
    })

    const handleAnimatedLayoutChange = () => {
      syncFollowToBottom()
    }

    scrollContainerElement.addEventListener(
      'transitionend',
      handleAnimatedLayoutChange,
    )
    scrollContainerElement.addEventListener(
      'animationend',
      handleAnimatedLayoutChange,
    )

    return () => {
      observer.disconnect()
      scrollContainerElement.removeEventListener(
        'transitionend',
        handleAnimatedLayoutChange,
      )
      scrollContainerElement.removeEventListener(
        'animationend',
        handleAnimatedLayoutChange,
      )
    }
  }, [contentFollowMode, scrollContainerElement, syncFollowToBottom])

  useEffect(() => {
    if (
      !scrollContainerElement ||
      !bottomAnchorElement ||
      typeof IntersectionObserver === 'undefined'
    ) {
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        const hasRecentUserScrollIntent =
          Date.now() - lastUserScrollIntentRef.current <
          USER_SCROLL_INTENT_WINDOW_MS

        if (
          entry.isIntersecting &&
          !autoFollowRef.current &&
          hasRecentUserScrollIntent
        ) {
          updateAutoFollow(true)
          return
        }

        if (!entry.isIntersecting && autoFollowRef.current) {
          requestFollow()
        }
      },
      {
        root: scrollContainerElement,
        threshold: 1,
      },
    )

    observer.observe(bottomAnchorElement)

    return () => {
      observer.disconnect()
    }
  }, [
    bottomAnchorElement,
    requestFollow,
    scrollContainerElement,
    updateAutoFollow,
  ])

  useEffect(() => {
    return () => {
      if (followFrameRef.current !== null) {
        cancelAnimationFrame(followFrameRef.current)
        followFrameRef.current = null
      }
      followRemainingFramesRef.current = 0
      followForceRef.current = false
    }
  }, [])

  // Auto-scrolls to bottom only if the scroll position is near the bottom
  const autoScrollToBottom = useCallback(() => {
    requestFollow()
  }, [requestFollow])

  const notifyContentFlushed = useCallback(() => {
    syncFollowToBottom()
  }, [syncFollowToBottom])

  // Forces scroll to bottom regardless of current position
  const forceScrollToBottom = useCallback(() => {
    updateAutoFollow(true)
    syncFollowToBottom({ force: true })
  }, [syncFollowToBottom, updateAutoFollow])

  return {
    autoScrollToBottom,
    notifyContentFlushed,
    forceScrollToBottom,
    isAutoFollowEnabled: autoFollowState,
    followOutput,
    onAtBottomStateChange: handleAtBottomStateChange,
  }
}
