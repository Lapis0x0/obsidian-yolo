import type { SerializedEditorState } from 'lexical'

import type { ChatConversationCompaction, ChatSelectedSkill } from './chat'
import type { Mentionable } from './mentionable'

export type UserMessageDisplaySnapshot = {
  content: SerializedEditorState | null
  text: string
  mentionables: Mentionable[]
  selectedSkills: ChatSelectedSkill[]
  modelId?: string
  reasoningLevel?: string
}

export type ActiveConversationTailState = {
  anchorMessageId: string | null
  isStreaming: boolean
  latestMessageId: string | null
}

type ChatTimelineBaseItem = {
  id: string
  renderKey: string
  spacingBefore?: number
  isActive?: boolean
  isEditable?: boolean
  isPinnedForRender?: boolean
  isStreaming?: boolean
}

export type ChatTimelineUserMessageItem = ChatTimelineBaseItem & {
  kind: 'user-message'
  messageId: string
  revision: number
}

export type ChatTimelineAssistantGroupItem = ChatTimelineBaseItem & {
  kind: 'assistant-group'
  /** Stable logical group identity shared by all rendered slices. */
  groupId: string
  messageIds: string[]
  revision: number
}

export type ChatTimelineCompactionPendingItem = ChatTimelineBaseItem & {
  kind: 'compaction-pending'
  anchorMessageId: string
}

export type ChatTimelineCompactionDividerItem = ChatTimelineBaseItem & {
  kind: 'compaction-divider'
  anchorMessageId: string | null
  compaction: ChatConversationCompaction | null
}

/**
 * A "resumed session couldn't be reached, started a fresh one instead"
 * notice anchored into the transcript — see `CliSessionFallbackBoundary`.
 * Structurally identical to `ChatTimelineCompactionDividerItem` (same
 * divider visual) but carries its own copy since, unlike a compaction
 * divider's surface-wide text, the notice names the specific profile that
 * became unreachable.
 */
export type ChatTimelineSessionFallbackDividerItem = ChatTimelineBaseItem & {
  kind: 'session-fallback-divider'
  anchorMessageId: string | null
  title: string
  description: string
}

export type ChatTimelineQueryProgressItem = ChatTimelineBaseItem & {
  kind: 'query-progress'
}

export type ChatTimelinePendingResponseItem = ChatTimelineBaseItem & {
  kind: 'pending-response'
  sourceUserMessageId: string
}

export type ChatTimelineContinueResponseItem = ChatTimelineBaseItem & {
  kind: 'continue-response'
}

export type ChatTimelineBottomAnchorItem = ChatTimelineBaseItem & {
  kind: 'bottom-anchor'
}

export type ChatTimelineItem =
  | ChatTimelineUserMessageItem
  | ChatTimelineAssistantGroupItem
  | ChatTimelineCompactionPendingItem
  | ChatTimelineCompactionDividerItem
  | ChatTimelineSessionFallbackDividerItem
  | ChatTimelineQueryProgressItem
  | ChatTimelinePendingResponseItem
  | ChatTimelineContinueResponseItem
  | ChatTimelineBottomAnchorItem

export type ChatTimelineRenderState = {
  heightByItemId: Record<string, number>
  visibleStartIndex: number
  visibleEndIndex: number
  anchorItemId: string | null
  activeEditableItemId: string | null
}
