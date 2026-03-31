import debounce from 'lodash.debounce'
import isEqual from 'lodash.isequal'
import { App } from 'obsidian'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { editorStateToPlainText } from '../components/chat-view/chat-input/utils/editor-state-to-plain-text'
import {
  DEFAULT_CHAT_TITLE_PROMPT,
  DEFAULT_UNTITLED_CONVERSATION_TITLE,
} from '../constants'
import { useApp } from '../contexts/app-context'
import { useLanguage } from '../contexts/language-context'
import { useSettings } from '../contexts/settings-context'
import { getChatModelClient } from '../core/llm/manager'
import { promoteProviderTransportModeToObsidian } from '../core/llm/transportModePromotion'
import { compactConversationMessagesForStorage } from '../database/json/chat/promptSnapshotStore'
import { ChatConversationMetadata } from '../database/json/chat/types'
import {
  ChatConversationCompactionLike,
  ChatConversationCompactionState,
  ChatMessage,
  ChatSelectedSkill,
  SerializedChatMessage,
  normalizeChatConversationCompactionState,
} from '../types/chat'
import { ConversationOverrideSettings } from '../types/conversation-settings.types'
import { Mentionable } from '../types/mentionable'
import {
  deserializeMentionable,
  serializeMentionable,
} from '../utils/chat/mentionable'

import { useChatManager } from './useJsonManagers'

const LEGACY_UNTITLED_CONVERSATION_TITLES = new Set([
  '新消息',
  DEFAULT_UNTITLED_CONVERSATION_TITLE,
])
const AUTO_TITLE_TIMEOUT_MS = 10000
const AUTO_TITLE_MAX_RETRIES = 2
const AUTO_TITLE_FAILURE_COOLDOWN_MS = 5 * 60 * 1000
const AUTO_TITLE_INPUT_MAX_LENGTH = 1200
const AUTO_TITLE_WAIT_CONVERSATION_RETRIES = 15
const AUTO_TITLE_WAIT_CONVERSATION_INTERVAL_MS = 200
const CHAT_HISTORY_UPDATED_EVENT = 'smtcmp:chat-history-updated'

const isUntitledConversationTitle = (title: string): boolean =>
  LEGACY_UNTITLED_CONVERSATION_TITLES.has(title)

const truncateForTitleInput = (text: string): string => {
  const normalized = text.trim()
  if (normalized.length <= AUTO_TITLE_INPUT_MAX_LENGTH) {
    return normalized
  }
  return `${normalized.slice(0, AUTO_TITLE_INPUT_MAX_LENGTH)}...`
}

const formatSelectedSkillsForTitleInput = (
  selectedSkills: ChatSelectedSkill[],
): string => {
  const skillNames = selectedSkills
    .map((skill) => skill.name.trim())
    .filter((name) => name.length > 0)

  if (skillNames.length === 0) {
    return '[User selected only skills without text.]'
  }

  return truncateForTitleInput(
    `[User selected skills: ${skillNames.join(', ')}]`,
  )
}

type UseChatHistory = {
  createOrUpdateConversation: (
    id: string,
    messages: ChatMessage[],
    overrides?: ConversationOverrideSettings | null,
    conversationModelId?: string,
    messageModelMap?: Record<string, string>,
    reasoningLevel?: string,
    compaction?: ChatConversationCompactionState,
  ) => Promise<void> | undefined
  createOrUpdateConversationImmediately: (
    id: string,
    messages: ChatMessage[],
    overrides?: ConversationOverrideSettings | null,
    conversationModelId?: string,
    messageModelMap?: Record<string, string>,
    reasoningLevel?: string,
    compaction?: ChatConversationCompactionState,
  ) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  getChatMessagesById: (id: string) => Promise<ChatMessage[] | null>
  getConversationById: (id: string) => Promise<{
    messages: ChatMessage[]
    overrides: ConversationOverrideSettings | null | undefined
    conversationModelId?: string
    messageModelMap?: Record<string, string>
    reasoningLevel?: string
    compaction?: ChatConversationCompactionState
  } | null>
  updateConversationTitle: (id: string, title: string) => Promise<void>
  toggleConversationPinned: (id: string) => Promise<void>
  generateConversationTitle: (
    id: string,
    messages: ChatMessage[],
    options?: {
      force?: boolean
    },
  ) => Promise<void>
  chatList: ChatConversationMetadata[]
}

