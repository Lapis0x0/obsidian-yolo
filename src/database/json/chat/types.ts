import { SerializedChatMessage } from '../../../types/chat'
import { ConversationOverrideSettings } from '../../../types/conversation-settings.types'

export const CHAT_SCHEMA_VERSION = 1

export type ChatConversation = {
  id: string
  title: string
  messages: SerializedChatMessage[]
  createdAt: number
  updatedAt: number
  schemaVersion: number
  isPinned?: boolean
  pinnedAt?: number
  // Optional per-conversation overrides (temperature, top_p, maxContextMessages, stream)
  overrides?: ConversationOverrideSettings | null
  reasoningLevel?: string
}

export type ChatConversationMetadata = {
  id: string
  title: string
  updatedAt: number
  schemaVersion: number
  isPinned?: boolean
  pinnedAt?: number
}
