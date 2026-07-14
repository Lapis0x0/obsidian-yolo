import type { CSSProperties, ReactNode, RefObject } from 'react'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { FollowOutput } from 'react-virtuoso'

import type { ChatTimelineItem } from '../../types/chat-timeline'

const DEFAULT_AT_BOTTOM_THRESHOLD = 24
const MIN_LOAD_MORE_THRESHOLD_PX = 240
const MAX_LOAD_MORE_THRESHOLD_PX = 720
const LOAD_MORE_VIEWPORT_RATIO = 0.45
const DEFAULT_TIMELINE_KEY = 'timeline'

export type ChatTimelineRenderContext = {
  mode: 'full'
}

type AnchorSnapshot = {
  messageId: string
  top: number
}

export type UserMessageViewportState = {
  activeMessageId: string | null
  visibleMessageIds: string[]
}

export const getVisibleUserMessageIds = ({
  anchors,
  contentBottom,
  viewportTop,
  viewportBottom,
}: {
  anchors: { messageId: string; top: number }[]
  contentBottom: number
  viewportTop: number
  viewportBottom: number
}): string[] =>
  anchors.flatMap((anchor, index) => {
    const turnBottom = anchors[index + 1]?.top ?? contentBottom
    return anchor.top < viewportBottom && turnBottom > viewportTop
      ? [anchor.messageId]
      : []
  })

type RowProps<TItem extends ChatTimelineItem> = {
  item: TItem
  index: number
  renderItemRef: RefObject<
    (
      item: TItem,
      index: number,
      context?: ChatTimelineRenderContext,
    ) => ReactNode
  >
  renderVersion: unknown
}

export type ChatTimelineRenderVersion<TItem extends ChatTimelineItem> = (
  item: TItem,
  index: number,
) => unknown

function TimelineRowInner<TItem extends ChatTimelineItem>({
  item,
  index,
  renderItemRef,
}: RowProps<TItem>) {
  const renderItem = renderItemRef.current
  if (!renderItem) {
    return null
  }

  return (
    <div
      className={`yolo-chat-timeline-row yolo-chat-timeline-row--${item.kind}`}
      data-timeline-kind={item.kind}
      data-yolo-user-anchor-id={
        item.kind === 'user-message' ? item.messageId : undefined
      }
      style={
        item.spacingBefore ? { paddingTop: item.spacingBefore } : undefined
      }
    >
      {renderItem(item, index, { mode: 'full' })}
    </div>
  )
}

const TimelineRow = memo(TimelineRowInner) as typeof TimelineRowInner

type ChatTimelineListProps<TItem extends ChatTimelineItem> = {
  items: TItem[]
  conversationId?: string
  scrollContainerRef: RefObject<HTMLElement>
  onScrollContainerChange?: (element: HTMLElement | null) => void
  renderItem: (
    item: TItem,
    index: number,
    context?: ChatTimelineRenderContext,
  ) => ReactNode
  renderVersion?: ChatTimelineRenderVersion<TItem>
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
  onUserMessageViewportChange?: (state: UserMessageViewportState) => void
  windowNavigationKey?: number
  windowNavigationTargetMessageId?: string | null
  hasEarlierMessages?: boolean
  hasNewerMessages?: boolean
  onLoadEarlier?: () => void
  onLoadNewer?: () => void
  /**
   * Additional bottom spacer height (px). Used to keep the last item from
   * being visually obscured by an absolute-positioned overlay (e.g. todo
   * panel / queued bubbles) anchored above the input box.
   */
  bottomSpacerHeight?: number
}

function TimelineBottomSpacer({ height }: { height: number }) {
  const safeHeight = Math.max(0, height)
  if (safeHeight === 0) {
    return null
  }

  return (
    <div
      aria-hidden
      className="yolo-chat-timeline-bottom-spacer"
      style={{ height: safeHeight }}
    />
  )
}

function TimelineLoadMoreSentinel({
  elementRef,
}: {
  elementRef?: RefObject<HTMLDivElement>
}) {
  return (
    <div
      ref={elementRef}
      aria-hidden
      className="yolo-chat-history-window-sentinel"
    />
  )
}

function setScrollContainerRef(
  ref: RefObject<HTMLElement>,
  element: HTMLElement | null,
) {
  ;(ref as { current: HTMLElement | null }).current = element
}

