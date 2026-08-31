import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import { getNodeWindow } from '../../utils/dom/window-context'

import { createScrollController } from './scroll/scrollController'

const AT_BOTTOM_THRESHOLD_PX = 24
const SCROLL_POSITION_EPSILON_PX = 1
const TOUCH_DIRECTION_THRESHOLD_PX = 4
const SCROLL_SESSION_END_DELAY_MS = 160
// A follow session is opened by an explicit live-content update (streaming,
// a new message, or an explicit jump to the live edge). Layout observers may
// continue reporting asynchronous markdown/image/LaTeX growth during this
// window. Once it expires, a layout change is treated as a viewport-preserving
// user interaction instead of an implicit request to scroll to the bottom.
const FOLLOW_SESSION_END_DELAY_MS = 500

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

type ScheduledTimeout = {
  window: Window
  id: number
}

type ScrollDirection = 'up' | 'down'

type LiveEdgeObservation = {
  isIntersecting: boolean
  isFollowing: boolean
  canFollowLiveEdge: boolean
  hasActiveFollowSession: boolean
}

/**
 * A live-edge observation is only actionable while an explicit follow
 * session is active. A disclosure/layout change can move the sentinel out of
 * view without representing new live content.
 */
export const shouldFollowAfterLiveEdgeExit = ({
  isIntersecting,
  isFollowing,
  canFollowLiveEdge,
  hasActiveFollowSession,
}: LiveEdgeObservation): boolean =>
  !isIntersecting && isFollowing && canFollowLiveEdge && hasActiveFollowSession

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
  const scrollControllerRef = useRef<ReturnType<
    typeof createScrollController
  > | null>(null)
  if (scrollControllerRef.current === null) {
    scrollControllerRef.current = createScrollController()
  }
  const scrollController = scrollControllerRef.current
  // Declared first so this layout effect runs before the "snap to bottom"
  // layout effect below in the same commit — the controller must be bound
  // to the (possibly new, on conversation switch) element before anything
  // submits an intent to it.
  useLayoutEffect(() => {
    scrollController.bindElement(scrollContainerElement ?? null)
  }, [scrollController, scrollContainerElement])
  useEffect(() => () => scrollController.dispose(), [scrollController])

  const autoFollowRef = useRef(true)
  const canFollowLiveEdgeRef = useRef(canFollowLiveEdge)
  canFollowLiveEdgeRef.current = canFollowLiveEdge
  const [autoFollowState, setAutoFollowState] = useState(true)
  const lastObservedScrollTopRef = useRef(0)
  const scrollIntentFrameRef = useRef<ScheduledFrame | null>(null)
  const scrollIntentRef = useRef<ScrollDirection | null>(null)
  const followSessionRef = useRef(false)
  const followSessionEndTimerRef = useRef<ScheduledTimeout | null>(null)
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

  const clearFollowSession = useCallback(() => {
    followSessionRef.current = false
    if (followSessionEndTimerRef.current !== null) {
      followSessionEndTimerRef.current.window.clearTimeout(
        followSessionEndTimerRef.current.id,
      )
      followSessionEndTimerRef.current = null
    }
  }, [])

  const beginFollowSession = useCallback(() => {
    followSessionRef.current = true
    if (followSessionEndTimerRef.current !== null) {
      followSessionEndTimerRef.current.window.clearTimeout(
        followSessionEndTimerRef.current.id,
      )
    }

    const scrollContainer = getScrollContainer()
    const ownerWindow = scrollContainer?.ownerDocument.defaultView ?? window
    followSessionEndTimerRef.current = {
      window: ownerWindow,
      id: ownerWindow.setTimeout(() => {
        followSessionEndTimerRef.current = null
        followSessionRef.current = false
      }, FOLLOW_SESSION_END_DELAY_MS),
    }
  }, [getScrollContainer])

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
    scrollController.cancelFollowLiveEdge()
    updateAutoFollow(false)
  }, [scrollController, updateAutoFollow])

  const resolveBottomTarget = useCallback((): number | null => {
    const scrollContainer = getScrollContainer()
    if (!scrollContainer) {
      return null
    }
    return Math.max(
      0,
      scrollContainer.scrollHeight - scrollContainer.clientHeight,
    )
  }, [getScrollContainer])

  // Re-checked at write time (not just at schedule time) because the
  // rAF-deferred write can land a frame after autoFollow/canFollowLiveEdge
  // changed.
  const resolveFollowTarget = useCallback((): number | null => {
    if (!autoFollowRef.current || !canFollowLiveEdgeRef.current) {
      return null
    }
    return resolveBottomTarget()
  }, [resolveBottomTarget])

  const scheduleFollow = useCallback(() => {
    if (!autoFollowRef.current || !canFollowLiveEdgeRef.current) {
      return
    }
    beginFollowSession()
    scrollController.submitFollowLiveEdge(resolveFollowTarget)
  }, [beginFollowSession, resolveFollowTarget, scrollController])

  const forceScrollToBottom = useCallback(() => {
    clearScrollIntent()
    clearScrollSessionDirection()
    updateAutoFollow(true)
    // Bypasses the canFollowLiveEdge gate on purpose: this is an explicit
    // user/caller request to snap to the live edge regardless of the
    // history-window state.
    scrollController.snapNow(resolveBottomTarget)
    scheduleFollow()
  }, [
    clearScrollIntent,
    clearScrollSessionDirection,
    resolveBottomTarget,
    scheduleFollow,
    scrollController,
    updateAutoFollow,
  ])

  useLayoutEffect(() => {
    if (!scrollContainerElement || !bottomSentinelElement) {
      return
    }

    updateAutoFollow(true)
    if (canFollowLiveEdgeRef.current) {
      // Conversation switch must land at the bottom before paint; the rAF
      // queue would show one frame of the previous scroll position first.
      scrollController.snapNow(resolveBottomTarget)
    } else {
      scrollController.cancelFollowLiveEdge()
    }
  }, [
    bottomSentinelElement,
    followKey,
    resolveBottomTarget,
    scrollContainerElement,
    scrollController,
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
      // A pointer interaction inside the timeline may synchronously change
      // layout (for example, expanding a Thought panel). It ends the current
      // follow session before that layout reaches IntersectionObserver, while
      // leaving auto-follow enabled for the next actual live-content update.
      clearFollowSession()
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

      clearFollowSession()
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

      clearFollowSession()

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
    clearFollowSession,
    markScrollIntent,
    scheduleFollow,
    scheduleScrollSessionEnd,
    scrollContainerElement,
    stopAutoFollow,
    updateAutoFollow,
  ])

  useEffect(() => {
    if (!scrollContainerElement || !bottomSentinelElement) {
      return
    }
    // popout 是独立 BrowserWindow：全局 `IntersectionObserver` 属于主窗口，
    // 用它观察另一个 realm 的哨兵元素观察不到，live-edge 跟随会整窗失效。
    const ObserverCtor = getNodeWindow(
      bottomSentinelElement,
    ).IntersectionObserver
    if (typeof ObserverCtor === 'undefined') {
      return
    }

    const observer = new ObserverCtor(
      ([entry]) => {
        if (
          entry &&
          shouldFollowAfterLiveEdgeExit({
            isIntersecting: entry.isIntersecting,
            isFollowing: autoFollowRef.current,
            canFollowLiveEdge: canFollowLiveEdgeRef.current,
            hasActiveFollowSession: followSessionRef.current,
          })
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
      scrollController.cancelFollowLiveEdge()
      clearScrollIntent()
      clearScrollSessionDirection()
      clearFollowSession()
    },
    [
      clearFollowSession,
      clearScrollIntent,
      clearScrollSessionDirection,
      scrollController,
    ],
  )

  return {
    autoScrollToBottom: scheduleFollow,
    forceScrollToBottom,
    stopAutoFollow,
    isAutoFollowEnabled: autoFollowState,
    scrollController,
  }
}
