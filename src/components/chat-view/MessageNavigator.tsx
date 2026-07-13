import cx from 'clsx'
import type { RefObject } from 'react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'

const SCROLL_INDICATOR_HIDE_DELAY_MS = 800

export type MessageNavigatorAnchor = {
  id: string
  index: number
  label: string
}

type MessageNavigatorProps = {
  anchors: MessageNavigatorAnchor[]
  activeMessageId: string | null
  itemLabel: (index: number, label: string) => string
  onSelect: (messageId: string) => void
  scrollContainerRef: RefObject<HTMLElement>
}

function MessageNavigator({
  anchors,
  activeMessageId,
  itemLabel,
  onSelect,
  scrollContainerRef,
}: MessageNavigatorProps) {
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const scrollIdleTimerRef = useRef<number | null>(null)
  const isScrollingRef = useRef(false)
  const [isScrolling, setIsScrolling] = useState(false)

  const scrollActiveItemIntoView = useCallback(() => {
    if (!activeMessageId) {
      return
    }

    const activeItem = itemRefs.current[activeMessageId]
    if (!activeItem) {
      return
    }

    requestAnimationFrame(() => {
      activeItem.scrollIntoView({
        block: 'center',
        inline: 'nearest',
      })
    })
  }, [activeMessageId])

  useEffect(() => {
    scrollActiveItemIntoView()
  }, [scrollActiveItemIntoView])

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) {
      return
    }

    const handleScroll = () => {
      if (!isScrollingRef.current) {
        isScrollingRef.current = true
        setIsScrolling(true)
      }

      if (scrollIdleTimerRef.current !== null) {
        window.clearTimeout(scrollIdleTimerRef.current)
      }
      scrollIdleTimerRef.current = window.setTimeout(() => {
        scrollIdleTimerRef.current = null
        isScrollingRef.current = false
        setIsScrolling(false)
      }, SCROLL_INDICATOR_HIDE_DELAY_MS)
    }

    scrollContainer.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      scrollContainer.removeEventListener('scroll', handleScroll)
      if (scrollIdleTimerRef.current !== null) {
        window.clearTimeout(scrollIdleTimerRef.current)
        scrollIdleTimerRef.current = null
      }
      isScrollingRef.current = false
    }
  }, [scrollContainerRef])

  if (anchors.length === 0) {
    return null
  }

  return (
    <nav
      className={cx('yolo-message-navigator', isScrolling && 'is-scrolling')}
      onMouseEnter={scrollActiveItemIntoView}
    >
      <div className="yolo-message-navigator__rail">
        {anchors.map((anchor) => (
          <button
            key={anchor.id}
            type="button"
            className={cx(
              'yolo-message-navigator__bar',
              anchor.id === activeMessageId && 'is-active',
            )}
            onPointerDown={(event) => {
              event.preventDefault()
              onSelect(anchor.id)
            }}
          >
            <span className="yolo-sr-only">
              {itemLabel(anchor.index, anchor.label)}
            </span>
          </button>
        ))}
      </div>
      <div className="yolo-message-navigator__panel">
        <div className="yolo-message-navigator__items">
          {anchors.map((anchor) => (
            <button
              key={anchor.id}
              ref={(element) => {
                itemRefs.current[anchor.id] = element
              }}
              type="button"
              className={cx(
                'yolo-message-navigator__item',
                anchor.id === activeMessageId && 'is-active',
              )}
              onPointerDown={(event) => {
                event.preventDefault()
                onSelect(anchor.id)
              }}
              aria-current={anchor.id === activeMessageId ? 'location' : false}
            >
              <span className="yolo-message-navigator__item-label">
                {anchor.label}
              </span>
            </button>
          ))}
        </div>
      </div>
    </nav>
  )
}

export default memo(MessageNavigator)
