import { useCallback, useEffect, useRef, useState } from 'react'

const PROGRAMMATIC_SCROLL_DEBOUNCE_MS = 120
const USER_SCROLL_INTENT_WINDOW_MS = 280
const SCROLL_AWAY_FROM_BOTTOM_THRESHOLD = 20

type UseAutoScrollProps = {
  scrollContainerRef: React.RefObject<HTMLElement>
  isStreaming?: boolean
}

export function useAutoScroll({
  scrollContainerRef,
  isStreaming = false,
}: UseAutoScrollProps) {
  const preventAutoScrollRef = useRef(false)
  const [preventAutoScrollState, setPreventAutoScrollState] = useState(false)
  const lastProgrammaticScrollRef = useRef<number>(0)
  const stickyScrollFrameRef = useRef<number | null>(null)
  const lastUserScrollIntentRef = useRef<number>(0)
  const mutationScrollFrameRef = useRef<number | null>(null)

  const markUserScrollIntent = useCallback(() => {
    lastUserScrollIntentRef.current = Date.now()
  }, [])

  const updatePreventAutoScroll = useCallback((nextValue: boolean) => {
    preventAutoScrollRef.current = nextValue
    setPreventAutoScrollState((previousValue) =>
      previousValue === nextValue ? previousValue : nextValue,
    )
  }, [])

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) return

    const handleScroll = () => {
      const shouldPreventAutoScroll =
        scrollContainer.scrollHeight -
          scrollContainer.scrollTop -
          scrollContainer.clientHeight >
        SCROLL_AWAY_FROM_BOTTOM_THRESHOLD
      const hasRecentUserScrollIntent =
        Date.now() - lastUserScrollIntentRef.current <
        USER_SCROLL_INTENT_WINDOW_MS

      // Ignore near-bottom programmatic scroll events, but still allow
      // user-triggered scroll-away actions to stop auto-follow immediately.
      if (
        Date.now() - lastProgrammaticScrollRef.current <
          PROGRAMMATIC_SCROLL_DEBOUNCE_MS &&
        !shouldPreventAutoScroll &&
        !preventAutoScrollRef.current
      ) {
        return
      }

      if (isStreaming && !hasRecentUserScrollIntent) {
        return
      }

      updatePreventAutoScroll(shouldPreventAutoScroll)
    }

    scrollContainer.addEventListener('wheel', markUserScrollIntent, {
      passive: true,
    })
    scrollContainer.addEventListener('touchmove', markUserScrollIntent, {
      passive: true,
    })
    scrollContainer.addEventListener('pointerdown', markUserScrollIntent)
    scrollContainer.addEventListener('scroll', handleScroll)
    return () => {
      scrollContainer.removeEventListener('wheel', markUserScrollIntent)
      scrollContainer.removeEventListener('touchmove', markUserScrollIntent)
      scrollContainer.removeEventListener('pointerdown', markUserScrollIntent)
      scrollContainer.removeEventListener('scroll', handleScroll)
    }
  }, [
    isStreaming,
    markUserScrollIntent,
    scrollContainerRef,
    updatePreventAutoScroll,
  ])

  const scrollToBottom = useCallback(() => {
    if (scrollContainerRef.current) {
      const scrollContainer = scrollContainerRef.current
      const targetScrollTop = Math.max(
        0,
        scrollContainer.scrollHeight - scrollContainer.clientHeight,
      )
      if (Math.abs(scrollContainer.scrollTop - targetScrollTop) > 1) {
        lastProgrammaticScrollRef.current = Date.now()
        scrollContainer.scrollTop = targetScrollTop
      }
    }
  }, [scrollContainerRef])

  useEffect(() => {
    if (!isStreaming || preventAutoScrollState) {
      if (stickyScrollFrameRef.current !== null) {
        cancelAnimationFrame(stickyScrollFrameRef.current)
        stickyScrollFrameRef.current = null
      }
      return
    }

    const syncScrollToBottom = () => {
      if (preventAutoScrollRef.current) {
        stickyScrollFrameRef.current = null
        return
      }

      scrollToBottom()
      stickyScrollFrameRef.current = requestAnimationFrame(syncScrollToBottom)
    }

    stickyScrollFrameRef.current = requestAnimationFrame(syncScrollToBottom)

    return () => {
      if (stickyScrollFrameRef.current !== null) {
        cancelAnimationFrame(stickyScrollFrameRef.current)
        stickyScrollFrameRef.current = null
      }
    }
  }, [isStreaming, preventAutoScrollState, scrollToBottom])

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer || typeof MutationObserver === 'undefined') {
      return
    }

    const scheduleMutationScroll = () => {
      if (
        preventAutoScrollRef.current ||
        mutationScrollFrameRef.current !== null
      ) {
        return
      }

      mutationScrollFrameRef.current = requestAnimationFrame(() => {
        mutationScrollFrameRef.current = null
        if (!preventAutoScrollRef.current) {
          scrollToBottom()
        }
      })
    }

    const observer = new MutationObserver(() => {
      scheduleMutationScroll()
    })

    observer.observe(scrollContainer, {
      childList: true,
      subtree: true,
      characterData: true,
    })

    return () => {
      observer.disconnect()
      if (mutationScrollFrameRef.current !== null) {
        cancelAnimationFrame(mutationScrollFrameRef.current)
        mutationScrollFrameRef.current = null
      }
    }
  }, [scrollContainerRef, scrollToBottom])

  // Auto-scrolls to bottom only if the scroll position is near the bottom
  const autoScrollToBottom = useCallback(() => {
    if (!preventAutoScrollRef.current) {
      scrollToBottom()
    }
  }, [scrollToBottom])

  // Forces scroll to bottom regardless of current position
  const forceScrollToBottom = useCallback(() => {
    updatePreventAutoScroll(false)
    scrollToBottom()
  }, [scrollToBottom, updatePreventAutoScroll])

  return {
    autoScrollToBottom,
    forceScrollToBottom,
  }
}