const resolveFollowOutput = (
  followOutput: FollowOutput | undefined,
  isAtBottom: boolean,
) => {
  if (typeof followOutput === 'function') {
    return followOutput(isAtBottom)
  }
  return followOutput
}

const scrollElementToBottom = (
  element: HTMLElement,
  behavior: ScrollBehavior = 'auto',
) => {
  const top = Math.max(0, element.scrollHeight - element.clientHeight)
  if (typeof element.scrollTo === 'function') {
    element.scrollTo({ top, behavior })
    return
  }
  element.scrollTop = top
}

const getLoadMoreThreshold = (element: HTMLElement) =>
  Math.min(
    MAX_LOAD_MORE_THRESHOLD_PX,
    Math.max(
      MIN_LOAD_MORE_THRESHOLD_PX,
      Math.round(element.clientHeight * LOAD_MORE_VIEWPORT_RATIO),
    ),
  )

const getVisibleAnchorSnapshot = (
  scrollerElement: HTMLElement,
): AnchorSnapshot | null => {
  const anchors = Array.from(
    scrollerElement.querySelectorAll<HTMLElement>('[data-yolo-user-anchor-id]'),
  )
  if (anchors.length === 0) {
    return null
  }

  const containerTop = scrollerElement.getBoundingClientRect().top
  let selectedAnchor: HTMLElement | null = null
  let selectedDistance = Number.POSITIVE_INFINITY

  for (const anchor of anchors) {
    const anchorTop = anchor.getBoundingClientRect().top
    const distance = Math.abs(anchorTop - containerTop)
    if (distance < selectedDistance) {
      selectedDistance = distance
      selectedAnchor = anchor
    }
  }

  const messageId = selectedAnchor?.dataset.yoloUserAnchorId
  if (!selectedAnchor || !messageId) {
    return null
  }

  return {
    messageId,
    top: selectedAnchor.getBoundingClientRect().top,
  }
}

const getUserMessageViewportState = (
  scrollerElement: HTMLElement,
): UserMessageViewportState => {
  const anchors = Array.from(
    scrollerElement.querySelectorAll<HTMLElement>('[data-yolo-user-anchor-id]'),
  )
  if (anchors.length === 0) {
    return {
      activeMessageId: null,
      visibleMessageIds: [],
    }
  }

  const containerRect = scrollerElement.getBoundingClientRect()
  const containerTop = containerRect.top
  const activationTop = containerTop + 8
  let activeAnchor: HTMLElement | null = null
  let nearestUpcomingAnchor: HTMLElement | null = null
  let nearestUpcomingDistance = Number.POSITIVE_INFINITY
  const anchorRects = anchors.map((anchor) => anchor.getBoundingClientRect())

  for (const [index, anchor] of anchors.entries()) {
    const anchorTop = anchorRects[index].top
    if (anchorTop <= activationTop) {
      activeAnchor = anchor
      continue
    }

    const distance = anchorTop - activationTop
    if (distance < nearestUpcomingDistance) {
      nearestUpcomingDistance = distance
      nearestUpcomingAnchor = anchor
    }
  }

  const selectedAnchor = activeAnchor ?? nearestUpcomingAnchor
  const activeMessageId = selectedAnchor?.dataset.yoloUserAnchorId ?? null
  const timelineRows = scrollerElement.querySelectorAll<HTMLElement>(
    '.yolo-chat-timeline-row',
  )
  const lastTimelineRow = Array.from(timelineRows).at(-1)
  const contentBottom =
    lastTimelineRow?.getBoundingClientRect().bottom ??
    anchorRects.at(-1)?.bottom
  const visibleMessageIds = getVisibleUserMessageIds({
    anchors: anchors.flatMap((anchor, index) => {
      const messageId = anchor.dataset.yoloUserAnchorId
      return messageId ? [{ messageId, top: anchorRects[index].top }] : []
    }),
    contentBottom: contentBottom ?? containerTop,
    viewportTop: containerTop,
    viewportBottom: containerRect.bottom,
  })

  return {
    activeMessageId,
    visibleMessageIds,
  }
}

const getUserAnchorElement = (
  scrollerElement: HTMLElement,
  messageId: string | null | undefined,
): HTMLElement | null => {
  const anchors = Array.from(
    scrollerElement.querySelectorAll<HTMLElement>('[data-yolo-user-anchor-id]'),
  )
  if (anchors.length === 0) {
    return null
  }

  if (!messageId) {
    return anchors[0] ?? null
  }

  return (
    anchors.find((anchor) => anchor.dataset.yoloUserAnchorId === messageId) ??
    null
  )
}

