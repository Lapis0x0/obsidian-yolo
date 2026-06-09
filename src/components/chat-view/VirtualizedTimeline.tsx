import type { ReactNode, RefObject } from 'react'

import type { ChatTimelineItem } from '../../types/chat-timeline'
import { ChatTimelineList } from './ChatTimelineList'

type VirtualizedTimelineProps<TItem extends ChatTimelineItem> = {
  items: TItem[]
  conversationId?: string
  scrollContainerRef: RefObject<HTMLElement>
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

// Backward-compatible wrapper. New code should prefer ChatTimelineList directly.
export function VirtualizedTimeline<TItem extends ChatTimelineItem>(
  props: VirtualizedTimelineProps<TItem>,
) {
  return <ChatTimelineList {...props} />
}
