import { App } from 'obsidian'

import { ChatManager } from '../../database/json/chat/ChatManager'
import { compactConversationMessagesForStorage } from '../../database/json/chat/promptSnapshotStore'
import type { SmartComposerSettings } from '../../settings/schema/setting.types'
import type {
  ChatConversationCompactionState,
  ChatMessage,
  SerializedChatMessage,
} from '../../types/chat'
import { normalizeChatConversationCompactionState } from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { serializeMentionable } from '../../utils/chat/mentionable'

const DEFAULT_UNTITLED_CONVERSATION_TITLE = '新对话'
const CHAT_HISTORY_UPDATED_EVENT = 'smtcmp:chat-history-updated'

export const serializeChatMessage = (message: ChatMessage): SerializedChatMessage => {
  switch (message.role) {
    case 'user':
      return {
        role: 'user',
        content: message.content,
        promptContent: message.promptContent,
        snapshotRef: message.snapshotRef,
        id: message.id,
        mentionables: message.mentionables.map(serializeMentionable),
        selectedSkills: message.selectedSkills ?? [],
        selectedModelIds: message.selectedModelIds ?? [],
        reasoningLevel: message.reasoningLevel,
      }
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        reasoning: message.reasoning,
        annotations: message.annotations,
        toolCallRequests: message.toolCallRequests,
        id: message.id,
        metadata: message.metadata,
      }
    case 'tool':
      return {
        role: 'tool',
        toolCalls: message.toolCalls.map((tc) => ({
          ...tc,
          response:
            tc.response.status === ToolCallResponseStatus.Success
              ? {
                  ...tc.response,
                  data: {
                    ...tc.response.data,
                    // Replace inline base64 data URLs with cache:// refs
                    // to avoid bloating the conversation JSON file.
                    contentParts: tc.response.data.contentParts?.map((part) =>
                      part.type === 'image_url' && part.image_url.cacheKey
                        ? {
                            type: 'image_url' as const,
                            image_url: {
                              url: `cache://${part.image_url.cacheKey}`,
                              cacheKey: part.image_url.cacheKey,
                            },
                          }
                        : part,
                    ),
                  },
                }
              : tc.response,
        })),
        id: message.id,
        metadata: message.metadata,
      }
    case 'external_agent_result':
      return message
  }
}

export const createAgentConversationPersistence = (
  app: App,
  getSettings: () => SmartComposerSettings,
) => {
  return {
    persistConversationMessages: async ({
      conversationId,
      messages,
      compaction,
      touchUpdatedAt,
    }: {
      conversationId: string
      messages: ChatMessage[]
      compaction?: ChatConversationCompactionState
      touchUpdatedAt?: boolean
    }): Promise<void> => {
      const settings = getSettings()
      const chatManager = new ChatManager(app, settings)
      const serializedMessages = messages.map(serializeChatMessage)
      const existingConversation = await chatManager.findById(conversationId)
      const compactedMessages = await compactConversationMessagesForStorage({
        app,
        conversationId,
        messages: serializedMessages,
        previousMessages: existingConversation?.messages,
        settings,
      })

      if (existingConversation) {
        await chatManager.updateChat(
          conversationId,
          {
            messages: compactedMessages,
            compaction:
              compaction ??
              normalizeChatConversationCompactionState(
                existingConversation.compaction,
              ),
          },
          touchUpdatedAt === undefined ? undefined : { touchUpdatedAt },
        )
      } else {
        await chatManager.createChat({
          id: conversationId,
          title: DEFAULT_UNTITLED_CONVERSATION_TITLE,
          messages: compactedMessages,
          compaction: compaction ?? [],
        })
      }

      window.dispatchEvent(new CustomEvent(CHAT_HISTORY_UPDATED_EVENT))
    },
  }
}
