import {
  ChatConversationCompactionLike,
  SerializedChatMessage,
} from '../../../types/chat'
import { ConversationOverrideSettings } from '../../../types/conversation-settings.types'

export const CHAT_SCHEMA_VERSION = 1

export type ChatConversationOrigin = 'user' | 'external-agent'

export const getChatConversationOrigin = (
  conversation: Pick<ChatConversation, 'origin'>,
): ChatConversationOrigin => conversation.origin ?? 'user'

export type ChatConversation = {
  id: string
  title: string
  messages: SerializedChatMessage[]
  createdAt: number
  updatedAt: number
  schemaVersion: number
  isPinned?: boolean
  pinnedAt?: number
  // Optional per-conversation overrides (temperature, top_p, stream)
  overrides?: ConversationOverrideSettings | null
  conversationModelId?: string
  assistantId?: string
  messageModelMap?: Record<string, string>
  activeBranchByUserMessageId?: Record<string, string>
  assistantGroupBoundaryMessageIds?: string[]
  reasoningLevel?: string
  compaction?: ChatConversationCompactionLike | null
  origin?: ChatConversationOrigin
}

export type ChatConversationMetadata = {
  id: string
  title: string
  updatedAt: number
  schemaVersion: number
  isPinned?: boolean
  pinnedAt?: number
  origin?: ChatConversationOrigin
}
