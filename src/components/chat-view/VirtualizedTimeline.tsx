import {
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import type { ChatTimelineItem } from '../../types/chat-timeline'

const DEFAULT_OVERSCAN_PX = 1200
const DEFAULT_VIRTUALIZATION_THRESHOLD = 24

type VirtualizedTimelineProps<TItem extends ChatTimelineItem> = {
  items: TItem[]
  scrollContainerRef: React.RefObject<HTMLElement>
  renderItem: (item: TItem, index: number) => ReactNode
  overscanPx?: number
  virtualizationThreshold?: number
  forceRenderItemIds?: string[]
  onRenderStateChange?: (state: {
    visibleStartIndex: number
    visibleEndIndex: number
    heightByItemId: Record<string, number>
  }) => void
}

type TimelineRowProps<TItem extends ChatTimelineItem> = {
  item: TItem
  index: number
  renderItem: (item: TItem, index: number) => ReactNode
  onHeightChange: (itemId: string, height: number) => void
}

function VirtualizedTimelineRowInner<TItem extends ChatTimelineItem>({
  item,
  index,
  renderItem,
  onHeightChange,
}: TimelineRowProps<TItem>) {
  const rowRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const element = rowRef.current
    if (!element) {
      return
    }

    const notifyHeight = () => {
      onHeightChange(item.id, Math.ceil(element.getBoundingClientRect().height))
    }

    notifyHeight()

    let frame1 = 0
    let frame2 = 0
    frame1 = requestAnimationFrame(() => {
      notifyHeight()
      frame2 = requestAnimationFrame(() => {
        notifyHeight()
      })
    })

    if (typeof ResizeObserver === 'undefined') {
      return () => {
        if (frame1) {
          cancelAnimationFrame(frame1)
        }
        if (frame2) {
          cancelAnimationFrame(frame2)
        }
      }
    }

    const observer = new ResizeObserver(() => {
      notifyHeight()
    })
    observer.observe(element)

    return () => {
      if (frame1) {
        cancelAnimationFrame(frame1)
      }
      if (frame2) {
        cancelAnimationFrame(frame2)
      }
      observer.disconnect()
    }
  }, [index, item.id, item.renderKey, item.spacingBefore, onHeightChange])

  return (
    <div
      ref={rowRef}
      className={`smtcmp-chat-timeline-row smtcmp-chat-timeline-row--${item.kind}`}
      data-timeline-kind={item.kind}
      style={
        item.spacingBefore ? { paddingTop: item.spacingBefore } : undefined
      }
    >
      {renderItem(item, index)}
    </div>
  )
}

const VirtualizedTimelineRow = memo(
  VirtualizedTimelineRowInner,
) as typeof VirtualizedTimelineRowInner

