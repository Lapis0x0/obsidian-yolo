import type { ReactNode } from 'react'

import type {
  AssistantToolMessageGroup,
  ChatMessage,
  ChatUserMessage,
} from '../../types/chat'
import type {
  ChatTimelineAssistantGroupItem,
  ChatTimelineItem,
} from '../../types/chat-timeline'

import type { AssistantToolMessageGroupItemProps } from './AssistantToolMessageGroupItem'
import type {
  AssistantActionSurfacePreset,
  ChatSurfacePreset,
} from './chat-surface-presets'

export type ConversationAssistantGroupProps = Omit<
  AssistantToolMessageGroupItemProps,
  | 'messages'
  | 'showInlineInfo'
  | 'showRetryAction'
  | 'showInsertAction'
  | 'showCopyAction'
  | 'showBranchAction'
  | 'showEditAction'
  | 'showDeleteAction'
  | 'showQuoteAction'
>

export type ConversationTimelineRendererContract = {
  messagesById: ReadonlyMap<string, ChatMessage>
  preset: ChatSurfacePreset
  compaction: {
    pendingTitle: string
    pendingDescription: string
    dividerTitle: string
    dividerDescription: string
    isDividerEntering?: (item: ChatTimelineItem) => boolean
  }
  renderUserMessage: (
    message: ChatUserMessage,
    item: Extract<ChatTimelineItem, { kind: 'user-message' }>,
  ) => ReactNode
  getAssistantGroupProps: (
    messages: AssistantToolMessageGroup,
    item: ChatTimelineAssistantGroupItem,
  ) => ConversationAssistantGroupProps | null
  getAssistantActionOverrides?: (
    messages: AssistantToolMessageGroup,
    item: ChatTimelineAssistantGroupItem,
  ) => Partial<AssistantActionSurfacePreset>
  wrapAssistantGroup?: (
    content: ReactNode,
    item: ChatTimelineAssistantGroupItem,
  ) => ReactNode
  renderUnboundAssistantGroup?: (
    messages: AssistantToolMessageGroup,
    item: ChatTimelineAssistantGroupItem,
  ) => ReactNode
  renderQueryProgress?: (
    item: Extract<ChatTimelineItem, { kind: 'query-progress' }>,
  ) => ReactNode
  renderPendingResponse?: (
    item: Extract<ChatTimelineItem, { kind: 'pending-response' }>,
  ) => ReactNode
  renderContinueResponse?: (
    item: Extract<ChatTimelineItem, { kind: 'continue-response' }>,
  ) => ReactNode
  bottomAnchorClassName: string
}
