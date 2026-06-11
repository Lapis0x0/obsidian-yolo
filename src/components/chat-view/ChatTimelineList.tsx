import type { CSSProperties, KeyboardEvent, ReactNode, RefObject } from 'react'
import {
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

type RowProps<TItem extends ChatTimelineItem> = {
  item: TItem
  index: number
  renderItem: (
    item: TItem,
    index: number,
    context?: ChatTimelineRenderContext,
  ) => ReactNode
}

function TimelineRow<TItem extends ChatTimelineItem>({
  item,
  index,
  renderItem,
}: RowProps<TItem>) {
  return (
    <div
      className={`yolo-chat-timeline-row yolo-chat-timeline-row--${item.kind}`}
      data-timeline-kind={item.kind}
      data-yolo-user-anchor-id={
        item.kind === 'user-message' ? item.message.id : undefined
      }
      style={
        item.spacingBefore ? { paddingTop: item.spacingBefore } : undefined
      }
    >
      {renderItem(item, index, { mode: 'full' })}
    </div>
  )
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

function TimelineLoadMoreButton({
  label,
  onClick,
}: {
  label: string
  onClick: () => void
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }

    event.preventDefault()
    onClick()
  }

  return (
    <div className="yolo-chat-history-window-sentinel">
      <div
        role="button"
        tabIndex={0}
        className="yolo-chat-history-window-sentinel__button"
        onClick={onClick}
        onKeyDown={handleKeyDown}
      >
        <span>{label}</span>
        <span className="yolo-chat-history-window-sentinel__dots" aria-hidden>
          <span>.</span>
          <span>.</span>
          <span>.</span>
        </span>
      </div>
    </div>
  )
}

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
  onActiveUserMessageChange?: (messageId: string | null) => void
  windowNavigationKey?: number
  hasEarlierMessages?: boolean
  hasNewerMessages?: boolean
  onLoadEarlier?: () => void
  onLoadNewer?: () => void
  loadEarlierLabel?: string
  loadNewerLabel?: string
  /**
   * Additional bottom spacer height (px). Used to keep the last item from
   * being visually obscured by an absolute-positioned overlay (e.g. todo
   * panel / queued bubbles) anchored above the input box.
   */
  bottomSpacerHeight?: number
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

const getActiveUserAnchorSnapshot = (
  scrollerElement: HTMLElement,
): AnchorSnapshot | null => {
  const anchors = Array.from(
    scrollerElement.querySelectorAll<HTMLElement>('[data-yolo-user-anchor-id]'),
  )
  if (anchors.length === 0) {
    return null
  }

  const containerTop = scrollerElement.getBoundingClientRect().top
  const activationTop = containerTop + 8
  let activeAnchor: HTMLElement | null = null
  let nearestUpcomingAnchor: HTMLElement | null = null
  let nearestUpcomingDistance = Number.POSITIVE_INFINITY

  for (const anchor of anchors) {
    const anchorTop = anchor.getBoundingClientRect().top
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
  const messageId = selectedAnchor?.dataset.yoloUserAnchorId
  if (!selectedAnchor || !messageId) {
    return null
  }

  return {
    messageId,
    top: selectedAnchor.getBoundingClientRect().top,
  }
}

export function ChatTimelineList<TItem extends ChatTimelineItem>({
  items,
  conversationId,
  scrollContainerRef,
  onScrollContainerChange,
  renderItem,
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
  onActiveUserMessageChange,
  windowNavigationKey,
  hasEarlierMessages = false,
  hasNewerMessages = false,
  onLoadEarlier,
  onLoadNewer,
  loadEarlierLabel = 'Load earlier messages',
  loadNewerLabel = 'Load newer messages',
  bottomSpacerHeight = 0,
}: ChatTimelineListProps<TItem>) {
  void overscanPx
  void virtualizationThreshold
  void forceRenderItemIds
  const [scrollerElement, setScrollerElement] = useState<HTMLElement | null>(
    null,
  )
  const lastAtBottomStateRef = useRef<boolean | null>(null)
  const initialBottomKeyRef = useRef<string | null>(null)
  const pendingAnchorSnapshotRef = useRef<AnchorSnapshot | null>(null)
  const loadInFlightRef = useRef(false)
  const lastActiveUserMessageIdRef = useRef<string | null>(null)
  const appliedWindowNavigationKeyRef = useRef<number | undefined>(undefined)
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

  const emitActiveUserMessage = useCallback(() => {
    if (!onActiveUserMessageChange || !scrollerElement) {
      return
    }

    const activeMessageId =
      getActiveUserAnchorSnapshot(scrollerElement)?.messageId ?? null
    if (lastActiveUserMessageIdRef.current === activeMessageId) {
      return
    }

    lastActiveUserMessageIdRef.current = activeMessageId
    onActiveUserMessageChange(activeMessageId)
  }, [onActiveUserMessageChange, scrollerElement])

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
  }, [conversationId, items.length, scrollerElement])

  useLayoutEffect(() => {
    loadInFlightRef.current = false
    const snapshot = pendingAnchorSnapshotRef.current
    if (!snapshot || !scrollerElement) {
      emitActiveUserMessage()
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
    emitActiveUserMessage()
  }, [emitActiveUserMessage, items, scrollerElement])

  useLayoutEffect(() => {
    if (
      !scrollerElement ||
      windowNavigationKey === undefined ||
      appliedWindowNavigationKeyRef.current === windowNavigationKey
    ) {
      return
    }

    appliedWindowNavigationKeyRef.current = windowNavigationKey
    suppressFollowWindowNavigationKeyRef.current = windowNavigationKey
    suppressLoadMoreUntilRef.current = Date.now() + 300

    const firstUserAnchor = scrollerElement.querySelector<HTMLElement>(
      '[data-yolo-user-anchor-id]',
    )
    if (firstUserAnchor) {
      const scrollerTop = scrollerElement.getBoundingClientRect().top
      const anchorTop = firstUserAnchor.getBoundingClientRect().top
      scrollerElement.scrollTop = Math.max(
        0,
        scrollerElement.scrollTop + anchorTop - scrollerTop,
      )
    } else {
      scrollerElement.scrollTop = 0
    }

    emitActiveUserMessage()
  }, [emitActiveUserMessage, items, scrollerElement, windowNavigationKey])

  useLayoutEffect(() => {
    if (!scrollerElement || !followOutput) {
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
      emitAtBottomState()
      emitActiveUserMessage()
      if (Date.now() < suppressLoadMoreUntilRef.current) {
        return
      }

      const loadMoreThreshold = getLoadMoreThreshold(scrollerElement)

      if (
        hasEarlierMessages &&
        onLoadEarlier &&
        scrollerElement.scrollTop <= loadMoreThreshold
      ) {
        handleLoadEarlier()
        return
      }

      const distanceToBottom =
        scrollerElement.scrollHeight -
        scrollerElement.scrollTop -
        scrollerElement.clientHeight
      if (
        hasNewerMessages &&
        onLoadNewer &&
        distanceToBottom <= loadMoreThreshold
      ) {
        handleLoadNewer()
      }
    }

    emitAtBottomState()
    emitActiveUserMessage()
    scrollerElement.addEventListener('scroll', handleScroll, {
      passive: true,
    })

    if (typeof ResizeObserver === 'undefined') {
      return () => {
        scrollerElement.removeEventListener('scroll', handleScroll)
      }
    }

    const observer = new ResizeObserver(() => {
      emitAtBottomState()
      emitActiveUserMessage()
    })
    observer.observe(scrollerElement)

    return () => {
      observer.disconnect()
      scrollerElement.removeEventListener('scroll', handleScroll)
    }
  }, [
    atBottomThreshold,
    handleLoadEarlier,
    handleLoadNewer,
    hasEarlierMessages,
    hasNewerMessages,
    emitActiveUserMessage,
    onAtBottomStateChange,
    onLoadEarlier,
    onLoadNewer,
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

  return (
    <div
      ref={(element) => {
        handleScrollerRef(element)
      }}
      className={scrollContainerClassName}
      style={scrollContainerStyle}
    >
      {hasEarlierMessages && onLoadEarlier ? (
        <TimelineLoadMoreButton
          label={loadEarlierLabel}
          onClick={handleLoadEarlier}
        />
      ) : null}
      {items.map((item, index) => (
        <TimelineRow
          key={item.renderKey}
          item={item}
          index={index}
          renderItem={renderItem}
        />
      ))}
      {hasNewerMessages && onLoadNewer ? (
        <TimelineLoadMoreButton
          label={loadNewerLabel}
          onClick={handleLoadNewer}
        />
      ) : null}
      <TimelineBottomSpacer height={safeSpacerHeight} />
    </div>
  )
}