export function VirtualizedTimeline<TItem extends ChatTimelineItem>({
  items,
  scrollContainerRef,
  renderItem,
  overscanPx = DEFAULT_OVERSCAN_PX,
  virtualizationThreshold = DEFAULT_VIRTUALIZATION_THRESHOLD,
  forceRenderItemIds = [],
  onRenderStateChange,
}: VirtualizedTimelineProps<TItem>) {
  const heightCacheRef = useRef<Map<string, number>>(new Map())
  const [layoutVersion, setLayoutVersion] = useState(0)
  const [visibleRange, setVisibleRange] = useState(() => ({
    start: 0,
    end: items.length - 1,
  }))

  const itemOffsets = useMemo(() => {
    let offset = 0
    return items.map((item) => {
      const height =
        heightCacheRef.current.get(item.id) ??
        item.estimatedHeight + (item.spacingBefore ?? 0)
      const top = offset
      offset += height
      return {
        id: item.id,
        top,
        height,
        bottom: offset,
      }
    })
  }, [items, layoutVersion])

  const totalHeight = itemOffsets.at(-1)?.bottom ?? 0

  const updateVisibleRange = useCallback(() => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer || items.length === 0) {
      setVisibleRange({ start: 0, end: items.length - 1 })
      return
    }

    if (items.length <= virtualizationThreshold) {
      setVisibleRange({ start: 0, end: items.length - 1 })
      return
    }

    const scrollTop = scrollContainer.scrollTop
    const viewportTop = Math.max(0, scrollTop - overscanPx)
    const viewportBottom = scrollTop + scrollContainer.clientHeight + overscanPx

    let start = 0
    while (
      start < itemOffsets.length &&
      itemOffsets[start] &&
      itemOffsets[start].bottom < viewportTop
    ) {
      start += 1
    }

    let end = Math.max(start, itemOffsets.length - 1)
    for (let index = start; index < itemOffsets.length; index += 1) {
      if (itemOffsets[index].top > viewportBottom) {
        end = Math.max(start, index - 1)
        break
      }
      end = index
    }

    setVisibleRange((previous) =>
      previous.start === start && previous.end === end
        ? previous
        : { start, end },
    )
  }, [
    itemOffsets,
    items.length,
    overscanPx,
    scrollContainerRef,
    virtualizationThreshold,
  ])

  useEffect(() => {
    updateVisibleRange()
  }, [items.length, layoutVersion, updateVisibleRange])

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) {
      return
    }

    let frame = 0
    const scheduleUpdate = () => {
      if (frame) {
        return
      }
      frame = requestAnimationFrame(() => {
        frame = 0
        updateVisibleRange()
      })
    }

    scrollContainer.addEventListener('scroll', scheduleUpdate, {
      passive: true,
    })
    window.addEventListener('resize', scheduleUpdate)

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        scheduleUpdate()
      })
      observer.observe(scrollContainer)
      return () => {
        if (frame) {
          cancelAnimationFrame(frame)
        }
        observer.disconnect()
        scrollContainer.removeEventListener('scroll', scheduleUpdate)
        window.removeEventListener('resize', scheduleUpdate)
      }
    }

    return () => {
      if (frame) {
        cancelAnimationFrame(frame)
      }
      scrollContainer.removeEventListener('scroll', scheduleUpdate)
      window.removeEventListener('resize', scheduleUpdate)
    }
  }, [scrollContainerRef, updateVisibleRange])

  const handleHeightChange = useCallback((itemId: string, height: number) => {
    const previousHeight = heightCacheRef.current.get(itemId)
    if (previousHeight === height || height <= 0) {
      return
    }

    heightCacheRef.current.set(itemId, height)
    setLayoutVersion((previous) => previous + 1)
  }, [])

  const renderIndices = useMemo(() => {
    if (items.length === 0) {
      return [] as number[]
    }

    if (items.length <= virtualizationThreshold) {
      return items.map((_, index) => index)
    }

    const forceRenderIdSet = new Set(forceRenderItemIds)
    const indices = new Set<number>()
    for (
      let index = visibleRange.start;
      index <= visibleRange.end && index < items.length;
      index += 1
    ) {
      indices.add(index)
    }

    items.forEach((item, index) => {
      if (item.isPinnedForRender || forceRenderIdSet.has(item.id)) {
        indices.add(index)
      }
    })

    return Array.from(indices).sort((a, b) => a - b)
  }, [
    forceRenderItemIds,
    items,
    virtualizationThreshold,
    visibleRange.end,
    visibleRange.start,
  ])

  const heightByItemId = useMemo(
    () => Object.fromEntries(heightCacheRef.current.entries()),
    [layoutVersion],
  )

  useEffect(() => {
    onRenderStateChange?.({
      visibleStartIndex: visibleRange.start,
      visibleEndIndex: visibleRange.end,
      heightByItemId,
    })
  }, [
    heightByItemId,
    onRenderStateChange,
    visibleRange.end,
    visibleRange.start,
  ])

  let lastBottom = 0
  const renderedRows: ReactNode[] = []
  renderIndices.forEach((index) => {
    const item = items[index]
    const offset = itemOffsets[index]
    if (!item || !offset) {
      return
    }

    const spacerHeight = offset.top - lastBottom
    if (spacerHeight > 0) {
      renderedRows.push(
        <div
          key={`spacer-before-${item.id}`}
          style={{ height: spacerHeight, flexShrink: 0 }}
          aria-hidden="true"
        />,
      )
    }

    renderedRows.push(
      <VirtualizedTimelineRow
        key={item.renderKey}
        item={item}
        index={index}
        renderItem={renderItem}
        onHeightChange={handleHeightChange}
      />,
    )
    lastBottom = offset.bottom
  })

  const bottomSpacerHeight = Math.max(0, totalHeight - lastBottom)
  if (bottomSpacerHeight > 0) {
    renderedRows.push(
      <div
        key="timeline-bottom-spacer"
        style={{ height: bottomSpacerHeight, flexShrink: 0 }}
        aria-hidden="true"
      />,
    )
  }

  return <>{renderedRows}</>
}
