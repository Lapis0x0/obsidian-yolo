import { useCallback, useEffect, useRef, useState } from 'react'

const PROGRAMMATIC_SCROLL_DEBOUNCE_MS = 120
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

      updatePreventAutoScroll(shouldPreventAutoScroll)
    }

    scrollContainer.addEventListener('scroll', handleScroll)
    return () => scrollContainer.removeEventListener('scroll', handleScroll)
  }, [scrollContainerRef, updatePreventAutoScroll])

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
