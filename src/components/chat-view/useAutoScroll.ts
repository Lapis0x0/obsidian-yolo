import { useCallback, useEffect, useRef } from 'react'

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
  const lastProgrammaticScrollRef = useRef<number>(0)
  const stickyScrollFrameRef = useRef<number | null>(null)

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) return

    const handleScroll = () => {
      // If the scroll event happened very close to our programmatic scroll, ignore it
      if (
        Date.now() - lastProgrammaticScrollRef.current <
        PROGRAMMATIC_SCROLL_DEBOUNCE_MS
      ) {
        return
      }

      preventAutoScrollRef.current =
        scrollContainer.scrollHeight -
          scrollContainer.scrollTop -
          scrollContainer.clientHeight >
        SCROLL_AWAY_FROM_BOTTOM_THRESHOLD
    }

    scrollContainer.addEventListener('scroll', handleScroll)
    return () => scrollContainer.removeEventListener('scroll', handleScroll)
  }, [scrollContainerRef])

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
    if (!isStreaming || preventAutoScrollRef.current) {
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
  }, [isStreaming, scrollToBottom])

  // Auto-scrolls to bottom only if the scroll position is near the bottom
  const autoScrollToBottom = useCallback(() => {
    if (!preventAutoScrollRef.current) {
      scrollToBottom()
    }
  }, [scrollToBottom])

  // Forces scroll to bottom regardless of current position
  const forceScrollToBottom = useCallback(() => {
    preventAutoScrollRef.current = false
    scrollToBottom()
  }, [scrollToBottom])

  return {
    autoScrollToBottom,
    forceScrollToBottom,
  }
}
