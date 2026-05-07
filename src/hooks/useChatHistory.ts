import debounce from 'lodash.debounce'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { editorStateToPlainText } from '../components/chat-view/chat-input/utils/editor-state-to-plain-text'
import {
  DEFAULT_CHAT_TITLE_PROMPT,
  DEFAULT_UNTITLED_CONVERSATION_TITLE,
} from '../constants'
import { useLanguage } from '../contexts/language-context'
import { useSettings } from '../contexts/settings-context'
import { getChatModelClient } from '../core/llm/manager'
import { promoteProviderTransportModeToObsidian } from '../core/llm/transportModePromotion'
import { ChatConversationMetadata } from '../database/json/chat/types'
import {
  ChatConversationCompactionLike,
  ChatConversationCompactionState,
  ChatMessage,
  ChatSelectedSkill,
  ChatUserMessage,
  normalizeChatConversationCompactionState,
} from '../types/chat'
import { ConversationOverrideSettings } from '../types/conversation-settings.types'
import { useYoloRuntime } from '../runtime'

const LEGACY_UNTITLED_CONVERSATION_TITLES = new Set([
  '新消息',
  DEFAULT_UNTITLED_CONVERSATION_TITLE,
])
const AUTO_TITLE_TIMEOUT_MS = 10000
const AUTO_TITLE_MAX_RETRIES = 2
const AUTO_TITLE_FAILURE_COOLDOWN_MS = 5 * 60 * 1000
const AUTO_TITLE_WAIT_CONVERSATION_RETRIES = 15
const AUTO_TITLE_WAIT_CONVERSATION_INTERVAL_MS = 200
const CHAT_HISTORY_UPDATED_EVENT = 'smtcmp:chat-history-updated'

const isUntitledConversationTitle = (title: string): boolean =>
  LEGACY_UNTITLED_CONVERSATION_TITLES.has(title)

const formatSelectedSkillsForTitleInput = (
  selectedSkills: ChatSelectedSkill[],
): string => {
  const skillNames = selectedSkills
    .map((skill) => skill.name.trim())
    .filter((name) => name.length > 0)

  if (skillNames.length === 0) {
    return '[User selected only skills without text.]'
  }

  return `[User selected skills: ${skillNames.join(', ')}]`
}

const extractTextFromPromptContent = (
  promptContent: ChatUserMessage['promptContent'],
): string => {
  if (!promptContent) return ''
  if (typeof promptContent === 'string') return promptContent.trim()
  return promptContent
    .filter((part) => part.type === 'text')
    .map((part) => part.text.trim())
    .filter((text) => text.length > 0)
    .join('\n\n')
}

