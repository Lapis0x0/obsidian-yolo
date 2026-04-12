import type { CSSProperties, ReactNode, RefObject } from 'react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  type FollowOutput,
  type ListRange,
  Virtuoso,
  type VirtuosoHandle,
} from 'react-virtuoso'

import { useApp } from '../../contexts/app-context'
import { useSettings } from '../../contexts/settings-context'
import {
  flushPersistedTimelineHeightCache,
  hydratePersistedTimelineHeightCache,
  schedulePersistedTimelineHeightCacheFlush,
} from '../../database/json/chat/timelineHeightCacheStore'
import type { ChatTimelineItem } from '../../types/chat-timeline'
import {
  type TimelineCacheScope,
  buildTimelineSignature,
  getTimelineHeightCache,
  getTimelineStateSnapshot,
  getTimelineStyleSignature,
  getTimelineWidthBucket,
  setTimelineStateSnapshot,
  updateTimelineItemHeight,
} from '../../utils/chat/timeline-virtualization-cache'

const DEFAULT_OVERSCAN_PX = 1200
const DEFAULT_VIRTUALIZATION_THRESHOLD = 24
const DEFAULT_AT_BOTTOM_THRESHOLD = 24
const DEFAULT_TIMELINE_KEY = 'timeline'

export type ChatTimelineRenderContext = {
  mode: 'full'
}

type RowProps<TItem extends ChatTimelineItem> = {
  item: TItem
  index: number
  renderItem: (
    item: TItem,
    index: number,
    context?: ChatTimelineRenderContext,
  ) => ReactNode
  onMeasuredHeight?: (itemId: string, height: number) => void
}

function TimelineRow<TItem extends ChatTimelineItem>({
  item,
  index,
  renderItem,
  onMeasuredHeight,
}: RowProps<TItem>) {
  const rowRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const rowElement = rowRef.current
    if (!rowElement || !onMeasuredHeight) {
      return
    }

    let animationFrameId: number | null = null

    const publishHeight = () => {
      const measuredHeight = Math.max(
        1,
        Math.ceil(rowElement.getBoundingClientRect().height),
      )
      onMeasuredHeight(item.renderKey, measuredHeight)
    }

    publishHeight()

    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(() => {
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId)
      }
      animationFrameId = requestAnimationFrame(() => {
        animationFrameId = null
        publishHeight()
      })
    })
    observer.observe(rowElement)

    return () => {
      observer.disconnect()
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId)
      }
    }
  }, [item.renderKey, onMeasuredHeight])

  return (
    <div
      ref={rowRef}
      className={`smtcmp-chat-timeline-row smtcmp-chat-timeline-row--${item.kind}`}
      data-timeline-kind={item.kind}
      style={
        item.spacingBefore ? { paddingTop: item.spacingBefore } : undefined
      }
    >
      {renderItem(item, index, { mode: 'full' })}
    </div>
  )
}

type ChatTimelineListProps<TItem extends ChatTimelineItem> = {
  items: TItem[]
  conversationId?: string
  scrollContainerRef: RefObject<HTMLElement>
  renderItem: (
    item: TItem,
    index: number,
    context?: ChatTimelineRenderContext,
  ) => ReactNode
  overscanPx?: number
  virtualizationThreshold?: number
  forceRenderItemIds?: string[]
  onRenderStateChange?: (state: {
    visibleStartIndex: number
    visibleEndIndex: number
    heightByItemId: Record<string, number>
  }) => void
  scrollContainerClassName?: string
  scrollContainerStyle?: CSSProperties
  followOutput?: FollowOutput
  atBottomThreshold?: number
  onAtBottomStateChange?: (atBottom: boolean) => void
  onVirtualizationChange?: (isVirtualized: boolean) => void
}

function setScrollContainerRef(
  ref: RefObject<HTMLElement>,
  element: HTMLElement | null,
) {
  ;(ref as { current: HTMLElement | null }).current = element
}

