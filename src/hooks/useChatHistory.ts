import debounce from 'lodash.debounce'
import isEqual from 'lodash.isequal'
import { App } from 'obsidian'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { editorStateToPlainText } from '../components/chat-view/chat-input/utils/editor-state-to-plain-text'
import { DEFAULT_CHAT_TITLE_PROMPT } from '../constants'
import { useApp } from '../contexts/app-context'
import { useLanguage } from '../contexts/language-context'
import { useSettings } from '../contexts/settings-context'
import { getChatModelClient } from '../core/llm/manager'
import { ChatConversationMetadata } from '../database/json/chat/types'
import { ChatMessage, SerializedChatMessage } from '../types/chat'
import { ConversationOverrideSettings } from '../types/conversation-settings.types'
import { Mentionable } from '../types/mentionable'
import {
  deserializeMentionable,
  serializeMentionable,
} from '../utils/chat/mentionable'

import { useChatManager } from './useJsonManagers'

type UseChatHistory = {
  createOrUpdateConversation: (
    id: string,
    messages: ChatMessage[],
    overrides?: ConversationOverrideSettings | null,
  ) => Promise<void> | undefined
  deleteConversation: (id: string) => Promise<void>
  getChatMessagesById: (id: string) => Promise<ChatMessage[] | null>
  getConversationById: (id: string) => Promise<{
    messages: ChatMessage[]
    overrides: ConversationOverrideSettings | null | undefined
  } | null>
  updateConversationTitle: (id: string, title: string) => Promise<void>
  chatList: ChatConversationMetadata[]
}