type UseChatHistory = {
  createOrUpdateConversation: (
    id: string,
    messages: ChatMessage[],
    overrides?: ConversationOverrideSettings | null,
    conversationModelId?: string,
    messageModelMap?: Record<string, string>,
    activeBranchByUserMessageId?: Record<string, string>,
    reasoningLevel?: string,
    compaction?: ChatConversationCompactionState,
    assistantGroupBoundaryMessageIds?: string[],
  ) => Promise<void> | undefined
  createOrUpdateConversationImmediately: (
    id: string,
    messages: ChatMessage[],
    overrides?: ConversationOverrideSettings | null,
    conversationModelId?: string,
    messageModelMap?: Record<string, string>,
    activeBranchByUserMessageId?: Record<string, string>,
    reasoningLevel?: string,
    compaction?: ChatConversationCompactionState,
    assistantGroupBoundaryMessageIds?: string[],
    options?: { touchUpdatedAt?: boolean },
  ) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  getChatMessagesById: (id: string) => Promise<ChatMessage[] | null>
  getConversationById: (id: string) => Promise<{
    messages: ChatMessage[]
    overrides: ConversationOverrideSettings | null | undefined
    conversationModelId?: string
    messageModelMap?: Record<string, string>
    activeBranchByUserMessageId?: Record<string, string>
    assistantGroupBoundaryMessageIds?: string[]
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
  const runtime = useYoloRuntime()
  const { settings, setSettings } = useSettings()
  const { language } = useLanguage()
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
    setChatList(await runtime.chat.list())
  }, [runtime])

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
      activeBranchByUserMessageId?: Record<string, string>,
      reasoningLevel?: string,
      compaction?: ChatConversationCompactionLike | null,
      assistantGroupBoundaryMessageIds?: string[],
      options?: { touchUpdatedAt?: boolean },
    ): Promise<void> => {
      await runtime.chat.save({
        id,
        messages,
        overrides,
        conversationModelId,
        messageModelMap,
        activeBranchByUserMessageId,
        assistantGroupBoundaryMessageIds,
        reasoningLevel,
        compaction:
          compaction === undefined
            ? undefined
            : normalizeChatConversationCompactionState(compaction),
        touchUpdatedAt: options?.touchUpdatedAt,
      })

      emitChatHistoryUpdated()
      await fetchChatList()
    },
    [emitChatHistoryUpdated, fetchChatList, runtime],
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
      activeBranchByUserMessageId?: Record<string, string>,
      reasoningLevel?: string,
      compaction?: ChatConversationCompactionState,
      assistantGroupBoundaryMessageIds?: string[],
    ): Promise<void> | undefined =>
      debouncedCreateOrUpdateConversation(
        id,
        messages,
        overrides,
        conversationModelId,
        messageModelMap,
        activeBranchByUserMessageId,
        reasoningLevel,
        compaction,
        assistantGroupBoundaryMessageIds,
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
      activeBranchByUserMessageId?: Record<string, string>,
      reasoningLevel?: string,
      compaction?: ChatConversationCompactionState,
      assistantGroupBoundaryMessageIds?: string[],
      options?: { touchUpdatedAt?: boolean },
    ): Promise<void> => {
      debouncedCreateOrUpdateConversation.cancel()
      await persistConversationInternal(
        id,
        messages,
        overrides,
        conversationModelId,
        messageModelMap,
        activeBranchByUserMessageId,
        reasoningLevel,
        compaction,
        assistantGroupBoundaryMessageIds,
        options,
      )
    },
    [debouncedCreateOrUpdateConversation, persistConversationInternal],
  )

  const deleteConversation = useCallback(
    async (id: string): Promise<void> => {
      await runtime.chat.delete(id)
      emitChatHistoryUpdated()
      await fetchChatList()
    },
    [emitChatHistoryUpdated, fetchChatList, runtime],
  )

  const getChatMessagesById = useCallback(
    async (id: string): Promise<ChatMessage[] | null> => {
      const conversation = await runtime.chat.get(id)
      return conversation?.messages ?? null
    },
    [runtime],
  )

  const getConversationById = useCallback(
    async (
      id: string,
    ): Promise<{
      messages: ChatMessage[]
      overrides: ConversationOverrideSettings | null | undefined
      conversationModelId?: string
      messageModelMap?: Record<string, string>
      activeBranchByUserMessageId?: Record<string, string>
      assistantGroupBoundaryMessageIds?: string[]
      reasoningLevel?: string
      compaction?: ChatConversationCompactionState
    } | null> => {
      const conversation = await runtime.chat.get(id)
      if (!conversation) return null
      return {
        messages: conversation.messages,
        overrides: conversation.overrides,
        conversationModelId: conversation.conversationModelId,
        messageModelMap: conversation.messageModelMap,
        activeBranchByUserMessageId: conversation.activeBranchByUserMessageId,
        assistantGroupBoundaryMessageIds:
          conversation.assistantGroupBoundaryMessageIds,
        reasoningLevel: conversation.reasoningLevel,
        compaction: normalizeChatConversationCompactionState(
          conversation.compaction,
        ),
      }
    },
    [runtime],
  )

  const updateConversationTitle = useCallback(
    async (id: string, title: string): Promise<void> => {
      if (title.length === 0) {
        throw new Error('Chat title cannot be empty')
      }
      const conversation = await runtime.chat.get(id)
      if (!conversation) {
        throw new Error('Conversation not found')
      }
      await runtime.chat.updateTitle(id, title)
      emitChatHistoryUpdated()
      await fetchChatList()
    },
    [emitChatHistoryUpdated, fetchChatList, runtime],
  )

  const toggleConversationPinned = useCallback(
    async (id: string): Promise<void> => {
      const conversation =
        chatList.find((chat) => chat.id === id) ??
        (await runtime.chat.list()).find((chat) => chat.id === id) ??
        null
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
        await runtime.chat.togglePinned(conversation.id)
      } finally {
        emitChatHistoryUpdated()
        await fetchChatList()
      }
    },
    [chatList, emitChatHistoryUpdated, fetchChatList, runtime],
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
        const readConversation = async () => runtime.chat.get(id)
        const updateGeneratedTitle = async (title: string) =>
          runtime.chat.updateTitle(id, title, {
            touchUpdatedAt: false,
          })

        // 等待对话存在（最多等待 3 秒，每 200ms 检查一次）
        // 这是为了处理 debounce 导致的保存延迟
        let conversation = null
        for (let i = 0; i < AUTO_TITLE_WAIT_CONVERSATION_RETRIES; i++) {
          conversation = await readConversation()
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

        // Reuse the same expanded prompt that gets sent to the chat model so
        // the title model sees referenced files / URLs / blocks / quotes
        // without re-running compilation or doing extra I/O here.
        const compiledText = extractTextFromPromptContent(
          firstUserMessage.promptContent,
        )

        const userContext =
          compiledText.length > 0
            ? compiledText
            : normalizedUserText.length > 0
              ? normalizedUserText
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
        const currentConversation = await readConversation()
        if (
          currentConversation &&
          (force || isUntitledConversationTitle(currentConversation.title))
        ) {
          await updateGeneratedTitle(generatedTitle)
          emitChatHistoryUpdated()
          await fetchChatList()
        }
      } finally {
        titleGenerationInFlightRef.current.delete(id)
      }
    },
    [
      fetchChatList,
      handleAutoPromoteTransportMode,
      language,
      settings,
      emitChatHistoryUpdated,
      runtime,
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
