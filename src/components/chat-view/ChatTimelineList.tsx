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
import { getNodeWindow } from '../../utils/dom/window-context'

import type { PagingDirection } from './scroll/paging'
import {
  getRetainedAnchorIndex,
  getScrollPagingDirection,
  getTouchPagingDirection,
  getWheelPagingDirection,
  isPagingInputClaimedByNestedScroller,
  resolvePagingLoad,
} from './scroll/paging'
import type { ScrollController } from './scroll/scrollController'
import { PAGE_TURNS } from './useChatHistoryWindow'

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
   * Enlarge the window without moving either of its edges' contents. Only
   * called when the rendered window is too short to produce a scroll range,
   * which is the one situation the scroll-driven paging above cannot resolve.
   */
  onGrowWindowToFillViewport?: () => void
  /**
   * Identity of the rendered turn range, from `useChatHistoryWindow`. Used to
   * tell "the page I asked for has arrived" from "the items changed", which
   * during streaming they do constantly without the window moving at all.
   */
  historyWindowKey?: string
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

function setScrollContainerRef(
  ref: RefObject<HTMLElement>,
  element: HTMLElement | null,
) {
  ;(ref as { current: HTMLElement | null }).current = element
}

/**
 * `Event.target` as an element, without `instanceof`: in an Obsidian popout
 * the node belongs to another document whose constructors are not this realm's.
 */
const getEventElement = (event: Event): Element | null => {
  const target = event.target
  return target && 'tagName' in target ? (target as Element) : null
}

const SCROLLABLE_OVERFLOW_Y = new Set(['auto', 'scroll', 'overlay'])

/**
 * Whether this element actually scrolls, as opposed to merely overflowing its
 * box. Resolved against the element's own view so it stays correct in a
 * popout, where the global `window` belongs to a different document.
 */
const isScrollableElement = (element: Element): boolean => {
  const view = element.ownerDocument.defaultView
  const overflowY = view?.getComputedStyle(element).overflowY
  return overflowY !== undefined && SCROLLABLE_OVERFLOW_Y.has(overflowY)
}

const getLoadMoreThreshold = (element: HTMLElement) =>
  Math.min(
    MAX_LOAD_MORE_THRESHOLD_PX,
    Math.max(
      MIN_LOAD_MORE_THRESHOLD_PX,
      Math.round(element.clientHeight * LOAD_MORE_VIEWPORT_RATIO),
    ),
  )

/**
 * Picks the turn whose position the viewport should be held against across a
 * window change.
 *
 * Nearest to the top of the viewport is the natural choice — it is what the
 * reader is looking at — but for a paging load it is not always a *safe* one.
 * A window that is already at its maximum size slides rather than grows, and a
 * slide only keeps `PAGE_TURNS` turns adjacent to the edge being loaded. With
 * short turns the viewport can easily span more than that, so the anchor
 * nearest the top may be one of the turns about to be unmounted; the restore
 * then finds nothing, skips compensation, and the whole list jumps.
 *
 * Passing the direction being loaded clamps the choice into the turns that
 * change provably keeps, picking the closest safe one rather than the closest
 * one. `null` means the window is only growing, where every turn survives.
 */