export function useChatHistory(): UseChatHistory {
  const app = useApp()
  const { settings } = useSettings()
  const { language } = useLanguage()
  const chatManager = useChatManager()
  const [chatList, setChatList] = useState<ChatConversationMetadata[]>([])

  const fetchChatList = useCallback(async () => {
    const list = await chatManager.listChats()
    setChatList(list)
  }, [chatManager])

  useEffect(() => {
    void fetchChatList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Refresh chat list when other parts of the app clear or modify chat history (e.g., Settings -> Etc -> Clear Chat History)
  useEffect(() => {
    const handler = () => {
      void fetchChatList()
    }
    window.addEventListener('smtcmp:chat-history-cleared', handler)
    return () =>
      window.removeEventListener('smtcmp:chat-history-cleared', handler)
  }, [fetchChatList])

  const createOrUpdateConversation = useMemo(
    () =>
      debounce(
        async (
          id: string,
          messages: ChatMessage[],
          overrides?: ConversationOverrideSettings | null,
        ): Promise<void> => {
          const serializedMessages = messages.map(serializeChatMessage)
          const existingConversation = await chatManager.findById(id)

          if (existingConversation) {
            const nextOverrides =
              overrides === undefined
                ? (existingConversation.overrides ?? null)
                : overrides
            if (
              isEqual(existingConversation.messages, serializedMessages) &&
              isEqual(
                existingConversation.overrides ?? null,
                nextOverrides ?? null,
              )
            ) {
              return
            }
            await chatManager.updateChat(existingConversation.id, {
              messages: serializedMessages,
              overrides:
                overrides === undefined
                  ? (existingConversation.overrides ?? null)
                  : overrides,
            })
          } else {
            const firstUserMessage = messages.find((v) => v.role === 'user')

            // 默认标题统一为“新消息”，待首条消息发送后由工具模型自动改名
            // 同时保留首条消息的纯文本供后续自动命名使用
            const rawTitle = firstUserMessage?.content
              ? editorStateToPlainText(firstUserMessage.content)
              : ''
            const defaultTitle = '新消息'

            await chatManager.createChat({
              id,
              title: defaultTitle,
              messages: serializedMessages,
              overrides: overrides ?? null,
            })

            // Auto-generate a better title using the tool model (applyModelId). Timeout: 3s
            ;(async () => {
              try {
                const firstUserText = rawTitle
                if (!firstUserText || (firstUserText ?? '').trim().length === 0)
                  return

                const controller = new AbortController()
                const timer = setTimeout(() => controller.abort(), 3000)

                const { providerClient, model } = getChatModelClient({
                  settings,
                  modelId: settings.applyModelId,
                })

                const defaultTitlePrompt =
                  DEFAULT_CHAT_TITLE_PROMPT[language] ??
                  DEFAULT_CHAT_TITLE_PROMPT.en
                const customizedPrompt = (
                  settings.chatOptions.chatTitlePrompt ?? ''
                ).trim()
                const systemPrompt =
                  customizedPrompt.length > 0
                    ? customizedPrompt
                    : defaultTitlePrompt

                const response = await providerClient.generateResponse(
                  model,
                  {
                    model: model.model,
                    messages: [
                      { role: 'system', content: systemPrompt },
                      { role: 'user', content: firstUserText },
                    ],
                    stream: false,
                  },
                  { signal: controller.signal },
                )
                clearTimeout(timer)

                const generated = response.choices?.[0]?.message?.content ?? ''
                const nextTitle = (generated || '')
                  .trim()
                  .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
                if (!nextTitle) return
                const nextSafeTitle = nextTitle.substring(0, 10)

                await chatManager.updateChat(id, { title: nextSafeTitle })
                await fetchChatList()
              } catch (_) {
                // Ignore failures/timeouts; keep fallback title
              }
            })()
          }

          await fetchChatList()
        },
        300,
        {
          maxWait: 1000,
        },
      ),
    [chatManager, fetchChatList, language, settings],
  )

  const deleteConversation = useCallback(
    async (id: string): Promise<void> => {
      await chatManager.deleteChat(id)
      await fetchChatList()
    },
    [chatManager, fetchChatList],
  )

  const getChatMessagesById = useCallback(
    async (id: string): Promise<ChatMessage[] | null> => {
      const conversation = await chatManager.findById(id)
      if (!conversation) {
        return null
      }
      return conversation.messages.map((message) =>
        deserializeChatMessage(message, app),
      )
    },
    [chatManager, app],
  )

  const getConversationById = useCallback(
    async (
      id: string,
    ): Promise<{
      messages: ChatMessage[]
      overrides: ConversationOverrideSettings | null | undefined
    } | null> => {
      const conversation = await chatManager.findById(id)
      if (!conversation) return null
      return {
        messages: conversation.messages.map((m) =>
          deserializeChatMessage(m, app),
        ),
        overrides: conversation.overrides,
      }
    },
    [chatManager, app],
  )

  const updateConversationTitle = useCallback(
    async (id: string, title: string): Promise<void> => {
      if (title.length === 0) {
        throw new Error('Chat title cannot be empty')
      }
      const conversation = await chatManager.findById(id)
      if (!conversation) {
        throw new Error('Conversation not found')
      }
      await chatManager.updateChat(conversation.id, {
        title,
      })
      await fetchChatList()
    },
    [chatManager, fetchChatList],
  )

  return {
    createOrUpdateConversation,
    deleteConversation,
    getChatMessagesById,
    getConversationById,
    updateConversationTitle,
    chatList,
  }
}

const serializeChatMessage = (message: ChatMessage): SerializedChatMessage => {
  switch (message.role) {
    case 'user':
      return {
        role: 'user',
        content: message.content,
        promptContent: message.promptContent,
        id: message.id,
        mentionables: message.mentionables.map(serializeMentionable),
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

const deserializeChatMessage = (
  message: SerializedChatMessage,
  app: App,
): ChatMessage => {
  switch (message.role) {
    case 'user': {
      return {
        role: 'user',
        content: message.content,
        promptContent: message.promptContent,
        id: message.id,
        mentionables: message.mentionables
          .map((m) => deserializeMentionable(m, app))
          .filter((m): m is Mentionable => m !== null),
        similaritySearchResults: message.similaritySearchResults,
      }
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
