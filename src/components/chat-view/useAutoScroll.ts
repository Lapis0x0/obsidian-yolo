import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

const AT_BOTTOM_THRESHOLD_PX = 24
const SCROLL_POSITION_EPSILON_PX = 1

type UseAutoScrollProps = {
  scrollContainerRef: React.RefObject<HTMLElement>
  scrollContainerElement?: HTMLElement | null
  contentElement?: HTMLElement | null
  followKey?: string
}

type ScrollTransitionInput = {
  isFollowing: boolean
  previousScrollTop: number
  currentScrollTop: number
  distanceToBottom: number
  allowReattach: boolean
  isLayoutAdjustment?: boolean
}

export const resolveAutoFollowFromScroll = ({
  isFollowing,
  previousScrollTop,
  currentScrollTop,
  distanceToBottom,
  allowReattach,
  isLayoutAdjustment = false,
}: ScrollTransitionInput): boolean => {
  if (isLayoutAdjustment) {
    return isFollowing
  }

  if (currentScrollTop < previousScrollTop - SCROLL_POSITION_EPSILON_PX) {
    return false
  }

  if (
    currentScrollTop > previousScrollTop + SCROLL_POSITION_EPSILON_PX &&
    allowReattach &&
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
  contentElement,
  followKey,
}: UseAutoScrollProps) {
  const scrollContainerElement =
    scrollContainerElementOverride ?? scrollContainerRef.current
  const autoFollowRef = useRef(true)
  const [autoFollowState, setAutoFollowState] = useState(true)
  const lastObservedScrollTopRef = useRef(0)
  const lastMaxScrollTopRef = useRef(0)
  const followFrameRef = useRef<number | null>(null)
  const reattachIntentFrameRef = useRef<number | null>(null)
  const hasReattachIntentRef = useRef(false)
  const pointerDownRef = useRef(false)
  const pointerMomentumRef = useRef(false)
  const programmaticScrollTargetRef = useRef<number | null>(null)

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
      cancelAnimationFrame(followFrameRef.current)
      followFrameRef.current = null
    }
  }, [])

  const clearReattachIntent = useCallback(() => {
    hasReattachIntentRef.current = false
    if (reattachIntentFrameRef.current !== null) {
      cancelAnimationFrame(reattachIntentFrameRef.current)
      reattachIntentFrameRef.current = null
    }
  }, [])

  const markReattachIntent = useCallback(() => {
    hasReattachIntentRef.current = true
    if (reattachIntentFrameRef.current !== null) {
      return
    }

    reattachIntentFrameRef.current = requestAnimationFrame(() => {
      reattachIntentFrameRef.current = null
      hasReattachIntentRef.current = false
    })
  }, [])

  const stopAutoFollow = useCallback(() => {
    cancelScheduledFollow()
    programmaticScrollTargetRef.current = null
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
      programmaticScrollTargetRef.current = null
      lastObservedScrollTopRef.current = scrollContainer.scrollTop
      lastMaxScrollTopRef.current = targetScrollTop
      return
    }

    programmaticScrollTargetRef.current = targetScrollTop
    scrollContainer.scrollTop = targetScrollTop
    lastObservedScrollTopRef.current = scrollContainer.scrollTop
    lastMaxScrollTopRef.current = targetScrollTop
  }, [getScrollContainer])

  const scheduleFollow = useCallback(() => {
    if (!autoFollowRef.current || followFrameRef.current !== null) {
      return
    }

    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = null
      if (autoFollowRef.current) {
        scrollToBottom()
      }
    })
  }, [scrollToBottom])

  const forceScrollToBottom = useCallback(() => {
    updateAutoFollow(true)
    cancelScheduledFollow()
    scrollToBottom()
    scheduleFollow()
  }, [cancelScheduledFollow, scheduleFollow, scrollToBottom, updateAutoFollow])

  useLayoutEffect(() => {
    if (!scrollContainerElement || !contentElement) {
      return
    }

    updateAutoFollow(true)
    cancelScheduledFollow()
    scrollToBottom()
  }, [
    cancelScheduledFollow,
    contentElement,
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
    lastMaxScrollTopRef.current = Math.max(
      0,
      scrollContainerElement.scrollHeight - scrollContainerElement.clientHeight,
    )

    const handleScroll = () => {
      const currentScrollTop = scrollContainerElement.scrollTop
      const previousScrollTop = lastObservedScrollTopRef.current
      const previousMaxScrollTop = lastMaxScrollTopRef.current
      const currentMaxScrollTop = Math.max(
        0,
        scrollContainerElement.scrollHeight -
          scrollContainerElement.clientHeight,
      )
      lastObservedScrollTopRef.current = currentScrollTop
      lastMaxScrollTopRef.current = currentMaxScrollTop

      const programmaticTarget = programmaticScrollTargetRef.current
      if (
        programmaticTarget !== null &&
        Math.abs(currentScrollTop - programmaticTarget) <=
          SCROLL_POSITION_EPSILON_PX
      ) {
        programmaticScrollTargetRef.current = null
        return
      }
      programmaticScrollTargetRef.current = null

      if (
        'onscrollend' in scrollContainerElement &&
        (pointerDownRef.current || hasReattachIntentRef.current)
      ) {
        pointerMomentumRef.current = true
      }

      const distanceToBottom = currentMaxScrollTop - currentScrollTop
      const wasAtBottomBefore =
        previousMaxScrollTop - previousScrollTop <= AT_BOTTOM_THRESHOLD_PX
      const isAtBottom = distanceToBottom <= SCROLL_POSITION_EPSILON_PX
      const maxScrollTopShrank =
        currentMaxScrollTop < previousMaxScrollTop - SCROLL_POSITION_EPSILON_PX
      const isLayoutAdjustment =
        currentScrollTop < previousScrollTop - SCROLL_POSITION_EPSILON_PX &&
        wasAtBottomBefore &&
        isAtBottom &&
        maxScrollTopShrank
      const nextAutoFollow = resolveAutoFollowFromScroll({
        isFollowing: autoFollowRef.current,
        previousScrollTop,
        currentScrollTop,
        distanceToBottom,
        allowReattach:
          pointerDownRef.current ||
          pointerMomentumRef.current ||
          hasReattachIntentRef.current,
        isLayoutAdjustment,
      })

      if (!pointerDownRef.current && !pointerMomentumRef.current) {
        clearReattachIntent()
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
      if (event.deltaY > 0) {
        markReattachIntent()
      }
    }

    const handlePointerDown = () => {
      pointerDownRef.current = true
      pointerMomentumRef.current = false
    }

    const handlePointerEnd = () => {
      pointerDownRef.current = false
      clearReattachIntent()
    }

    const handlePointerCancel = () => {
      pointerDownRef.current = false
      markReattachIntent()
    }

    const handleScrollEnd = () => {
      if (!pointerDownRef.current) {
        pointerMomentumRef.current = false
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
      if (!scrollsUp && scrollsDown) {
        markReattachIntent()
      }
    }

    scrollContainerElement.addEventListener('wheel', handleWheel, {
      passive: true,
    })
    scrollContainerElement.addEventListener('pointerdown', handlePointerDown)
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
      scrollContainerElement.ownerDocument.removeEventListener(
        'pointerup',
        handlePointerEnd,
      )
      scrollContainerElement.removeEventListener('keydown', handleKeyDown)
      scrollContainerElement.ownerDocument.removeEventListener(
        'pointercancel',
        handlePointerCancel,
      )
      scrollContainerElement.removeEventListener('scroll', handleScroll)
      scrollContainerElement.removeEventListener('scrollend', handleScrollEnd)
    }
  }, [
    clearReattachIntent,
    markReattachIntent,
    scheduleFollow,
    scrollContainerElement,
    stopAutoFollow,
    updateAutoFollow,
  ])

  useEffect(() => {
    if (
      !scrollContainerElement ||
      !contentElement ||
      typeof ResizeObserver === 'undefined'
    ) {
      return
    }

    const observer = new ResizeObserver(() => {
      if (autoFollowRef.current) {
        scrollToBottom()
      }
    })
    observer.observe(scrollContainerElement)
    observer.observe(contentElement)

    return () => {
      observer.disconnect()
    }
  }, [contentElement, scrollContainerElement, scrollToBottom])

  useEffect(
    () => () => {
      cancelScheduledFollow()
      clearReattachIntent()
      programmaticScrollTargetRef.current = null
    },
    [cancelScheduledFollow, clearReattachIntent],
  )

  return {
    autoScrollToBottom: scheduleFollow,
    forceScrollToBottom,
    stopAutoFollow,
    isAutoFollowEnabled: autoFollowState,
  }
}
