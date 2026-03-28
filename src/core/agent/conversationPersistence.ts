import { App } from 'obsidian'

import { ChatManager } from '../../database/json/chat/ChatManager'
import { compactConversationMessagesForStorage } from '../../database/json/chat/promptSnapshotStore'
import type { SmartComposerSettings } from '../../settings/schema/setting.types'
import type {
  ChatMessage,
  SerializedChatMessage,
} from '../../types/chat'
import { serializeMentionable } from '../../utils/chat/mentionable'

const DEFAULT_UNTITLED_CONVERSATION_TITLE = '新对话'
const CHAT_HISTORY_UPDATED_EVENT = 'smtcmp:chat-history-updated'

const serializeChatMessage = (message: ChatMessage): SerializedChatMessage => {
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
        reasoningLevel: message.reasoningLevel,
        similaritySearchResults: message.similaritySearchResults,
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
        toolCalls: message.toolCalls,
        id: message.id,
      }
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
    }: {
      conversationId: string
      messages: ChatMessage[]
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
        await chatManager.updateChat(conversationId, {
          messages: compactedMessages,
        })
      } else {
        await chatManager.createChat({
          id: conversationId,
          title: DEFAULT_UNTITLED_CONVERSATION_TITLE,
          messages: compactedMessages,
        })
      }

      window.dispatchEvent(new CustomEvent(CHAT_HISTORY_UPDATED_EVENT))
    },
  }
}
