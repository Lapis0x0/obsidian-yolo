import {
  ChatConversationCompactionLike,
  SerializedChatMessage,
} from '../../../types/chat'
import { ConversationOverrideSettings } from '../../../types/conversation-settings.types'
import { ProviderSession } from '../../../types/provider-session.types'

export const CHAT_SCHEMA_VERSION = 1

export type ChatConversationOrigin = 'user' | 'external-agent'

export type ChatConversationCliSession = {
  runtimeId:
    | 'claude-code'
    | 'codex'
    | 'hermes'
    | 'pi'
    | 'omp'
    | 'grok'
    | 'codebuddy'
  nativeSessionId: string
  sessionPathHint?: string
  /** Hermes profile this session lives under (see `CliSessionRef.profileId`). */
  profileId?: string
}

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
  /**
   * The project this conversation belongs to (`YoloSettings.projects`). The
   * only record of membership — projects keep no conversation list. Absent
   * means "not in a project"; a dangling id (project deleted) reads the same.
   */
  projectId?: string
  /**
   * Position in the sidebar's conversation list: larger sorts higher, within
   * the pinned and the unpinned group separately. The user orders the list by
   * dragging, so this is set at creation and when dragged, never by activity.
   * Conversations older than the field get one frozen into the index (see
   * `ChatManager.listChats`).
   */
  sortKey?: number
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
  /**
   * Native runtime binding for a CLI conversation created by YOLO.
   * The native transcript remains provider-owned; YOLO persists only this
   * stable reference and its own conversation metadata.
   */
  cliSession?: ChatConversationCliSession
  /**
   * Native session binding for a provider that owns one (see
   * `ProviderSession`). Deliberately separate from `cliSession`, which also
   * declares "this is a CLI runtime conversation" and is read as such by the
   * runtime selector and the message rendering path — a conversation with a
   * `providerSession` is an ordinary YOLO conversation whose provider happens
   * to keep a session of its own.
   */
  providerSession?: ProviderSession
}

export type ChatConversationMetadata = {
  id: string
  title: string
  updatedAt: number
  schemaVersion: number
  isPinned?: boolean
  pinnedAt?: number
  projectId?: string
  /** See `ChatConversation.sortKey`; always present once listed. */
  sortKey?: number
  origin?: ChatConversationOrigin
  cliSession?: ChatConversationCliSession
}

/**
 * The sort key a conversation without one is given: its current place in the
 * list from before the list was user-ordered, when pinned conversations sat by
 * pin time and the rest by last activity.
 */
export const getLegacyChatSortKey = (
  chat: Pick<ChatConversationMetadata, 'isPinned' | 'pinnedAt' | 'updatedAt'>,
): number =>
  chat.isPinned ? (chat.pinnedAt ?? chat.updatedAt) : chat.updatedAt