export function ChatTimelineList<TItem extends ChatTimelineItem>({
  items,
  conversationId,
  scrollContainerRef,
  onScrollContainerChange,
  renderItem,
  renderVersion,
  overscanPx,
  virtualizationThreshold,
  forceRenderItemIds,
  onRenderStateChange,
  scrollContainerClassName,
  scrollContainerStyle,
  followOutput,
  atBottomThreshold = DEFAULT_AT_BOTTOM_THRESHOLD,
  onAtBottomStateChange,
  onVirtualizationChange,
  onUserMessageViewportChange,
  windowNavigationKey,
  windowNavigationTargetMessageId,
  hasEarlierMessages = false,
  hasNewerMessages = false,
  onLoadEarlier,
  onLoadNewer,
  bottomSpacerHeight = 0,
}: ChatTimelineListProps<TItem>) {
  void overscanPx
  void virtualizationThreshold
  void forceRenderItemIds
  const [scrollerElement, setScrollerElement] = useState<HTMLElement | null>(
    null,
  )
  const lastAtBottomStateRef = useRef<boolean | null>(null)
  const lastScrollTopRef = useRef<number | null>(null)
  const earlierSentinelRef = useRef<HTMLDivElement>(null)
  const renderItemRef = useRef(renderItem)
  renderItemRef.current = renderItem
  const initialBottomKeyRef = useRef<string | null>(null)
  const pendingAnchorSnapshotRef = useRef<AnchorSnapshot | null>(null)
  const suppressFollowForWindowLoadRef = useRef(false)
  const loadInFlightRef = useRef(false)
  const lastUserMessageViewportRef = useRef<UserMessageViewportState | null>(
    null,
  )
  const userMessageViewportFrameRef = useRef<number | null>(null)
  const appliedWindowNavigationKeyRef = useRef<number | undefined>(undefined)
  const pendingWindowNavigationRef = useRef<{
    key: number
    targetMessageId: string | null | undefined
  } | null>(null)
  const suppressFollowWindowNavigationKeyRef = useRef<number | undefined>(
    undefined,
  )
  const suppressLoadMoreUntilRef = useRef(0)

  useLayoutEffect(() => {
    onVirtualizationChange?.(false)
  }, [onVirtualizationChange])

  const captureAnchorBeforeWindowChange = useCallback(() => {
    if (!scrollerElement) {
      return
    }

    pendingAnchorSnapshotRef.current = getVisibleAnchorSnapshot(scrollerElement)
    suppressFollowForWindowLoadRef.current = true
  }, [scrollerElement])

  const handleLoadEarlier = useCallback(() => {
    if (!onLoadEarlier || loadInFlightRef.current) {
      return
    }

    loadInFlightRef.current = true
    captureAnchorBeforeWindowChange()
    onLoadEarlier()
  }, [captureAnchorBeforeWindowChange, onLoadEarlier])

  const handleLoadNewer = useCallback(() => {
    if (!onLoadNewer || loadInFlightRef.current) {
      return
    }

    loadInFlightRef.current = true
    captureAnchorBeforeWindowChange()
    onLoadNewer()
  }, [captureAnchorBeforeWindowChange, onLoadNewer])

  const emitUserMessageViewport = useCallback(() => {
    if (!onUserMessageViewportChange || !scrollerElement) {
      return
    }

    const nextState = getUserMessageViewportState(scrollerElement)
    const previousState = lastUserMessageViewportRef.current
    if (
      previousState?.activeMessageId === nextState.activeMessageId &&
      previousState.visibleMessageIds.length ===
        nextState.visibleMessageIds.length &&
      previousState.visibleMessageIds.every(
        (messageId, index) => messageId === nextState.visibleMessageIds[index],
      )
    ) {
      return
    }

    lastUserMessageViewportRef.current = nextState
    onUserMessageViewportChange(nextState)
  }, [onUserMessageViewportChange, scrollerElement])

  const scheduleUserMessageViewport = useCallback(() => {
    if (userMessageViewportFrameRef.current !== null) {
      return
    }

    userMessageViewportFrameRef.current = window.requestAnimationFrame(() => {
      userMessageViewportFrameRef.current = null
      emitUserMessageViewport()
    })
  }, [emitUserMessageViewport])

  useEffect(
    () => () => {
      if (userMessageViewportFrameRef.current !== null) {
        window.cancelAnimationFrame(userMessageViewportFrameRef.current)
        userMessageViewportFrameRef.current = null
      }
    },
    [],
  )

  const firstItemRenderKey = items.at(0)?.renderKey
  useEffect(() => {
    const sentinel = earlierSentinelRef.current
    if (
      !scrollerElement ||
      !sentinel ||
      !hasEarlierMessages ||
      !onLoadEarlier
    ) {
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          handleLoadEarlier()
        }
      },
      { root: scrollerElement },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [
    firstItemRenderKey,
    handleLoadEarlier,
    hasEarlierMessages,
    onLoadEarlier,
    scrollerElement,
  ])

  const handleScrollerRef = useCallback(
    (element: HTMLElement | null) => {
      setScrollContainerRef(scrollContainerRef, element)
      onScrollContainerChange?.(element)
      setScrollerElement((previousElement) =>
        previousElement === element ? previousElement : element,
      )
    },
    [onScrollContainerChange, scrollContainerRef],
  )

  useLayoutEffect(() => {
    if (!scrollerElement || items.length === 0) {
      return
    }

    const timelineKey = conversationId ?? DEFAULT_TIMELINE_KEY
    if (initialBottomKeyRef.current === timelineKey) {
      return
    }

    initialBottomKeyRef.current = timelineKey
    scrollElementToBottom(scrollerElement)
    lastScrollTopRef.current = scrollerElement.scrollTop
  }, [conversationId, items.length, scrollerElement])

  useLayoutEffect(() => {
    loadInFlightRef.current = false
    const snapshot = pendingAnchorSnapshotRef.current
    if (!snapshot || !scrollerElement) {
      scheduleUserMessageViewport()
      return
    }

    pendingAnchorSnapshotRef.current = null
    const anchor = scrollerElement.querySelector<HTMLElement>(
      `[data-yolo-user-anchor-id="${snapshot.messageId}"]`,
    )
    if (!anchor) {
      return
    }

    const afterTop = anchor.getBoundingClientRect().top
    scrollerElement.scrollTop += afterTop - snapshot.top
    lastScrollTopRef.current = scrollerElement.scrollTop
    scheduleUserMessageViewport()
  }, [items, scheduleUserMessageViewport, scrollerElement])

  useLayoutEffect(() => {
    if (!scrollerElement || windowNavigationKey === undefined) {
      return
    }

    if (
      appliedWindowNavigationKeyRef.current !== windowNavigationKey &&
      pendingWindowNavigationRef.current?.key !== windowNavigationKey
    ) {
      pendingWindowNavigationRef.current = {
        key: windowNavigationKey,
        targetMessageId: windowNavigationTargetMessageId,
      }
      suppressFollowWindowNavigationKeyRef.current = windowNavigationKey
      suppressLoadMoreUntilRef.current = Date.now() + 300
    }

    const pendingNavigation = pendingWindowNavigationRef.current
    if (!pendingNavigation || pendingNavigation.key !== windowNavigationKey) {
      return
    }

    const targetAnchor = getUserAnchorElement(
      scrollerElement,
      pendingNavigation.targetMessageId,
    )
    if (!targetAnchor) {
      scrollerElement.scrollTop = 0
      lastScrollTopRef.current = scrollerElement.scrollTop
      appliedWindowNavigationKeyRef.current = windowNavigationKey
      pendingWindowNavigationRef.current = null
      scheduleUserMessageViewport()
      return
    }

    const scrollerTop = scrollerElement.getBoundingClientRect().top
    const anchorTop = targetAnchor.getBoundingClientRect().top
    const desiredScrollTop = Math.max(
      0,
      scrollerElement.scrollTop + anchorTop - scrollerTop,
    )
    const maxScrollTop = Math.max(
      0,
      scrollerElement.scrollHeight - scrollerElement.clientHeight,
    )

    scrollerElement.scrollTop = Math.min(desiredScrollTop, maxScrollTop)
    lastScrollTopRef.current = scrollerElement.scrollTop
    appliedWindowNavigationKeyRef.current = windowNavigationKey
    pendingWindowNavigationRef.current = null
    scheduleUserMessageViewport()
  }, [
    items,
    scheduleUserMessageViewport,
    scrollerElement,
    windowNavigationKey,
    windowNavigationTargetMessageId,
  ])

  useLayoutEffect(() => {
    if (!scrollerElement || !followOutput) {
      return
    }
    if (suppressFollowForWindowLoadRef.current) {
      suppressFollowForWindowLoadRef.current = false
      return
    }
    if (
      windowNavigationKey !== undefined &&
      suppressFollowWindowNavigationKeyRef.current === windowNavigationKey
    ) {
      suppressFollowWindowNavigationKeyRef.current = undefined
      return
    }

    const distanceToBottom =
      scrollerElement.scrollHeight -
      scrollerElement.scrollTop -
      scrollerElement.clientHeight
    const isAtBottom = distanceToBottom <= atBottomThreshold
    const output = resolveFollowOutput(followOutput, isAtBottom)
    if (output === false) {
      return
    }

    scrollElementToBottom(
      scrollerElement,
      output === 'smooth' ? 'smooth' : 'auto',
    )
    lastScrollTopRef.current = scrollerElement.scrollTop
  }, [
    atBottomThreshold,
    bottomSpacerHeight,
    followOutput,
    items,
    scrollerElement,
    windowNavigationKey,
  ])

  useEffect(() => {
    if (!scrollerElement) {
      lastAtBottomStateRef.current = null
      return
    }

    const emitAtBottomState = () => {
      if (!onAtBottomStateChange) {
        return
      }

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

    const handleScroll = () => {
      const previousScrollTop = lastScrollTopRef.current
      const currentScrollTop = scrollerElement.scrollTop
      lastScrollTopRef.current = currentScrollTop
      const isScrollingTowardNewer =
        previousScrollTop !== null && currentScrollTop > previousScrollTop

      emitAtBottomState()
      scheduleUserMessageViewport()
      if (Date.now() < suppressLoadMoreUntilRef.current) {
        return
      }

      const distanceToBottom =
        scrollerElement.scrollHeight -
        scrollerElement.scrollTop -
        scrollerElement.clientHeight
      const loadMoreThreshold = getLoadMoreThreshold(scrollerElement)
      if (
        hasNewerMessages &&
        onLoadNewer &&
        isScrollingTowardNewer &&
        distanceToBottom <= loadMoreThreshold
      ) {
        handleLoadNewer()
      }
    }

    scrollerElement.addEventListener('scroll', handleScroll, {
      passive: true,
    })
    lastScrollTopRef.current = scrollerElement.scrollTop
    emitAtBottomState()
    scheduleUserMessageViewport()

    if (typeof ResizeObserver === 'undefined') {
      return () => {
        scrollerElement.removeEventListener('scroll', handleScroll)
      }
    }

    const observer = new ResizeObserver(() => {
      emitAtBottomState()
      scheduleUserMessageViewport()
    })
    observer.observe(scrollerElement)

    return () => {
      observer.disconnect()
      scrollerElement.removeEventListener('scroll', handleScroll)
    }
  }, [
    atBottomThreshold,
    handleLoadNewer,
    hasNewerMessages,
    onAtBottomStateChange,
    onLoadNewer,
    scheduleUserMessageViewport,
    scrollerElement,
  ])

  useEffect(() => {
    if (!onRenderStateChange) {
      return
    }

    onRenderStateChange({
      visibleStartIndex: items.length > 0 ? 0 : -1,
      visibleEndIndex: items.length - 1,
      heightByItemId: {},
    })
  }, [items.length, onRenderStateChange])

  const safeSpacerHeight = Math.max(0, Math.ceil(bottomSpacerHeight))
  const resolveRenderVersion = useCallback(
    (item: TItem, index: number) => {
      return renderVersion ? renderVersion(item, index) : 0
    },
    [renderVersion],
  )

  return (
    <div
      ref={(element) => {
        handleScrollerRef(element)
      }}
      className={scrollContainerClassName}
      style={scrollContainerStyle}
    >
      {hasEarlierMessages && onLoadEarlier ? (
        <TimelineLoadMoreSentinel elementRef={earlierSentinelRef} />
      ) : null}
      {items.map((item, index) => (
        <TimelineRow
          key={item.renderKey}
          item={item}
          index={index}
          renderItemRef={renderItemRef}
          renderVersion={resolveRenderVersion(item, index)}
        />
      ))}
      <TimelineBottomSpacer height={safeSpacerHeight} />
    </div>
  )
}
