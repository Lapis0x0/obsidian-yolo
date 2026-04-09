import type { SerializedEditorState } from 'lexical'

import type {
  AssistantToolMessageGroup,
  ChatConversationCompaction,
  ChatSelectedSkill,
  ChatUserMessage,
} from './chat'
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
  estimatedHeight: number
  spacingBefore?: number
  isActive?: boolean
  isEditable?: boolean
  isPinnedForRender?: boolean
  isStreaming?: boolean
}

export type ChatTimelineUserMessageItem = ChatTimelineBaseItem & {
  kind: 'user-message'
  message: ChatUserMessage
}

export type ChatTimelineAssistantGroupItem = ChatTimelineBaseItem & {
  kind: 'assistant-group'
  messages: AssistantToolMessageGroup
}

export type ChatTimelineCompactionPendingItem = ChatTimelineBaseItem & {
  kind: 'compaction-pending'
  anchorMessageId: string
}

export type ChatTimelineCompactionDividerItem = ChatTimelineBaseItem & {
  kind: 'compaction-divider'
  anchorMessageId: string
  compaction: ChatConversationCompaction | null
}

export type ChatTimelineQueryProgressItem = ChatTimelineBaseItem & {
  kind: 'query-progress'
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
  | ChatTimelineQueryProgressItem
  | ChatTimelineContinueResponseItem
  | ChatTimelineBottomAnchorItem

export type ChatTimelineRenderState = {
  heightByItemId: Record<string, number>
  visibleStartIndex: number
  visibleEndIndex: number
  anchorItemId: string | null
  activeEditableItemId: string | null
}
