import type { CSSProperties, ReactNode, RefObject } from 'react'
import type { FollowOutput } from 'react-virtuoso'

import type { ChatTimelineItem } from '../../types/chat-timeline'

import {
  ChatTimelineList,
  type ChatTimelineRenderContext,
} from './ChatTimelineList'

type SharedConversationSurfaceProps<TItem extends ChatTimelineItem> = {
  items: TItem[]
  conversationId?: string
  scrollContainerRef: RefObject<HTMLElement>
  renderItem: (
    item: TItem,
    index: number,
    context?: ChatTimelineRenderContext,
  ) => ReactNode
  followOutput?: FollowOutput
  onAtBottomStateChange?: (atBottom: boolean) => void
  virtualizationThreshold?: number
  forceRenderItemIds?: string[]
  overscanPx?: number
  atBottomThreshold?: number
  onRenderStateChange?: (state: {
    visibleStartIndex: number
    visibleEndIndex: number
    heightByItemId: Record<string, number>
  }) => void
  scrollContainerClassName?: string
  scrollContainerStyle?: CSSProperties
  containerClassName?: string
  containerStyle?: CSSProperties
  overlaySlot?: ReactNode
  extraSlot?: ReactNode
  extraSlotPosition?: 'before' | 'after'
}

export function SharedConversationSurface<TItem extends ChatTimelineItem>({
  items,
  conversationId,
  scrollContainerRef,
  renderItem,
  followOutput,
  onAtBottomStateChange,
  virtualizationThreshold,
  forceRenderItemIds,
  overscanPx,
  atBottomThreshold,
  onRenderStateChange,
  scrollContainerClassName,
  scrollContainerStyle,
  containerClassName,
  containerStyle,
  overlaySlot,
  extraSlot,
  extraSlotPosition = 'after',
}: SharedConversationSurfaceProps<TItem>) {
  const timeline = (
    <ChatTimelineList
      items={items}
      conversationId={conversationId}
      scrollContainerRef={scrollContainerRef}
      renderItem={renderItem}
      followOutput={followOutput}
      onAtBottomStateChange={onAtBottomStateChange}
      virtualizationThreshold={virtualizationThreshold}
      forceRenderItemIds={forceRenderItemIds}
      overscanPx={overscanPx}
      atBottomThreshold={atBottomThreshold}
      onRenderStateChange={onRenderStateChange}
      scrollContainerClassName={scrollContainerClassName}
      scrollContainerStyle={scrollContainerStyle}
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
