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
  toggleConversationPinned: (id: string) => Promise<void>
  generateConversationTitle: (
    id: string,
    messages: ChatMessage[],
  ) => Promise<void>
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
  }, [fetchChatList])

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
            // 默认标题统一为"新消息"，待第一轮模型回答完成后由工具模型自动改名
            const defaultTitle = '新消息'

            await chatManager.createChat({
              id,
              title: defaultTitle,
              messages: serializedMessages,
              overrides: overrides ?? null,
            })
          }

          await fetchChatList()
        },
        300,
        {
          maxWait: 1000,
        },
      ),
    [chatManager, fetchChatList],
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

  const toggleConversationPinned = useCallback(
    async (id: string): Promise<void> => {
      const conversation = await chatManager.findById(id)
      if (!conversation) {
        throw new Error('Conversation not found')
      }
      const isPinned = !conversation.isPinned
      const pinnedAt = isPinned ? Date.now() : undefined
      setChatList((prev) => {
        const now = Date.now()
        return prev.map((chat) =>
          chat.id === id
            ? {
                ...chat,
                isPinned,
                pinnedAt,
                updatedAt: now,
              }
            : chat,
        )
      })
      try {
        await chatManager.updateChat(conversation.id, {
          isPinned,
          pinnedAt,
        })
      } finally {
        await fetchChatList()
      }
    },
    [chatManager, fetchChatList],
  )

  const generateConversationTitle = useCallback(
    async (id: string, messages: ChatMessage[]): Promise<void> => {
      // 等待对话存在（最多等待 2 秒，每 200ms 检查一次）
      // 这是为了处理 debounce 导致的保存延迟
      let conversation = null
      for (let i = 0; i < 10; i++) {
        conversation = await chatManager.findById(id)
        if (conversation) break
        await new Promise((resolve) => setTimeout(resolve, 200))
      }

      if (!conversation) {
        return
      }

      // 如果标题已经不是"新消息"，说明已经命名过了，不需要再次命名
      if (conversation.title !== '新消息') {
        return
      }

      // 只需要用户消息即可生成标题
      const firstUserMessage = messages.find((v) => v.role === 'user')
      if (!firstUserMessage) {
        return
      }

      // 使用用户的第一条消息来生成标题
      const userText = firstUserMessage.content
        ? editorStateToPlainText(firstUserMessage.content)
        : ''

      if (!userText || userText.trim().length === 0) {
        return
      }

      // 标题生成核心逻辑，支持重试
      const attemptGenerateTitle = async (
        retryCount: number = 0,
      ): Promise<string | null> => {
        const MAX_RETRIES = 2
        const TIMEOUT_MS = 10000 // 10秒超时

        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

          const { providerClient, model } = getChatModelClient({
            settings,
            modelId: settings.applyModelId,
          })

          const defaultTitlePrompt =
            DEFAULT_CHAT_TITLE_PROMPT[language] ?? DEFAULT_CHAT_TITLE_PROMPT.en
          const customizedPrompt = (
            settings.chatOptions.chatTitlePrompt ?? ''
          ).trim()
          const systemPrompt =
            customizedPrompt.length > 0 ? customizedPrompt : defaultTitlePrompt

          const response = await providerClient.generateResponse(
            model,
            {
              model: model.model,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userText },
              ],
              stream: false,
            },
            { signal: controller.signal },
          )
          clearTimeout(timer)

          const generated = response.choices?.[0]?.message?.content ?? ''
          const nextTitle = (generated || '')
            .trim()
            .replace(/^["'""'']+|["'""'']+$/g, '')

          return nextTitle || null
        } catch {
          // 如果还有重试次数，则重试
          if (retryCount < MAX_RETRIES) {
            return attemptGenerateTitle(retryCount + 1)
          }
          return null
        }
      }

      void (async () => {
        const generatedTitle = await attemptGenerateTitle()
        if (!generatedTitle) return

        const nextSafeTitle = generatedTitle.substring(0, 10)

        // 再次检查标题是否仍为"新消息"，避免竞态条件
        const currentConversation = await chatManager.findById(id)
        if (currentConversation && currentConversation.title === '新消息') {
          await chatManager.updateChat(id, { title: nextSafeTitle })
          await fetchChatList()
        }
      })()
    },
    [chatManager, fetchChatList, language, settings],
  )

  return {
    createOrUpdateConversation,
    deleteConversation,
    getChatMessagesById,
    getConversationById,
    updateConversationTitle,
    toggleConversationPinned,
    generateConversationTitle,
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
