import type { CSSProperties, ReactNode, RefObject } from 'react'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import type { ChatTimelineItem } from '../../types/chat-timeline'

import type { ScrollController } from './scroll/scrollController'

const MIN_LOAD_MORE_THRESHOLD_PX = 240
const MAX_LOAD_MORE_THRESHOLD_PX = 720
const LOAD_MORE_VIEWPORT_RATIO = 0.45

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
  animateEnter: boolean
}

export type ChatTimelineRenderVersion<TItem extends ChatTimelineItem> = (
  item: TItem,
  index: number,
) => unknown

function TimelineRowInner<TItem extends ChatTimelineItem>({
  item,
  index,
  renderItemRef,
  animateEnter,
}: RowProps<TItem>) {
  const renderItem = renderItemRef.current
  if (!renderItem) {
    return null
  }

  return (
    <div
      className={`yolo-chat-timeline-row yolo-chat-timeline-row--${item.kind}${
        animateEnter ? ' yolo-chat-timeline-row--enter' : ''
      }`}
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
  onBottomSentinelChange?: (element: HTMLElement | null) => void
  /**
   * Shared scroll arbiter. When omitted (e.g. QuickAskPanel, which never
   * enables history-window paging or windowNavigation), anchor-preserve and
   * jump intents are simply not submitted — the caller keeps the identical
   * live-edge-only behavior it had before this existed.
   */
  scrollController?: ScrollController
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

function TimelineBottomSentinel({
  elementRef,
}: {
  elementRef?: (element: HTMLDivElement | null) => void
}) {
  return (
    <div
      ref={elementRef}
      aria-hidden
      className="yolo-chat-live-edge-sentinel"
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
  onBottomSentinelChange,
  scrollController,
  renderItem,
  renderVersion,
  overscanPx,
  virtualizationThreshold,
  forceRenderItemIds,
  onRenderStateChange,
  scrollContainerClassName,
  scrollContainerStyle,
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
  const lastScrollTopRef = useRef<number | null>(null)
  const earlierSentinelRef = useRef<HTMLDivElement>(null)
  const renderItemRef = useRef(renderItem)
  renderItemRef.current = renderItem
  const pendingAnchorSnapshotRef = useRef<AnchorSnapshot | null>(null)
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
  const contentElementRef = useRef<HTMLDivElement | null>(null)

  // New-message enter animation bookkeeping. `seenIdsRef` and the
  // conversation/window keys below are only ever written post-commit (in
  // the effect further down) so the judgment made during render stays pure
  // and safe under StrictMode's double-invoke. `enterKeysRef` is a sticky
  // memo cache keyed by renderKey: once a row is judged true or false it
  // keeps that verdict for as long as it stays mounted, so a mid-stream
  // re-render can never strip the class out from under a row whose 220ms
  // entrance animation is still playing.
  const seenIdsRef = useRef<Set<string>>(new Set())
  const enterKeysRef = useRef<Map<string, boolean>>(new Map())
  const isInitializedRef = useRef(false)
  const conversationKeyRef = useRef<string | undefined>(undefined)
  const windowNavigationKeyRef = useRef<number | undefined>(undefined)

  useLayoutEffect(() => {
    onVirtualizationChange?.(false)
  }, [onVirtualizationChange])

  const captureAnchorBeforeWindowChange = useCallback(() => {
    if (!scrollerElement) {
      return
    }

    pendingAnchorSnapshotRef.current = getVisibleAnchorSnapshot(scrollerElement)
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

    // Re-queries the anchor (rather than closing over the node above) so
    // the resolver stays correct across the settlement window's repeated
    // calls, in case ObsidianMarkdown's async second-pass layout is part of
    // a re-render that swaps the DOM node.
    scrollController?.submitPreserveAnchor(() => {
      const currentAnchor = scrollerElement.querySelector<HTMLElement>(
        `[data-yolo-user-anchor-id="${snapshot.messageId}"]`,
      )
      if (!currentAnchor) {
        return null
      }
      const afterTop = currentAnchor.getBoundingClientRect().top
      return scrollerElement.scrollTop + (afterTop - snapshot.top)
    }, contentElementRef.current)
    scheduleUserMessageViewport()
  }, [items, scheduleUserMessageViewport, scrollController, scrollerElement])

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
    }

    const pendingNavigation = pendingWindowNavigationRef.current
    if (!pendingNavigation || pendingNavigation.key !== windowNavigationKey) {
      return
    }

    const targetMessageId = pendingNavigation.targetMessageId
    appliedWindowNavigationKeyRef.current = windowNavigationKey
    pendingWindowNavigationRef.current = null

    scrollController?.submitJumpToMessage(() => {
      const targetAnchor = getUserAnchorElement(
        scrollerElement,
        targetMessageId,
      )
      if (!targetAnchor) {
        return 0
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
      return Math.min(desiredScrollTop, maxScrollTop)
    }, contentElementRef.current)
    scheduleUserMessageViewport()
  }, [
    items,
    scheduleUserMessageViewport,
    scrollController,
    scrollerElement,
    windowNavigationKey,
    windowNavigationTargetMessageId,
  ])

  useEffect(() => {
    if (!scrollerElement) {
      return
    }

    const handleScroll = () => {
      const previousScrollTop = lastScrollTopRef.current
      const currentScrollTop = scrollerElement.scrollTop
      lastScrollTopRef.current = currentScrollTop
      const isScrollingTowardNewer =
        previousScrollTop !== null && currentScrollTop > previousScrollTop

      scheduleUserMessageViewport()
      if (scrollController?.isSettling()) {
        // A jumpToMessage/preserveAnchor intent is still correcting scroll
        // position; its own writes must not be misread as the user
        // scrolling toward newer messages and trigger another page load.
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
    scheduleUserMessageViewport()

    if (typeof ResizeObserver === 'undefined') {
      return () => {
        scrollerElement.removeEventListener('scroll', handleScroll)
      }
    }

    const observer = new ResizeObserver(() => {
      scheduleUserMessageViewport()
    })
    observer.observe(scrollerElement)

    return () => {
      observer.disconnect()
      scrollerElement.removeEventListener('scroll', handleScroll)
    }
  }, [
    handleLoadNewer,
    hasNewerMessages,
    onLoadNewer,
    scheduleUserMessageViewport,
    scrollController,
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

  // Post-commit bookkeeping for the enter-animation judgment below: mark
  // this render's items as seen, record the conversation/window keys we
  // judged against, and drop cache entries for rows that unmounted. Doing
  // this in an effect (rather than during render) is what keeps the
  // judgment above pure under StrictMode's double-invoke.
  useEffect(() => {
    isInitializedRef.current = true
    conversationKeyRef.current = conversationId
    windowNavigationKeyRef.current = windowNavigationKey
    const currentRenderKeys = new Set<string>()
    for (const item of items) {
      seenIdsRef.current.add(item.id)
      currentRenderKeys.add(item.renderKey)
    }
    for (const renderKey of enterKeysRef.current.keys()) {
      if (!currentRenderKeys.has(renderKey)) {
        enterKeysRef.current.delete(renderKey)
      }
    }
  }, [items, conversationId, windowNavigationKey])

  // Enter-animation judgment (pure, render-time). A reset round — first
  // render, a conversation switch, or a windowNavigation jump — never
  // animates anything. Otherwise, only unseen items at or after the active
  // edge (the first already-seen item) animate, and never while
  // hasNewerMessages is true (that append is backfilled history, not a
  // live new message) or for the invisible bottom-anchor row. Verdicts are
  // memoized per renderKey in `enterKeysRef` so a mid-stream re-render can
  // never flip a row's class mid-animation.
  const isTimelineResetRound =
    !isInitializedRef.current ||
    conversationKeyRef.current !== conversationId ||
    windowNavigationKeyRef.current !== windowNavigationKey
  const firstSeenItemIndex = isTimelineResetRound
    ? -1
    : items.findIndex((item) => seenIdsRef.current.has(item.id))
  const animateEnterByRenderKey = new Map<string, boolean>()
  for (const [index, item] of items.entries()) {
    const cachedVerdict = enterKeysRef.current.get(item.renderKey)
    if (cachedVerdict !== undefined) {
      animateEnterByRenderKey.set(item.renderKey, cachedVerdict)
      continue
    }
    const shouldAnimateEnter =
      !isTimelineResetRound &&
      firstSeenItemIndex !== -1 &&
      index >= firstSeenItemIndex &&
      !hasNewerMessages &&
      item.kind !== 'bottom-anchor' &&
      !seenIdsRef.current.has(item.id)
    enterKeysRef.current.set(item.renderKey, shouldAnimateEnter)
    animateEnterByRenderKey.set(item.renderKey, shouldAnimateEnter)
  }

  const safeSpacerHeight = Math.max(0, Math.ceil(bottomSpacerHeight))
  const resolveRenderVersion = useCallback(
    (item: TItem, index: number) => {
      return renderVersion ? renderVersion(item, index) : 0
    },
    [renderVersion],
  )

  return (
    <div
      ref={handleScrollerRef}
      className={scrollContainerClassName}
      style={scrollContainerStyle}
    >
      <div ref={contentElementRef} className="yolo-chat-timeline-content">
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
            animateEnter={animateEnterByRenderKey.get(item.renderKey) ?? false}
          />
        ))}
        <TimelineBottomSpacer height={safeSpacerHeight} />
        <TimelineBottomSentinel elementRef={onBottomSentinelChange} />
      </div>
    </div>
  )
}
