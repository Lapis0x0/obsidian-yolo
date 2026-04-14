import { useCallback, useEffect, useRef, useState } from 'react'
import type { FollowOutput } from 'react-virtuoso'

const PROGRAMMATIC_SCROLL_LOCK_MS = 180
const USER_SCROLL_INTENT_WINDOW_MS = 280
const NEAR_BOTTOM_THRESHOLD = 24
const REATTACH_BOTTOM_THRESHOLD = 96
const FOLLOW_MAX_FRAMES = 6
const FOLLOW_SETTLE_THRESHOLD_PX = 2

type UseAutoScrollProps = {
  scrollContainerRef: React.RefObject<HTMLElement>
  scrollContainerElement?: HTMLElement | null
  bottomAnchorRef?: React.RefObject<HTMLElement>
  isStreaming?: boolean
  contentFollowMode?: 'observer' | 'explicit'
  /**
   * When true (observer mode only): do not follow on DOM MutationObserver / bottom-anchor
   * IntersectionObserver — caller must invoke `autoScrollToBottom()` from useLayoutEffect on
   * each streaming React commit. Avoids duplicate follow sources that cause scrollbar jitter
   * in surfaces like Quick Ask where both fired on every token.
   */
  followFromReactCommitsOnly?: boolean
}

export function useAutoScroll({
  scrollContainerRef,
  scrollContainerElement: scrollContainerElementOverride,
  bottomAnchorRef,
  isStreaming = false,
  contentFollowMode = 'observer',
  followFromReactCommitsOnly = false,
}: UseAutoScrollProps) {
  const scrollContainerElement =
    scrollContainerElementOverride ?? scrollContainerRef.current
  const bottomAnchorElement = bottomAnchorRef?.current ?? null
  const autoFollowRef = useRef(true)
  const [autoFollowState, setAutoFollowState] = useState(true)
  const programmaticScrollLockUntilRef = useRef<number>(0)
  const lastUserScrollIntentRef = useRef<number>(0)
  const lastObservedScrollTopRef = useRef<number>(0)
  const lastTouchYRef = useRef<number | null>(null)
  const followFrameRef = useRef<number | null>(null)
  const followRemainingFramesRef = useRef<number>(0)
  const followForceRef = useRef(false)

  const getScrollContainer = useCallback(() => {
    return scrollContainerElementOverride ?? scrollContainerRef.current
  }, [scrollContainerElementOverride, scrollContainerRef])

  const markUserScrollIntent = useCallback(() => {
    lastUserScrollIntentRef.current = Date.now()
  }, [])

  const hasRecentUserScrollIntent = useCallback(() => {
    return (
      Date.now() - lastUserScrollIntentRef.current <
      USER_SCROLL_INTENT_WINDOW_MS
    )
  }, [])

  const updateAutoFollow = useCallback((nextValue: boolean) => {
    autoFollowRef.current = nextValue
    setAutoFollowState((previousValue) =>
      previousValue === nextValue ? previousValue : nextValue,
    )
  }, [])

  const stopAutoFollow = useCallback(() => {
    programmaticScrollLockUntilRef.current = 0
    if (followFrameRef.current !== null) {
      cancelAnimationFrame(followFrameRef.current)
      followFrameRef.current = null
    }
    followRemainingFramesRef.current = 0
    followForceRef.current = false
    updateAutoFollow(false)
  }, [updateAutoFollow])

  const getDistanceToBottom = useCallback(() => {
    const scrollContainer = getScrollContainer()
    if (!scrollContainer) {
      return 0
    }

    return (
      scrollContainer.scrollHeight -
      scrollContainer.scrollTop -
      scrollContainer.clientHeight
    )
  }, [getScrollContainer])

  const isNearBottom = useCallback(() => {
    return getDistanceToBottom() <= NEAR_BOTTOM_THRESHOLD
  }, [getDistanceToBottom])

  const scrollToBottom = useCallback(() => {
    const scrollContainer = getScrollContainer()
    if (!scrollContainer) {
      return
    }

    const targetScrollTop = Math.max(
      0,
      scrollContainer.scrollHeight - scrollContainer.clientHeight,
    )

    if (Math.abs(scrollContainer.scrollTop - targetScrollTop) > 1) {
      programmaticScrollLockUntilRef.current =
        Date.now() + PROGRAMMATIC_SCROLL_LOCK_MS
      scrollContainer.scrollTop = targetScrollTop
    }
  }, [getScrollContainer])

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
        requestFollow()
        return
      }

      if (hasRecentUserScrollIntent()) {
        updateAutoFollow(false)
      }
    },
    [hasRecentUserScrollIntent, requestFollow, updateAutoFollow],
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
      const scrolledDown = currentScrollTop > lastObservedScrollTopRef.current
      lastObservedScrollTopRef.current = currentScrollTop

      const userIntent = hasRecentUserScrollIntent()
      const withinProgrammaticLock =
        Date.now() < programmaticScrollLockUntilRef.current
      // User scroll-up must always exit auto-follow, even during programmatic-scroll lock.
      // Streaming calls scrollToBottom every frame and resets the lock, which otherwise blocked
      // handleScroll from ever seeing "scrolled up" while the user tried to read above.
      if (userIntent && scrolledUp) {
        updateAutoFollow(false)
        return
      }

      if (withinProgrammaticLock) {
        return
      }

      if (!userIntent) {
        if (!scrolledDown || autoFollowRef.current) {
          return
        }
      }

      const distanceToBottom = getDistanceToBottom()
      const nearBottom = distanceToBottom <= NEAR_BOTTOM_THRESHOLD
      const withinReattachRange = distanceToBottom <= REATTACH_BOTTOM_THRESHOLD
      if (
        nearBottom ||
        (!autoFollowRef.current && scrolledDown && withinReattachRange)
      ) {
        updateAutoFollow(true)
        requestFollow()
      }
    }

    const handleWheel = (event: WheelEvent) => {
      markUserScrollIntent()
      if (event.deltaY < 0) {
        stopAutoFollow()
      }
    }

    const handleTouchStart = (event: TouchEvent) => {
      lastTouchYRef.current = event.touches[0]?.clientY ?? null
    }

    const handleTouchMove = (event: TouchEvent) => {
      markUserScrollIntent()
      const currentTouchY = event.touches[0]?.clientY ?? null
      if (currentTouchY === null) {
        lastTouchYRef.current = null
        return
      }

      const lastTouchY = lastTouchYRef.current
      lastTouchYRef.current = currentTouchY
      if (lastTouchY !== null && currentTouchY > lastTouchY) {
        stopAutoFollow()
      }
    }

    const resetTouchTracking = () => {
      lastTouchYRef.current = null
    }

    scrollContainerElement.addEventListener('wheel', handleWheel, {
      passive: true,
    })
    scrollContainerElement.addEventListener('touchstart', handleTouchStart, {
      passive: true,
    })
    scrollContainerElement.addEventListener('touchmove', handleTouchMove, {
      passive: true,
    })
    scrollContainerElement.addEventListener('touchend', resetTouchTracking, {
      passive: true,
    })
    scrollContainerElement.addEventListener('touchcancel', resetTouchTracking, {
      passive: true,
    })
    scrollContainerElement.addEventListener('pointerdown', markUserScrollIntent)
    scrollContainerElement.addEventListener('scroll', handleScroll)
    return () => {
      scrollContainerElement.removeEventListener('wheel', handleWheel)
      scrollContainerElement.removeEventListener('touchstart', handleTouchStart)
      scrollContainerElement.removeEventListener('touchmove', handleTouchMove)
      scrollContainerElement.removeEventListener('touchend', resetTouchTracking)
      scrollContainerElement.removeEventListener(
        'touchcancel',
        resetTouchTracking,
      )
      scrollContainerElement.removeEventListener(
        'pointerdown',
        markUserScrollIntent,
      )
      scrollContainerElement.removeEventListener('scroll', handleScroll)
    }
  }, [
    hasRecentUserScrollIntent,
    getDistanceToBottom,
    markUserScrollIntent,
    requestFollow,
    scrollContainerElement,
    stopAutoFollow,
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
    // Content-driven follow (DOM mutations + CSS transitions/animations) exists solely to
    // keep up with streaming output as it grows at the bottom. Outside of streaming these
    // signals pick up unrelated noise — Obsidian's async markdown rendering (embeds,
    // transclusions, MathJax, image loads), theme transitions, or even selection-induced
    // character-data changes — and would otherwise yank the user back to the bottom while
    // they read or try to select history. Gate the whole block on `isStreaming`.
    if (
      contentFollowMode !== 'observer' ||
      !isStreaming ||
      !scrollContainerElement
    ) {
      return
    }

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

    if (followFromReactCommitsOnly || typeof MutationObserver === 'undefined') {
      return () => {
        scrollContainerElement.removeEventListener(
          'transitionend',
          handleAnimatedLayoutChange,
        )
        scrollContainerElement.removeEventListener(
          'animationend',
          handleAnimatedLayoutChange,
        )
      }
    }

    const observer = new MutationObserver(() => {
      requestFollow()
    })

    observer.observe(scrollContainerElement, {
      childList: true,
      subtree: true,
      characterData: true,
    })

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
  }, [
    contentFollowMode,
    followFromReactCommitsOnly,
    isStreaming,
    requestFollow,
    scrollContainerElement,
    syncFollowToBottom,
  ])

  useEffect(() => {
    if (followFromReactCommitsOnly) {
      return
    }

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
        const hasRecentIntent =
          Date.now() - lastUserScrollIntentRef.current <
          USER_SCROLL_INTENT_WINDOW_MS

        if (entry.isIntersecting && !autoFollowRef.current && hasRecentIntent) {
          updateAutoFollow(true)
          return
        }

        if (!entry.isIntersecting && autoFollowRef.current) {
          requestFollow()
        }
      },
      {
        root: scrollContainerElement,
        // threshold 1 + tiny bottom anchor caused subpixel flicker and follow thrash; any visibility is enough
        threshold: 0,
      },
    )

    observer.observe(bottomAnchorElement)

    return () => {
      observer.disconnect()
    }
  }, [
    bottomAnchorElement,
    followFromReactCommitsOnly,
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
