import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

const AT_BOTTOM_THRESHOLD_PX = 24
const SCROLL_POSITION_EPSILON_PX = 1
const TOUCH_DIRECTION_THRESHOLD_PX = 4
const SCROLL_SESSION_END_DELAY_MS = 160

type UseAutoScrollProps = {
  scrollContainerRef: React.RefObject<HTMLElement>
  scrollContainerElement?: HTMLElement | null
  bottomSentinelElement?: HTMLElement | null
  followKey?: string
  canFollowLiveEdge?: boolean
}

type ScheduledFrame = {
  window: Window
  id: number
}

type ScrollDirection = 'up' | 'down'

export const resolveTouchScrollDirection = (
  previousClientY: number,
  currentClientY: number,
  currentDirection: ScrollDirection | null,
): ScrollDirection | null => {
  if (currentClientY > previousClientY + TOUCH_DIRECTION_THRESHOLD_PX) {
    return 'up'
  }

  if (currentClientY < previousClientY - TOUCH_DIRECTION_THRESHOLD_PX) {
    return 'down'
  }

  return currentDirection
}

type ScrollTransitionInput = {
  isFollowing: boolean
  previousScrollTop: number
  currentScrollTop: number
  distanceToBottom: number
  allowDetach: boolean
  allowReattach: boolean
}

export const resolveAutoFollowFromScroll = ({
  isFollowing,
  previousScrollTop,
  currentScrollTop,
  distanceToBottom,
  allowDetach,
  allowReattach,
}: ScrollTransitionInput): boolean => {
  if (
    allowDetach &&
    currentScrollTop < previousScrollTop - SCROLL_POSITION_EPSILON_PX
  ) {
    return false
  }

  if (
    allowReattach &&
    currentScrollTop > previousScrollTop + SCROLL_POSITION_EPSILON_PX &&
    distanceToBottom <= AT_BOTTOM_THRESHOLD_PX
  ) {
    return true
  }

  return isFollowing
}

const isEditableTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null
  if (!element || typeof element.closest !== 'function') {
    return false
  }

  return (
    element.isContentEditable ||
    element.closest('input, textarea, select, [contenteditable="true"]') !==
      null
  )
}