const getVisibleAnchorSnapshot = (
  scrollerElement: HTMLElement,
  retainedTurnsDirection: PagingDirection | null,
): AnchorSnapshot | null => {
  const anchors = Array.from(
    scrollerElement.querySelectorAll<HTMLElement>('[data-yolo-user-anchor-id]'),
  )
  if (anchors.length === 0) {
    return null
  }

  const containerTop = scrollerElement.getBoundingClientRect().top
  let selectedIndex = 0
  let selectedDistance = Number.POSITIVE_INFINITY

  anchors.forEach((anchor, index) => {
    const distance = Math.abs(anchor.getBoundingClientRect().top - containerTop)
    if (distance < selectedDistance) {
      selectedDistance = distance
      selectedIndex = index
    }
  })

  const selectedAnchor =
    anchors[
      getRetainedAnchorIndex(
        selectedIndex,
        anchors.length,
        retainedTurnsDirection,
        PAGE_TURNS,
      )
    ]
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
  onGrowWindowToFillViewport,
  historyWindowKey,
  bottomSpacerHeight = 0,
}: ChatTimelineListProps<TItem>) {
  void overscanPx
  void virtualizationThreshold
  void forceRenderItemIds
  const [scrollerElement, setScrollerElement] = useState<HTMLElement | null>(
    null,
  )
  const renderItemRef = useRef(renderItem)
  renderItemRef.current = renderItem
  const pendingAnchorSnapshotRef = useRef<AnchorSnapshot | null>(null)
  // The window on screen, and the window a paging load has already been fired
  // against. React commits the window a load asks for in a later task, so
  // without this a single wheel gesture at 60Hz fires several loads into the
  // gap before the first one lands — and two window transforms applied to one
  // commit can leave a window with no turn in common with the DOM the anchor
  // was captured from, which is exactly the jump the anchor exists to prevent.
  //
  // Keyed on the window rather than on `items`: `items` is rebuilt for every
  // streaming token, revision and edit, so a commit that changed nothing about
  // the window would release the gate on a load that had not landed yet.
  //
  // Tracked from a layout effect rather than during render because a
  // concurrent render can be interrupted or thrown away, and a render-phase
  // write would hand the already-committed listeners a window that never
  // reached the DOM.
  //
  // Clearing takes care of itself: the requested window arriving stops the two
  // matching, and while the window is unchanged there is nothing new to page to.
  const committedWindowKeyRef = useRef<string | undefined>(undefined)
  const pagedForWindowKeyRef = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    committedWindowKeyRef.current = historyWindowKey
  }, [historyWindowKey])
  // Scrollbar drags produce no directional input event of their own, so their
  // direction is read from the resulting scroll position — but only while a
  // pointer is actually held down on the scroller, which is what makes that
  // reading attributable to the reader rather than to the scroll controller or
  // to content reflowing.
  const isPointerDownRef = useRef(false)
  const lastScrollTopRef = useRef<number | null>(null)
  const lastTouchClientYRef = useRef<number | null>(null)
  const lastUserMessageViewportRef = useRef<UserMessageViewportState | null>(
    null,
  )
  // rAF 句柄归发起它的窗口所有：popout 是独立 BrowserWindow，用全局 rAF 驱动
  // 滚动视口上报会被主窗口的可见性节流，且句柄也不能跨窗口取消。
  const userMessageViewportFrameRef = useRef<{
    window: Window & typeof globalThis
    id: number
  } | null>(null)
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

  const captureAnchorBeforeWindowChange = useCallback(
    (retainedTurnsDirection: PagingDirection | null) => {
      if (!scrollerElement) {
        return
      }

      pendingAnchorSnapshotRef.current = getVisibleAnchorSnapshot(
        scrollerElement,
        retainedTurnsDirection,
      )
    },
    [scrollerElement],
  )

  const handleLoadEarlier = useCallback(() => {
    if (!onLoadEarlier) {
      return
    }

    captureAnchorBeforeWindowChange('earlier')
    onLoadEarlier()
  }, [captureAnchorBeforeWindowChange, onLoadEarlier])

  const handleLoadNewer = useCallback(() => {
    if (!onLoadNewer) {
      return
    }

    captureAnchorBeforeWindowChange('newer')
    onLoadNewer()
  }, [captureAnchorBeforeWindowChange, onLoadNewer])

  // Both paging triggers are driven by scrolling, which a window that fits
  // inside the viewport can never produce: there is no scroll event and both
  // edge distances sit at 0 forever. Enlarging the window is the only way out.
  //
  // It has to *grow* rather than page: `onLoadEarlier` slides the window off
  // the live edge once it is full, and with no scroll range there is no way
  // back, so paging here would walk the reader to the oldest turns and strand
  // them. Growing keeps every currently rendered turn rendered, so the live
  // edge stays visible and the reader never moves; the anchor snapshot keeps
  // the viewport steady once the added turns finally make the content
  // overflow.
  const growWindowIfViewportNotFilled = useCallback(() => {
    if (
      !scrollerElement ||
      !hasEarlierMessages ||
      !onGrowWindowToFillViewport ||
      scrollerElement.scrollHeight > scrollerElement.clientHeight
    ) {
      return
    }

    captureAnchorBeforeWindowChange(null)
    onGrowWindowToFillViewport()
  }, [
    captureAnchorBeforeWindowChange,
    hasEarlierMessages,
    onGrowWindowToFillViewport,
    scrollerElement,
  ])

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

    const ownerWindow = getNodeWindow(scrollerElement)
    userMessageViewportFrameRef.current = {
      window: ownerWindow,
      id: ownerWindow.requestAnimationFrame(() => {
        userMessageViewportFrameRef.current = null
        emitUserMessageViewport()
      }),
    }
  }, [emitUserMessageViewport, scrollerElement])

  useEffect(
    () => () => {
      const pendingFrame = userMessageViewportFrameRef.current
      if (pendingFrame !== null) {
        pendingFrame.window.cancelAnimationFrame(pendingFrame.id)
        userMessageViewportFrameRef.current = null
      }
    },
    [],
  )

  // Watches both sides of the "does the window fill the viewport" question:
  // the content growing/shrinking and the viewport itself resizing. Measuring
  // from a ResizeObserver rather than a post-commit effect keeps these reads
  // on layout the browser has already computed, so streaming never pays a
  // forced reflow for them. Observing also fires once, which covers the
  // initial state.
  useEffect(() => {
    if (!scrollerElement) {
      return
    }
    // Popouts are separate BrowserWindows: the global `ResizeObserver` belongs
    // to the main window and would observe an element from another realm.
    const ObserverCtor = getNodeWindow(scrollerElement).ResizeObserver
    if (typeof ObserverCtor === 'undefined') {
      return
    }

    const observer = new ObserverCtor(() => {
      growWindowIfViewportNotFilled()
    })
    observer.observe(scrollerElement)
    const contentElement = contentElementRef.current
    if (contentElement) {
      observer.observe(contentElement)
    }

    return () => observer.disconnect()
  }, [growWindowIfViewportNotFilled, scrollerElement])

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
    // A jump replaces the reader's position outright, so any anchor-preserving
    // correction still in flight is now describing a position nobody asked to
    // keep. The controller ranks the jump higher, but only for as long as the
    // jump itself is alive: once it settles the stale correction would take
    // over and pull the viewport back off the target.
    pendingAnchorSnapshotRef.current = null
    scrollController?.cancelPreserveAnchor()

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

    // Every paging load starts here, from an input event that carries its own
    // direction. Position is only ever a gate ("are they near that edge?"),
    // never the evidence of intent.
    //
    // The order of the checks is load-bearing for performance, not just
    // readability: the free ones come first so that scrolling in a direction
    // with nothing left to load — the overwhelmingly common case, and the one
    // that runs at wheel frequency during streaming — never reads layout at
    // all. Only an input that could actually page pays for measuring.
    const requestPaging = (
      direction: PagingDirection,
      target: Element | null,
    ) => {
      const hasMore =
        direction === 'earlier'
          ? hasEarlierMessages && Boolean(onLoadEarlier)
          : hasNewerMessages && Boolean(onLoadNewer)
      const isBusy =
        (scrollController?.isSettling() ?? false) ||
        (pagedForWindowKeyRef.current !== undefined &&
          pagedForWindowKeyRef.current === committedWindowKeyRef.current)
      if (!hasMore || isBusy) {
        return
      }

      const maxDistance = Math.max(
        0,
        scrollerElement.scrollHeight - scrollerElement.clientHeight,
      )
      const distanceToTop = Math.min(
        Math.max(0, scrollerElement.scrollTop),
        maxDistance,
      )
      const load = resolvePagingLoad({
        direction,
        distanceToTop,
        distanceToBottom: maxDistance - distanceToTop,
        threshold: getLoadMoreThreshold(scrollerElement),
        hasEarlierMessages: hasEarlierMessages && Boolean(onLoadEarlier),
        hasNewerMessages: hasNewerMessages && Boolean(onLoadNewer),
        isBusy,
      })
      if (
        !load ||
        isPagingInputClaimedByNestedScroller(
          target,
          scrollerElement,
          direction,
          isScrollableElement,
        )
      ) {
        return
      }

      pagedForWindowKeyRef.current = committedWindowKeyRef.current
      if (load === 'earlier') {
        handleLoadEarlier()
      } else {
        handleLoadNewer()
      }
    }

    const handleScroll = () => {
      const previousScrollTop = lastScrollTopRef.current
      lastScrollTopRef.current = scrollerElement.scrollTop
      scheduleUserMessageViewport()

      // Wheel and touch have already reported their own direction by the time
      // the resulting scroll event arrives, so the only thing left for this
      // one to contribute is a scrollbar drag — the sole way to scroll that
      // produces no directional input event of its own.
      if (!isPointerDownRef.current || previousScrollTop === null) {
        return
      }

      const direction = getScrollPagingDirection(
        previousScrollTop,
        scrollerElement.scrollTop,
      )
      if (direction) {
        // A scrollbar drag moves this scroller and nothing else, so there is
        // no nested region that could have claimed it.
        requestPaging(direction, null)
      }
    }

    const handleWheel = (event: WheelEvent) => {
      const direction = getWheelPagingDirection(event.deltaY)
      if (direction) {
        requestPaging(direction, getEventElement(event))
      }
    }

    const handleTouchStart = (event: TouchEvent) => {
      lastTouchClientYRef.current = event.touches[0]?.clientY ?? null
    }

    const handleTouchMove = (event: TouchEvent) => {
      const clientY = event.touches[0]?.clientY
      if (clientY === undefined) {
        return
      }

      const previousClientY = lastTouchClientYRef.current
      lastTouchClientYRef.current = clientY
      if (previousClientY === null) {
        return
      }

      const direction = getTouchPagingDirection(previousClientY, clientY)
      if (direction) {
        requestPaging(direction, getEventElement(event))
      }
    }

    // Only a press that lands on the scroller *itself* — its scrollbar or its
    // own padding — can be a scrollbar drag. A press on content is a text
    // selection or a button, and letting those open the gate would hand the
    // scroll-position path back to reflow and to the controller's own writes,
    // which is exactly what reading direction off input events avoids.
    const handlePointerDown = (event: PointerEvent) => {
      isPointerDownRef.current = event.target === scrollerElement
    }

    const handlePointerUp = () => {
      isPointerDownRef.current = false
    }

    const passive = { passive: true } as const
    // The release lands on whichever document owns the scroller, which in a
    // popout is not the global one. A release the drag never hears about —
    // outside the element, or in another application after the window loses
    // focus — would latch the gate open and hand every later reflow and
    // controller write back to the scroll-position path, so the window's own
    // `blur` releases it too.
    const ownerDocument = scrollerElement.ownerDocument
    const ownerWindow = ownerDocument.defaultView
    lastScrollTopRef.current = scrollerElement.scrollTop
    scrollerElement.addEventListener('scroll', handleScroll, passive)
    scrollerElement.addEventListener('wheel', handleWheel, passive)
    scrollerElement.addEventListener('touchstart', handleTouchStart, passive)
    scrollerElement.addEventListener('touchmove', handleTouchMove, passive)
    scrollerElement.addEventListener('pointerdown', handlePointerDown, passive)
    ownerDocument.addEventListener('pointerup', handlePointerUp, passive)
    ownerDocument.addEventListener('pointercancel', handlePointerUp, passive)
    ownerWindow?.addEventListener('blur', handlePointerUp, passive)
    scheduleUserMessageViewport()

    const removeListeners = () => {
      scrollerElement.removeEventListener('scroll', handleScroll)
      scrollerElement.removeEventListener('wheel', handleWheel)
      scrollerElement.removeEventListener('touchstart', handleTouchStart)
      scrollerElement.removeEventListener('touchmove', handleTouchMove)
      scrollerElement.removeEventListener('pointerdown', handlePointerDown)
      ownerDocument.removeEventListener('pointerup', handlePointerUp)
      ownerDocument.removeEventListener('pointercancel', handlePointerUp)
      ownerWindow?.removeEventListener('blur', handlePointerUp)
      isPointerDownRef.current = false
    }

    // Same realm caveat as the viewport-fill observer above.
    const ObserverCtor = ownerWindow?.ResizeObserver
    if (typeof ObserverCtor === 'undefined') {
      return removeListeners
    }

    const observer = new ObserverCtor(() => {
      scheduleUserMessageViewport()
    })
    observer.observe(scrollerElement)

    return () => {
      observer.disconnect()
      removeListeners()
    }
  }, [
    handleLoadEarlier,
    handleLoadNewer,
    hasEarlierMessages,
    hasNewerMessages,
    onLoadEarlier,
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