export function useChatHistory(): UseChatHistory {
  const app = useApp()
  const { settings, setSettings } = useSettings()
  const { language } = useLanguage()
  const chatManager = useChatManager()
  const [chatList, setChatList] = useState<ChatConversationMetadata[]>([])
  const titleGenerationInFlightRef = useRef<Set<string>>(new Set())
  const titleGenerationCooldownUntilRef = useRef<Map<string, number>>(new Map())
  const settingsRef = useRef(settings)

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  const handleAutoPromoteTransportMode = useCallback(
    (providerId: string, mode: 'node' | 'obsidian') => {
      void promoteProviderTransportModeToObsidian({
        getSettings: () => settingsRef.current,
        setSettings,
        providerId,
        mode,
      })
    },
    [setSettings],
  )

  const fetchChatList = useCallback(async () => {
    const list = await chatManager.listChats()
    setChatList(list)
  }, [chatManager])

  const emitChatHistoryUpdated = useCallback(() => {
    window.dispatchEvent(new CustomEvent(CHAT_HISTORY_UPDATED_EVENT))
  }, [])

  useEffect(() => {
    void fetchChatList()
  }, [fetchChatList])

  // Refresh chat list when other parts of the app clear or modify chat history (e.g., Settings -> Etc -> Clear Chat History)
  useEffect(() => {
    const handler = () => {
      void fetchChatList()
    }
    window.addEventListener('smtcmp:chat-history-cleared', handler)
    window.addEventListener(CHAT_HISTORY_UPDATED_EVENT, handler)
    return () => {
      window.removeEventListener('smtcmp:chat-history-cleared', handler)
      window.removeEventListener(CHAT_HISTORY_UPDATED_EVENT, handler)
    }
  }, [fetchChatList])

  const persistConversationInternal = useCallback(
    async (
      id: string,
      messages: ChatMessage[],
      overrides?: ConversationOverrideSettings | null,
      conversationModelId?: string,
      messageModelMap?: Record<string, string>,
      reasoningLevel?: string,
      compaction?: ChatConversationCompactionLike | null,
    ): Promise<void> => {
      const serializedMessages = messages.map(serializeChatMessage)
      const existingConversation = await chatManager.findById(id)
      const normalizedCompaction =
        normalizeChatConversationCompactionState(compaction)
      const existingCompaction = normalizeChatConversationCompactionState(
        existingConversation?.compaction,
      )
      const compactedMessages = await compactConversationMessagesForStorage({
        app,
        conversationId: id,
        messages: serializedMessages,
        previousMessages: existingConversation?.messages,
        settings,
      })

      if (existingConversation) {
        const nextOverrides =
          overrides === undefined
            ? (existingConversation.overrides ?? null)
            : overrides
        if (
          isEqual(existingConversation.messages, compactedMessages) &&
          isEqual(
            existingConversation.overrides ?? null,
            nextOverrides ?? null,
          ) &&
          existingConversation.conversationModelId === conversationModelId &&
          isEqual(
            existingConversation.messageModelMap ?? null,
            messageModelMap ?? null,
          ) &&
          existingConversation.reasoningLevel === reasoningLevel &&
          isEqual(existingCompaction, normalizedCompaction)
        ) {
          return
        }
        await chatManager.updateChat(existingConversation.id, {
          messages: compactedMessages,
          overrides:
            overrides === undefined
              ? (existingConversation.overrides ?? null)
              : overrides,
          conversationModelId:
            conversationModelId === undefined
              ? existingConversation.conversationModelId
              : conversationModelId,
          messageModelMap:
            messageModelMap === undefined
              ? existingConversation.messageModelMap
              : messageModelMap,
          reasoningLevel,
          compaction:
            compaction === undefined
              ? existingCompaction
              : normalizedCompaction,
        })
      } else {
        // 默认标题统一为"新对话"，待首条用户消息保存后由对话命名模型自动改名
        const defaultTitle = DEFAULT_UNTITLED_CONVERSATION_TITLE

        await chatManager.createChat({
          id,
          title: defaultTitle,
          messages: compactedMessages,
          overrides: overrides ?? null,
          conversationModelId,
          messageModelMap,
          reasoningLevel,
          compaction: normalizedCompaction,
        })
      }

      emitChatHistoryUpdated()
      await fetchChatList()
    },
    [app, chatManager, emitChatHistoryUpdated, fetchChatList, settings],
  )

  const debouncedCreateOrUpdateConversation = useMemo(
    () =>
      debounce(persistConversationInternal, 300, {
        maxWait: 1000,
      }),
    [persistConversationInternal],
  )

  useEffect(
    () => () => {
      debouncedCreateOrUpdateConversation.cancel()
    },
    [debouncedCreateOrUpdateConversation],
  )

  const createOrUpdateConversation = useCallback(
    (
      id: string,
      messages: ChatMessage[],
      overrides?: ConversationOverrideSettings | null,
      conversationModelId?: string,
      messageModelMap?: Record<string, string>,
      reasoningLevel?: string,
      compaction?: ChatConversationCompactionState,
    ): Promise<void> | undefined =>
      debouncedCreateOrUpdateConversation(
        id,
        messages,
        overrides,
        conversationModelId,
        messageModelMap,
        reasoningLevel,
        compaction,
      ),
    [debouncedCreateOrUpdateConversation],
  )

  const createOrUpdateConversationImmediately = useCallback(
    async (
      id: string,
      messages: ChatMessage[],
      overrides?: ConversationOverrideSettings | null,
      conversationModelId?: string,
      messageModelMap?: Record<string, string>,
      reasoningLevel?: string,
      compaction?: ChatConversationCompactionState,
    ): Promise<void> => {
      debouncedCreateOrUpdateConversation.cancel()
      await persistConversationInternal(
        id,
        messages,
        overrides,
        conversationModelId,
        messageModelMap,
        reasoningLevel,
        compaction,
      )
    },
    [debouncedCreateOrUpdateConversation, persistConversationInternal],
  )

  const deleteConversation = useCallback(
    async (id: string): Promise<void> => {
      await chatManager.deleteChat(id)
      emitChatHistoryUpdated()
      await fetchChatList()
    },
    [chatManager, emitChatHistoryUpdated, fetchChatList],
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
      conversationModelId?: string
      messageModelMap?: Record<string, string>
      reasoningLevel?: string
      compaction?: ChatConversationCompactionState
    } | null> => {
      const conversation = await chatManager.findById(id)
      if (!conversation) return null
      return {
        messages: conversation.messages.map((m) =>
          deserializeChatMessage(m, app),
        ),
        overrides: conversation.overrides,
        conversationModelId: conversation.conversationModelId,
        messageModelMap: conversation.messageModelMap,
        reasoningLevel: conversation.reasoningLevel,
        compaction: normalizeChatConversationCompactionState(
          conversation.compaction,
        ),
      }
    },
    [chatManager, app],
  )

  const updateConversationTitle = useCallback(
    async (id: string, title: string): Promise<void> => {
      if (title.length === 0) {
        throw new Error('Chat title cannot be empty')
      }
      const updatedConversation = await chatManager.updateChat(id, {
        title,
      })
      if (!updatedConversation) {
        throw new Error('Conversation not found')
      }
      emitChatHistoryUpdated()
      await fetchChatList()
    },
    [chatManager, emitChatHistoryUpdated, fetchChatList],
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
        emitChatHistoryUpdated()
        await fetchChatList()
      }
    },
    [chatManager, emitChatHistoryUpdated, fetchChatList],
  )

  const generateConversationTitle = useCallback(
    async (
      id: string,
      messages: ChatMessage[],
      options?: {
        force?: boolean
      },
    ): Promise<void> => {
      const force = options?.force === true
      const logTitleEvent = (
        reason:
          | 'cooldown_active'
          | 'in_flight'
          | 'conversation_missing'
          | 'already_titled'
          | 'no_user_signal'
          | 'llm_generation_failed',
      ): void => {
        console.debug('[YOLO] Auto title skipped', {
          conversationId: id,
          reason,
          force,
        })
      }

      const cooldownUntil = titleGenerationCooldownUntilRef.current.get(id) ?? 0
      if (!force && cooldownUntil > Date.now()) {
        logTitleEvent('cooldown_active')
        return
      }

      if (titleGenerationInFlightRef.current.has(id)) {
        logTitleEvent('in_flight')
        return
      }
      titleGenerationInFlightRef.current.add(id)

      try {
        // 等待对话存在（最多等待 3 秒，每 200ms 检查一次）
        // 这是为了处理 debounce 导致的保存延迟
        let conversation = null
        for (let i = 0; i < AUTO_TITLE_WAIT_CONVERSATION_RETRIES; i++) {
          conversation = await chatManager.findById(id)
          if (conversation) break
          await new Promise((resolve) =>
            setTimeout(resolve, AUTO_TITLE_WAIT_CONVERSATION_INTERVAL_MS),
          )
        }

        if (!conversation) {
          logTitleEvent('conversation_missing')
          return
        }

        // 如果标题已经命名过了，不需要再次命名
        if (!force && !isUntitledConversationTitle(conversation.title)) {
          logTitleEvent('already_titled')
          return
        }

        const firstUserMessage = messages.find(
          (message) => message.role === 'user',
        )
        if (!firstUserMessage) {
          return
        }

        const userText = firstUserMessage.content
          ? editorStateToPlainText(firstUserMessage.content)
          : ''
        const normalizedUserText = userText.trim()
        const userMentionables = firstUserMessage.mentionables ?? []
        const userSelectedSkills = firstUserMessage.selectedSkills ?? []
        const hasUserSignal =
          normalizedUserText.length > 0 ||
          userMentionables.length > 0 ||
          userSelectedSkills.length > 0

        if (!hasUserSignal) {
          logTitleEvent('no_user_signal')
          return
        }

        const userContext =
          normalizedUserText.length > 0
            ? truncateForTitleInput(normalizedUserText)
            : userSelectedSkills.length > 0
              ? formatSelectedSkillsForTitleInput(userSelectedSkills)
              : '[User shared only attachments/mentions without text.]'

        const titleInput = `User first message:\n${userContext}`

        let lastGenerationError: unknown = null

        const attemptGenerateTitle = async (
          retryCount: number = 0,
        ): Promise<string | null> => {
          const controller = new AbortController()
          const timer = setTimeout(
            () => controller.abort(),
            AUTO_TITLE_TIMEOUT_MS,
          )

          try {
            const { providerClient, model } = getChatModelClient({
              settings,
              modelId: settings.chatTitleModelId,
              onAutoPromoteTransportMode: handleAutoPromoteTransportMode,
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
                  { role: 'user', content: titleInput },
                ],
                stream: false,
              },
              { signal: controller.signal },
            )

            const generated = response.choices?.[0]?.message?.content ?? ''
            const nextTitle = (generated || '')
              .trim()
              .replace(/^["']+|["']+$/g, '')
            return nextTitle || null
          } catch (error) {
            lastGenerationError = error
            if (retryCount < AUTO_TITLE_MAX_RETRIES) {
              const backoffMs = 300 * (retryCount + 1)
              await new Promise((resolve) => setTimeout(resolve, backoffMs))
              return attemptGenerateTitle(retryCount + 1)
            }
            return null
          } finally {
            clearTimeout(timer)
          }
        }

        const generatedTitle = await attemptGenerateTitle()
        if (!generatedTitle) {
          logTitleEvent('llm_generation_failed')
          const errorMessage =
            lastGenerationError instanceof Error
              ? lastGenerationError.message
              : typeof lastGenerationError === 'string'
                ? lastGenerationError
                : lastGenerationError
                  ? JSON.stringify(lastGenerationError)
                  : 'unknown_error'
          console.error('[YOLO] Failed to generate conversation title', {
            conversationId: id,
            error: errorMessage,
            force,
          })
          titleGenerationCooldownUntilRef.current.set(
            id,
            Date.now() + AUTO_TITLE_FAILURE_COOLDOWN_MS,
          )
          return
        }
        titleGenerationCooldownUntilRef.current.delete(id)

        // 再次检查标题是否仍为默认标题，避免竞态条件
        const currentConversation = await chatManager.findById(id)
        if (
          currentConversation &&
          (force || isUntitledConversationTitle(currentConversation.title))
        ) {
          await chatManager.updateChat(
            id,
            { title: generatedTitle },
            {
              touchUpdatedAt: false,
            },
          )
          emitChatHistoryUpdated()
          await fetchChatList()
        }
      } finally {
        titleGenerationInFlightRef.current.delete(id)
      }
    },
    [
      chatManager,
      fetchChatList,
      handleAutoPromoteTransportMode,
      language,
      settings,
      emitChatHistoryUpdated,
    ],
  )

  return {
    createOrUpdateConversation,
    createOrUpdateConversationImmediately,
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
        snapshotRef: message.snapshotRef,
        id: message.id,
        mentionables: message.mentionables
          .map((m) => deserializeMentionable(m, app))
          .filter((m): m is Mentionable => m !== null),
        selectedSkills: message.selectedSkills ?? [],
        reasoningLevel: message.reasoningLevel,
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
