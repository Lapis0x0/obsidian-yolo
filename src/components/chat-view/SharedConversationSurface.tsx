import type { CSSProperties, ReactNode, RefObject } from 'react'
import type { FollowOutput } from 'react-virtuoso'

import type { ChatTimelineItem } from '../../types/chat-timeline'

import {
  ChatTimelineList,
  type ChatTimelineRenderContext,
  type ChatTimelineRenderVersion,
  type UserMessageViewportState,
} from './ChatTimelineList'

type SharedConversationSurfaceProps<TItem extends ChatTimelineItem> = {
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
  followOutput?: FollowOutput
  onAtBottomStateChange?: (atBottom: boolean) => void
  virtualizationThreshold?: number
  forceRenderItemIds?: string[]
  overscanPx?: number
  atBottomThreshold?: number
  onVirtualizationChange?: (isVirtualized: boolean) => void
  onUserMessageViewportChange?: (state: UserMessageViewportState) => void
  windowNavigationKey?: number
  windowNavigationTargetMessageId?: string | null
  onRenderStateChange?: (state: {
    visibleStartIndex: number
    visibleEndIndex: number
    heightByItemId: Record<string, number>
  }) => void
  hasEarlierMessages?: boolean
  hasNewerMessages?: boolean
  onLoadEarlier?: () => void
  onLoadNewer?: () => void
  scrollContainerClassName?: string
  scrollContainerStyle?: CSSProperties
  containerClassName?: string
  containerStyle?: CSSProperties
  overlaySlot?: ReactNode
  extraSlot?: ReactNode
  extraSlotPosition?: 'before' | 'after'
  bottomSpacerHeight?: number
}

export function SharedConversationSurface<TItem extends ChatTimelineItem>({
  items,
  conversationId,
  scrollContainerRef,
  onScrollContainerChange,
  renderItem,
  renderVersion,
  followOutput,
  onAtBottomStateChange,
  virtualizationThreshold,
  forceRenderItemIds,
  overscanPx,
  atBottomThreshold,
  onVirtualizationChange,
  onUserMessageViewportChange,
  windowNavigationKey,
  windowNavigationTargetMessageId,
  onRenderStateChange,
  hasEarlierMessages,
  hasNewerMessages,
  onLoadEarlier,
  onLoadNewer,
  scrollContainerClassName,
  scrollContainerStyle,
  containerClassName,
  containerStyle,
  overlaySlot,
  extraSlot,
  extraSlotPosition = 'after',
  bottomSpacerHeight,
}: SharedConversationSurfaceProps<TItem>) {
  const timeline = (
    <ChatTimelineList
      items={items}
      conversationId={conversationId}
      scrollContainerRef={scrollContainerRef}
      onScrollContainerChange={onScrollContainerChange}
      renderItem={renderItem}
      renderVersion={renderVersion}
      followOutput={followOutput}
      onAtBottomStateChange={onAtBottomStateChange}
      virtualizationThreshold={virtualizationThreshold}
      forceRenderItemIds={forceRenderItemIds}
      overscanPx={overscanPx}
      atBottomThreshold={atBottomThreshold}
      onVirtualizationChange={onVirtualizationChange}
      onUserMessageViewportChange={onUserMessageViewportChange}
      windowNavigationKey={windowNavigationKey}
      windowNavigationTargetMessageId={windowNavigationTargetMessageId}
      onRenderStateChange={onRenderStateChange}
      hasEarlierMessages={hasEarlierMessages}
      hasNewerMessages={hasNewerMessages}
      onLoadEarlier={onLoadEarlier}
      onLoadNewer={onLoadNewer}
      scrollContainerClassName={scrollContainerClassName}
      scrollContainerStyle={scrollContainerStyle}
      bottomSpacerHeight={bottomSpacerHeight}
    />
  )

  const hasOuterWrapper =
    Boolean(containerClassName) ||
    Boolean(containerStyle) ||
    overlaySlot !== undefined ||
    extraSlot !== undefined

  if (!hasOuterWrapper) {
    return timeline
  }

  return (
    <div className={containerClassName} style={containerStyle}>
      {overlaySlot}
      {extraSlotPosition === 'before' ? extraSlot : null}
      {timeline}
      {extraSlotPosition === 'after' ? extraSlot : null}
    </div>
  )
}