export function useAutoScroll({
  scrollContainerRef,
  scrollContainerElement: scrollContainerElementOverride,
  bottomSentinelElement,
  followKey,
  canFollowLiveEdge = true,
}: UseAutoScrollProps) {
  const scrollContainerElement =
    scrollContainerElementOverride ?? scrollContainerRef.current
  const autoFollowRef = useRef(true)
  const canFollowLiveEdgeRef = useRef(canFollowLiveEdge)
  canFollowLiveEdgeRef.current = canFollowLiveEdge
  const [autoFollowState, setAutoFollowState] = useState(true)
  const lastObservedScrollTopRef = useRef(0)
  const followFrameRef = useRef<ScheduledFrame | null>(null)
  const scrollIntentFrameRef = useRef<ScheduledFrame | null>(null)
  const scrollIntentRef = useRef<ScrollDirection | null>(null)
  const pointerDownRef = useRef(false)
  const touchActiveRef = useRef(false)
  const lastTouchClientYRef = useRef<number | null>(null)
  const scrollSessionDirectionRef = useRef<ScrollDirection | null>(null)
  const scrollSessionEndTimerRef = useRef<ScheduledFrame | null>(null)

  const getScrollContainer = useCallback(() => {
    return scrollContainerElementOverride ?? scrollContainerRef.current
  }, [scrollContainerElementOverride, scrollContainerRef])

  const updateAutoFollow = useCallback((nextValue: boolean) => {
    autoFollowRef.current = nextValue
    setAutoFollowState((previousValue) =>
      previousValue === nextValue ? previousValue : nextValue,
    )
  }, [])

  const cancelScheduledFollow = useCallback(() => {
    if (followFrameRef.current !== null) {
      followFrameRef.current.window.cancelAnimationFrame(
        followFrameRef.current.id,
      )
      followFrameRef.current = null
    }
  }, [])

  const clearScrollIntent = useCallback(() => {
    scrollIntentRef.current = null
    if (scrollIntentFrameRef.current !== null) {
      scrollIntentFrameRef.current.window.cancelAnimationFrame(
        scrollIntentFrameRef.current.id,
      )
      scrollIntentFrameRef.current = null
    }
  }, [])

  const clearScrollSessionDirection = useCallback(() => {
    scrollSessionDirectionRef.current = null
    if (scrollSessionEndTimerRef.current !== null) {
      scrollSessionEndTimerRef.current.window.clearTimeout(
        scrollSessionEndTimerRef.current.id,
      )
      scrollSessionEndTimerRef.current = null
    }
  }, [])

  const scheduleScrollSessionEnd = useCallback(() => {
    if (scrollSessionDirectionRef.current === null) {
      return
    }

    if (scrollSessionEndTimerRef.current !== null) {
      scrollSessionEndTimerRef.current.window.clearTimeout(
        scrollSessionEndTimerRef.current.id,
      )
    }

    const scrollContainer = getScrollContainer()
    const ownerWindow = scrollContainer?.ownerDocument.defaultView ?? window
    scrollSessionEndTimerRef.current = {
      window: ownerWindow,
      id: ownerWindow.setTimeout(() => {
        scrollSessionEndTimerRef.current = null
        scrollSessionDirectionRef.current = null
      }, SCROLL_SESSION_END_DELAY_MS),
    }
  }, [getScrollContainer])

  const markScrollIntent = useCallback(
    (direction: ScrollDirection) => {
      scrollIntentRef.current = direction
      if (scrollIntentFrameRef.current !== null) {
        return
      }

      const scrollContainer = getScrollContainer()
      const ownerWindow = scrollContainer?.ownerDocument.defaultView ?? window
      scrollIntentFrameRef.current = {
        window: ownerWindow,
        id: ownerWindow.requestAnimationFrame(() => {
          scrollIntentFrameRef.current = null
          scrollIntentRef.current = null
        }),
      }
    },
    [getScrollContainer],
  )

  const stopAutoFollow = useCallback(() => {
    cancelScheduledFollow()
    updateAutoFollow(false)
  }, [cancelScheduledFollow, updateAutoFollow])

  const scrollToBottom = useCallback(() => {
    const scrollContainer = getScrollContainer()
    if (!scrollContainer) {
      return
    }

    const targetScrollTop = Math.max(
      0,
      scrollContainer.scrollHeight - scrollContainer.clientHeight,
    )
    if (
      Math.abs(scrollContainer.scrollTop - targetScrollTop) <=
      SCROLL_POSITION_EPSILON_PX
    ) {
      lastObservedScrollTopRef.current = scrollContainer.scrollTop
      return
    }

    scrollContainer.scrollTop = targetScrollTop
    lastObservedScrollTopRef.current = scrollContainer.scrollTop
  }, [getScrollContainer])

  const scheduleFollow = useCallback(() => {
    if (
      !autoFollowRef.current ||
      !canFollowLiveEdgeRef.current ||
      followFrameRef.current !== null
    ) {
      return
    }

    const scrollContainer = getScrollContainer()
    const ownerWindow = scrollContainer?.ownerDocument.defaultView ?? window
    followFrameRef.current = {
      window: ownerWindow,
      id: ownerWindow.requestAnimationFrame(() => {
        followFrameRef.current = null
        if (autoFollowRef.current && canFollowLiveEdgeRef.current) {
          scrollToBottom()
        }
      }),
    }
  }, [getScrollContainer, scrollToBottom])

  const forceScrollToBottom = useCallback(() => {
    clearScrollIntent()
    clearScrollSessionDirection()
    updateAutoFollow(true)
    cancelScheduledFollow()
    scrollToBottom()
    scheduleFollow()
  }, [
    cancelScheduledFollow,
    clearScrollIntent,
    clearScrollSessionDirection,
    scheduleFollow,
    scrollToBottom,
    updateAutoFollow,
  ])

  useLayoutEffect(() => {
    if (!scrollContainerElement || !bottomSentinelElement) {
      return
    }

    updateAutoFollow(true)
    cancelScheduledFollow()
    if (canFollowLiveEdgeRef.current) {
      scrollToBottom()
    }
  }, [
    bottomSentinelElement,
    cancelScheduledFollow,
    followKey,
    scrollContainerElement,
    scrollToBottom,
    updateAutoFollow,
  ])

  useEffect(() => {
    if (!scrollContainerElement) {
      return
    }

    lastObservedScrollTopRef.current = scrollContainerElement.scrollTop

    const handleScroll = () => {
      const currentScrollTop = scrollContainerElement.scrollTop
      const previousScrollTop = lastObservedScrollTopRef.current
      lastObservedScrollTopRef.current = currentScrollTop

      const currentMaxScrollTop = Math.max(
        0,
        scrollContainerElement.scrollHeight -
          scrollContainerElement.clientHeight,
      )
      const distanceToBottom = currentMaxScrollTop - currentScrollTop
      const intent = scrollIntentRef.current
      const sessionDirection = scrollSessionDirectionRef.current
      const nextAutoFollow = resolveAutoFollowFromScroll({
        isFollowing: autoFollowRef.current,
        previousScrollTop,
        currentScrollTop,
        distanceToBottom,
        allowDetach:
          pointerDownRef.current ||
          sessionDirection === 'up' ||
          intent === 'up',
        allowReattach:
          canFollowLiveEdgeRef.current &&
          (pointerDownRef.current ||
            sessionDirection === 'down' ||
            intent === 'down'),
      })

      if (pointerDownRef.current || intent !== null) {
        scrollSessionDirectionRef.current =
          intent ??
          (currentScrollTop < previousScrollTop
            ? 'up'
            : currentScrollTop > previousScrollTop
              ? 'down'
              : scrollSessionDirectionRef.current)
      }

      if (
        !pointerDownRef.current &&
        !touchActiveRef.current &&
        scrollSessionDirectionRef.current !== null
      ) {
        scheduleScrollSessionEnd()
      }

      if (!nextAutoFollow) {
        stopAutoFollow()
        return
      }

      if (!autoFollowRef.current) {
        updateAutoFollow(true)
        scheduleFollow()
      }
    }

    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY !== 0) {
        markScrollIntent(event.deltaY < 0 ? 'up' : 'down')
      }
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch') {
        return
      }
      pointerDownRef.current = true
      clearScrollSessionDirection()
    }

    const handlePointerEnd = (event: PointerEvent) => {
      if (event.pointerType === 'touch') {
        return
      }
      pointerDownRef.current = false
      clearScrollIntent()
      scheduleScrollSessionEnd()
    }

    const handlePointerCancel = (event: PointerEvent) => {
      if (event.pointerType === 'touch') {
        return
      }
      pointerDownRef.current = false
      clearScrollIntent()
      scheduleScrollSessionEnd()
    }

    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!touch) {
        return
      }

      clearScrollSessionDirection()
      touchActiveRef.current = true
      lastTouchClientYRef.current = touch.clientY
    }

    const handleTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0]
      const previousClientY = lastTouchClientYRef.current
      if (!touch || previousClientY === null) {
        return
      }

      const nextDirection = resolveTouchScrollDirection(
        previousClientY,
        touch.clientY,
        scrollSessionDirectionRef.current,
      )
      if (nextDirection !== null) {
        lastTouchClientYRef.current = touch.clientY
      }
      scrollSessionDirectionRef.current = nextDirection

      if (nextDirection === 'up') {
        stopAutoFollow()
      }
    }

    const handleTouchEnd = () => {
      touchActiveRef.current = false
      lastTouchClientYRef.current = null
      scheduleScrollSessionEnd()
    }

    const handleScrollEnd = () => {
      if (!pointerDownRef.current && !touchActiveRef.current) {
        clearScrollSessionDirection()
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) {
        return
      }

      const scrollsUp =
        event.key === 'ArrowUp' ||
        event.key === 'PageUp' ||
        event.key === 'Home' ||
        (event.key === ' ' && event.shiftKey)
      const scrollsDown =
        event.key === 'ArrowDown' ||
        event.key === 'PageDown' ||
        event.key === 'End' ||
        (event.key === ' ' && !event.shiftKey)
      if (scrollsUp) {
        markScrollIntent('up')
      } else if (scrollsDown) {
        markScrollIntent('down')
      }
    }

    scrollContainerElement.addEventListener('wheel', handleWheel, {
      passive: true,
    })
    scrollContainerElement.addEventListener('pointerdown', handlePointerDown)
    scrollContainerElement.addEventListener('touchstart', handleTouchStart, {
      passive: true,
    })
    scrollContainerElement.addEventListener('touchmove', handleTouchMove, {
      passive: true,
    })
    scrollContainerElement.addEventListener('touchend', handleTouchEnd, {
      passive: true,
    })
    scrollContainerElement.addEventListener('touchcancel', handleTouchEnd, {
      passive: true,
    })
    scrollContainerElement.ownerDocument.addEventListener(
      'pointerup',
      handlePointerEnd,
    )
    scrollContainerElement.ownerDocument.addEventListener(
      'pointercancel',
      handlePointerCancel,
    )
    scrollContainerElement.addEventListener('keydown', handleKeyDown)
    scrollContainerElement.addEventListener('scroll', handleScroll, {
      passive: true,
    })
    scrollContainerElement.addEventListener('scrollend', handleScrollEnd)

    return () => {
      scrollContainerElement.removeEventListener('wheel', handleWheel)
      scrollContainerElement.removeEventListener(
        'pointerdown',
        handlePointerDown,
      )
      scrollContainerElement.removeEventListener('touchstart', handleTouchStart)
      scrollContainerElement.removeEventListener('touchmove', handleTouchMove)
      scrollContainerElement.removeEventListener('touchend', handleTouchEnd)
      scrollContainerElement.removeEventListener('touchcancel', handleTouchEnd)
      scrollContainerElement.ownerDocument.removeEventListener(
        'pointerup',
        handlePointerEnd,
      )
      scrollContainerElement.ownerDocument.removeEventListener(
        'pointercancel',
        handlePointerCancel,
      )
      scrollContainerElement.removeEventListener('keydown', handleKeyDown)
      scrollContainerElement.removeEventListener('scroll', handleScroll)
      scrollContainerElement.removeEventListener('scrollend', handleScrollEnd)
    }
  }, [
    clearScrollIntent,
    clearScrollSessionDirection,
    markScrollIntent,
    scheduleFollow,
    scheduleScrollSessionEnd,
    scrollContainerElement,
    stopAutoFollow,
    updateAutoFollow,
  ])

  useEffect(() => {
    if (
      !scrollContainerElement ||
      !bottomSentinelElement ||
      typeof IntersectionObserver === 'undefined'
    ) {
      return
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (
          entry &&
          !entry.isIntersecting &&
          autoFollowRef.current &&
          canFollowLiveEdgeRef.current
        ) {
          scheduleFollow()
        }
      },
      {
        root: scrollContainerElement,
        threshold: 0,
      },
    )
    observer.observe(bottomSentinelElement)

    return () => {
      observer.disconnect()
    }
  }, [bottomSentinelElement, scheduleFollow, scrollContainerElement])

  useEffect(
    () => () => {
      cancelScheduledFollow()
      clearScrollIntent()
      clearScrollSessionDirection()
    },
    [cancelScheduledFollow, clearScrollIntent, clearScrollSessionDirection],
  )

  return {
    autoScrollToBottom: scheduleFollow,
    forceScrollToBottom,
    stopAutoFollow,
    isAutoFollowEnabled: autoFollowState,
  }
}