export function ChatTimelineList<TItem extends ChatTimelineItem>({
  items,
  conversationId,
  scrollContainerRef,
  renderItem,
  overscanPx = DEFAULT_OVERSCAN_PX,
  virtualizationThreshold = DEFAULT_VIRTUALIZATION_THRESHOLD,
  forceRenderItemIds = [],
  onRenderStateChange,
  scrollContainerClassName,
  scrollContainerStyle,
  followOutput,
  atBottomThreshold = DEFAULT_AT_BOTTOM_THRESHOLD,
  onAtBottomStateChange,
  onVirtualizationChange,
}: ChatTimelineListProps<TItem>) {
  // Reserved for phase-2 pinned rendering semantics.
  void forceRenderItemIds
  const app = useApp()
  const { settings } = useSettings()

  const virtuosoRef = useRef<VirtuosoHandle | null>(null)
  const [scrollerElement, setScrollerElement] = useState<HTMLElement | null>(
    null,
  )
  const lastAtBottomStateRef = useRef<boolean | null>(null)
  const [heightCacheVersion, setHeightCacheVersion] = useState(0)
  const [hasHydratedPersistedCache, setHasHydratedPersistedCache] =
    useState(!conversationId)
  const [cacheScopeState, setCacheScopeState] = useState<{
    widthBucket: number
    styleSignature: string
  }>({
    widthBucket: getTimelineWidthBucket(0),
    styleSignature: getTimelineStyleSignature(null),
  })

  const isVirtualized = items.length > virtualizationThreshold

  useLayoutEffect(() => {
    onVirtualizationChange?.(isVirtualized)
  }, [isVirtualized, onVirtualizationChange])

  const timelineSignature = useMemo(
    () => buildTimelineSignature(items),
    [items],
  )

  const cacheScope = useMemo<TimelineCacheScope | null>(() => {
    if (!conversationId) {
      return null
    }

    return {
      conversationId,
      widthBucket: cacheScopeState.widthBucket,
      styleSignature: cacheScopeState.styleSignature,
    }
  }, [
    cacheScopeState.styleSignature,
    cacheScopeState.widthBucket,
    conversationId,
  ])

  useEffect(() => {
    setHasHydratedPersistedCache(!conversationId)
  }, [conversationId])

  useEffect(() => {
    if (!conversationId) {
      return
    }

    let isCancelled = false

    void hydratePersistedTimelineHeightCache({
      app,
      conversationId,
      settings,
    }).then(() => {
      if (isCancelled) {
        return
      }
      setHeightCacheVersion((currentVersion) => currentVersion + 1)
      setHasHydratedPersistedCache(true)
    })

    return () => {
      isCancelled = true
    }
  }, [app, conversationId, settings])

  const cachedHeightByItemId = useMemo(() => {
    if (!cacheScope) {
      return null
    }
    return getTimelineHeightCache(cacheScope)
  }, [cacheScope, hasHydratedPersistedCache, heightCacheVersion])

  const restoreStateFrom = useMemo(() => {
    if (!isVirtualized || !cacheScope) {
      return undefined
    }
    return (
      getTimelineStateSnapshot({
        scope: cacheScope,
        timelineSignature,
      }) ?? undefined
    )
  }, [cacheScope, isVirtualized, timelineSignature])

  const handleMeasuredRowHeight = useCallback(
    (itemId: string, measuredHeight: number) => {
      if (!cacheScope) {
        return
      }

      const changed = updateTimelineItemHeight(
        cacheScope,
        itemId,
        measuredHeight,
      )
      if (changed) {
        setHeightCacheVersion((currentVersion) => currentVersion + 1)
        schedulePersistedTimelineHeightCacheFlush({
          app,
          conversationId: cacheScope.conversationId,
          settings,
        })
      }
    },
    [app, cacheScope, settings],
  )

  const handleScrollerRef = useCallback(
    (element: HTMLElement | null) => {
      setScrollContainerRef(scrollContainerRef, element)
      setScrollerElement((previousElement) =>
        previousElement === element ? previousElement : element,
      )
    },
    [scrollContainerRef],
  )

  useLayoutEffect(() => {
    if (!conversationId || !scrollerElement) {
      return
    }

    const syncScopeState = () => {
      const nextWidthBucket = getTimelineWidthBucket(
        scrollerElement.clientWidth,
      )
      const nextStyleSignature = getTimelineStyleSignature(scrollerElement)

      setCacheScopeState((previousState) => {
        if (
          previousState.widthBucket === nextWidthBucket &&
          previousState.styleSignature === nextStyleSignature
        ) {
          return previousState
        }
        return {
          widthBucket: nextWidthBucket,
          styleSignature: nextStyleSignature,
        }
      })
    }

    syncScopeState()

    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(syncScopeState)
    observer.observe(scrollerElement)
    return () => {
      observer.disconnect()
    }
  }, [conversationId, scrollerElement])

  useEffect(() => {
    if (isVirtualized || !scrollerElement || !onAtBottomStateChange) {
      lastAtBottomStateRef.current = null
      return
    }

    const emitAtBottomState = () => {
      const distanceToBottom =
        scrollerElement.scrollHeight -
        scrollerElement.scrollTop -
        scrollerElement.clientHeight
      const atBottom = distanceToBottom <= atBottomThreshold

      if (lastAtBottomStateRef.current === atBottom) {
        return
      }

      lastAtBottomStateRef.current = atBottom
      onAtBottomStateChange(atBottom)
    }

    emitAtBottomState()

    scrollerElement.addEventListener('scroll', emitAtBottomState, {
      passive: true,
    })

    if (typeof ResizeObserver === 'undefined') {
      return () => {
        scrollerElement.removeEventListener('scroll', emitAtBottomState)
      }
    }

    const observer = new ResizeObserver(() => {
      emitAtBottomState()
    })
    observer.observe(scrollerElement)

    return () => {
      observer.disconnect()
      scrollerElement.removeEventListener('scroll', emitAtBottomState)
    }
  }, [
    atBottomThreshold,
    isVirtualized,
    onAtBottomStateChange,
    scrollerElement,
    timelineSignature,
  ])

  useEffect(() => {
    if (!cacheScope) {
      return
    }

    return () => {
      void flushPersistedTimelineHeightCache({
        app,
        conversationId: cacheScope.conversationId,
        settings,
      })

      if (!isVirtualized) {
        return
      }

      const handle = virtuosoRef.current
      if (!handle) {
        return
      }

      handle.getState((snapshot) => {
        setTimelineStateSnapshot({
          scope: cacheScope,
          timelineSignature,
          snapshot,
        })
      })
    }
  }, [app, cacheScope, isVirtualized, settings, timelineSignature])

  const heightEstimates = useMemo(
    () =>
      items.map((item) => {
        const cachedHeight = cachedHeightByItemId?.get(item.renderKey)
        if (typeof cachedHeight === 'number') {
          return cachedHeight
        }
        return item.estimatedHeight + (item.spacingBefore ?? 0)
      }),
    [cachedHeightByItemId, items],
  )

  const handleRangeChanged = useCallback(
    (range: ListRange) => {
      const heightByItemId: Record<string, number> = {}
      if (cachedHeightByItemId) {
        for (
          let index = range.startIndex;
          index <= range.endIndex;
          index += 1
        ) {
          const item = items[index]
          if (!item) {
            continue
          }
          const cachedHeight = cachedHeightByItemId.get(item.renderKey)
          if (typeof cachedHeight === 'number') {
            heightByItemId[item.renderKey] = cachedHeight
          }
        }
      }

      onRenderStateChange?.({
        visibleStartIndex: range.startIndex,
        visibleEndIndex: range.endIndex,
        heightByItemId,
      })
    },
    [cachedHeightByItemId, items, onRenderStateChange],
  )

  if (!isVirtualized) {
    return (
      <div
        ref={(element) => {
          handleScrollerRef(element)
        }}
        className={scrollContainerClassName}
        style={scrollContainerStyle}
      >
        {items.map((item, index) => (
          <TimelineRow
            key={item.renderKey}
            item={item}
            index={index}
            renderItem={renderItem}
            onMeasuredHeight={handleMeasuredRowHeight}
          />
        ))}
      </div>
    )
  }

  return (
    <Virtuoso
      key={conversationId ?? DEFAULT_TIMELINE_KEY}
      ref={(nextRef) => {
        virtuosoRef.current = nextRef
      }}
      data={items}
      className={scrollContainerClassName}
      style={scrollContainerStyle}
      restoreStateFrom={restoreStateFrom}
      scrollerRef={(element) => {
        handleScrollerRef(element instanceof HTMLElement ? element : null)
      }}
      computeItemKey={(_index, item) => item.renderKey}
      rangeChanged={handleRangeChanged}
      heightEstimates={heightEstimates}
      followOutput={followOutput}
      atBottomThreshold={atBottomThreshold}
      atBottomStateChange={onAtBottomStateChange}
      increaseViewportBy={{
        top: overscanPx,
        bottom: overscanPx,
      }}
      itemContent={(index, item) => (
        <TimelineRow
          item={item}
          index={index}
          renderItem={renderItem}
          onMeasuredHeight={handleMeasuredRowHeight}
        />
      )}
    />
  )
}
