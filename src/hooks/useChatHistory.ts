import debounce from 'lodash.debounce'
import isEqual from 'lodash.isequal'
import { App } from 'obsidian'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { DEFAULT_UNTITLED_CONVERSATION_TITLE } from '../constants'
import { useApp } from '../contexts/app-context'
import { useLanguage } from '../contexts/language-context'
import { usePlugin } from '../contexts/plugin-context'
import { useSettings } from '../contexts/settings-context'
import type { AutoPromotedTransportMode } from '../core/llm/requestTransport'
import { promoteProviderTransportModeToObsidian } from '../core/llm/transportModePromotion'
import { batchLookupImageCache } from '../database/json/chat/imageCacheStore'
import { compactConversationMessagesForStorage } from '../database/json/chat/promptSnapshotStore'
import { ChatConversationMetadata } from '../database/json/chat/types'
import type { ChatConversationCliSession } from '../database/json/chat/types'
import {
  ChatConversationCompactionLike,
  ChatConversationCompactionState,
  ChatMessage,
  SerializedChatMessage,
  normalizeChatConversationCompactionState,
} from '../types/chat'
import { ConversationOverrideSettings } from '../types/conversation-settings.types'
import { Mentionable } from '../types/mentionable'
import { ToolCallResponseStatus } from '../types/tool-call.types'
import {
  getConversationDisplayTitle,
  isUntitledConversationTitle,
} from '../utils/chat/conversationTitle'
import {
  AUTO_TITLE_FAILURE_COOLDOWN_MS,
  generateConversationTitleText,
} from '../utils/chat/generateConversationTitle'
import {
  deserializeMentionable,
  serializeMentionable,
} from '../utils/chat/mentionable'

import { useChatManager } from './useJsonManagers'

const AUTO_TITLE_WAIT_CONVERSATION_RETRIES = 15
const AUTO_TITLE_WAIT_CONVERSATION_INTERVAL_MS = 200
const CHAT_HISTORY_UPDATED_EVENT = 'yolo:chat-history-updated'

export { getConversationDisplayTitle, isUntitledConversationTitle }

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
  /**
   * 字段级更新：只写会话行上的 `activeBranchByUserMessageId`，不碰 messages。
   *
   * 分支选择是纯 UI 元数据，而 messages 的权威来源在生成期间是 AgentService。
   * 让分支切换顺带写一份 UI 手里的 messages 快照，就等于用一份可能落后整个
   * 生成阶段的正文覆盖数据库——两条写入不共享同一条串行链，谁后落地谁说了算。
   */
  updateConversationActiveBranches: (
    id: string,
    activeBranchByUserMessageId: ReadonlyMap<string, string>,
  ) => Promise<void>
  createOrTouchCliConversation: (
    id: string,
    cliSession: ChatConversationCliSession,
    overrides?: ConversationOverrideSettings | null,
  ) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  getChatMessagesById: (id: string) => Promise<ChatMessage[] | null>
  getConversationById: (id: string) => Promise<{
    messages: ChatMessage[]
    overrides: ConversationOverrideSettings | null | undefined
    assistantId?: string
    conversationModelId?: string
    messageModelMap?: Record<string, string>
    activeBranchByUserMessageId?: Record<string, string>
    assistantGroupBoundaryMessageIds?: string[]
    reasoningLevel?: string
    compaction?: ChatConversationCompactionState
    cliSession?: ChatConversationCliSession
  } | null>
  updateConversationTitle: (id: string, title: string) => Promise<void>
  toggleConversationPinned: (id: string) => Promise<void>
  generateConversationTitle: (
    id: string,
    messages: ChatMessage[],
    options?: {
      force?: boolean
    },
  ) => Promise<string | null>
  chatList: ChatConversationMetadata[]
}

export function useChatHistory(): UseChatHistory {
  const app = useApp()
  const plugin = usePlugin()
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
    (providerId: string, mode: AutoPromotedTransportMode) => {
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
    window.addEventListener('yolo:chat-history-cleared', handler)
    window.addEventListener(CHAT_HISTORY_UPDATED_EVENT, handler)
    return () => {
      window.removeEventListener('yolo:chat-history-cleared', handler)
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
      const serializedMessages = messages.map(serializeChatMessage)
      const existingConversation = await chatManager.findById(id)
      // 「一条消息都没有」不等于「这个会话不该存在」：从未发过消息的新会话不建行，
      // 但已存在的会话被清空后仍然是同一个会话，必须把空消息写回去，否则重新加载
      // 会把删掉的消息复活。判据是会话行在不在，不是消息数。
      if (messages.length === 0 && !existingConversation) {
        return
      }
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
          isEqual(
            existingConversation.activeBranchByUserMessageId ?? null,
            activeBranchByUserMessageId ?? null,
          ) &&
          isEqual(
            existingConversation.assistantGroupBoundaryMessageIds ?? null,
            assistantGroupBoundaryMessageIds ?? null,
          ) &&
          existingConversation.reasoningLevel === reasoningLevel &&
          isEqual(existingCompaction, normalizedCompaction)
        ) {
          return
        }
        await chatManager.updateChat(
          existingConversation.id,
          {
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
            activeBranchByUserMessageId:
              activeBranchByUserMessageId === undefined
                ? existingConversation.activeBranchByUserMessageId
                : activeBranchByUserMessageId,
            assistantGroupBoundaryMessageIds:
              assistantGroupBoundaryMessageIds === undefined
                ? existingConversation.assistantGroupBoundaryMessageIds
                : assistantGroupBoundaryMessageIds,
            reasoningLevel,
            compaction:
              compaction === undefined
                ? existingCompaction
                : normalizedCompaction,
          },
          options?.touchUpdatedAt === undefined
            ? undefined
            : { touchUpdatedAt: options.touchUpdatedAt },
        )
      } else {
        // 默认写空串 sentinel，待首条用户消息保存后由对话命名模型自动改名；
        // 仍未命名时由显示层按当前语言渲染本地化文案
        const defaultTitle = DEFAULT_UNTITLED_CONVERSATION_TITLE

        await chatManager.createChat({
          id,
          title: defaultTitle,
          messages: compactedMessages,
          overrides: overrides ?? null,
          conversationModelId,
          messageModelMap,
          activeBranchByUserMessageId,
          assistantGroupBoundaryMessageIds,
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

  const updateConversationActiveBranches = useCallback(
    async (
      id: string,
      activeBranchByUserMessageId: ReadonlyMap<string, string>,
    ): Promise<void> => {
      const existingConversation = await chatManager.findById(id)
      // 会话行还没建立时无事可做：分支选择留在内存里，下一次完整持久化会
      // 连同 messages 一起写出去。
      if (!existingConversation) {
        return
      }
      // 与完整持久化同一套裁剪规则，只是按数据库行里的 user 消息判定——
      // 这次写入的对象就是这一行，能被它引用的键也只有它自己的消息。
      const validUserMessageIds = new Set(
        existingConversation.messages
          .filter((message) => message.role === 'user')
          .map((message) => message.id),
      )
      const entries = Array.from(activeBranchByUserMessageId.entries()).filter(
        ([userMessageId, branchId]) =>
          validUserMessageIds.has(userMessageId) && branchId.trim().length > 0,
      )
      const nextActiveBranchByUserMessageId =
        entries.length > 0 ? Object.fromEntries(entries) : undefined
      if (
        isEqual(
          existingConversation.activeBranchByUserMessageId ?? null,
          nextActiveBranchByUserMessageId ?? null,
        )
      ) {
        return
      }

      await chatManager.updateChat(id, {
        activeBranchByUserMessageId: nextActiveBranchByUserMessageId,
      })
      emitChatHistoryUpdated()
      await fetchChatList()
    },
    [chatManager, emitChatHistoryUpdated, fetchChatList],
  )

  const createOrTouchCliConversation = useCallback(
    async (
      id: string,
      cliSession: ChatConversationCliSession,
      overrides?: ConversationOverrideSettings | null,
    ): Promise<void> => {
      const existingConversation = await chatManager.findById(id)
      if (existingConversation) {
        await chatManager.updateChat(id, {
          cliSession,
          ...(overrides !== undefined ? { overrides } : {}),
        })
      } else {
        await chatManager.createChat({
          id,
          title: DEFAULT_UNTITLED_CONVERSATION_TITLE,
          messages: [],
          cliSession,
          ...(overrides !== undefined ? { overrides } : {}),
        })
      }
      emitChatHistoryUpdated()
      await fetchChatList()
    },
    [chatManager, emitChatHistoryUpdated, fetchChatList],
  )

  const deleteConversation = useCallback(
    async (id: string): Promise<void> => {
      await chatManager.deleteChat(id)
      plugin.getAgentService().dropConversation(id)
      emitChatHistoryUpdated()
      await fetchChatList()
    },
    [chatManager, plugin, emitChatHistoryUpdated, fetchChatList],
  )

  const getChatMessagesById = useCallback(
    async (id: string): Promise<ChatMessage[] | null> => {
      const conversation = await chatManager.findById(id)
      if (!conversation) {
        return null
      }
      const messages = conversation.messages.map((message) =>
        deserializeChatMessage(message, app),
      )
      await hydrateImageCacheRefs(messages, app, settingsRef.current)
      return messages
    },
    [chatManager, app],
  )

  const getConversationById = useCallback(
    async (
      id: string,
    ): Promise<{
      messages: ChatMessage[]
      overrides: ConversationOverrideSettings | null | undefined
      assistantId?: string
      conversationModelId?: string
      messageModelMap?: Record<string, string>
      activeBranchByUserMessageId?: Record<string, string>
      assistantGroupBoundaryMessageIds?: string[]
      reasoningLevel?: string
      compaction?: ChatConversationCompactionState
      cliSession?: ChatConversationCliSession
    } | null> => {
      const conversation = await chatManager.findById(id)
      if (!conversation) return null
      const messages = conversation.messages.map((m) =>
        deserializeChatMessage(m, app),
      )
      await hydrateImageCacheRefs(messages, app, settingsRef.current)
      return {
        messages,
        overrides: conversation.overrides,
        assistantId: conversation.assistantId,
        conversationModelId: conversation.conversationModelId,
        messageModelMap: conversation.messageModelMap,
        activeBranchByUserMessageId: conversation.activeBranchByUserMessageId,
        assistantGroupBoundaryMessageIds:
          conversation.assistantGroupBoundaryMessageIds,
        reasoningLevel: conversation.reasoningLevel,
        compaction: normalizeChatConversationCompactionState(
          conversation.compaction,
        ),
        cliSession: conversation.cliSession,
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
    ): Promise<string | null> => {
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
        return null
      }

      if (titleGenerationInFlightRef.current.has(id)) {
        logTitleEvent('in_flight')
        return null
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
          return null
        }

        // 如果标题已经命名过了，不需要再次命名
        if (!force && !isUntitledConversationTitle(conversation.title)) {
          logTitleEvent('already_titled')
          return null
        }

        const firstUserMessage = messages.find(
          (message) => message.role === 'user',
        )
        if (!firstUserMessage) {
          logTitleEvent('no_user_signal')
          return null
        }

        const result = await generateConversationTitleText({
          settings,
          language,
          messages,
          onAutoPromoteTransportMode: handleAutoPromoteTransportMode,
          debug: {
            conversationId: id,
            sourceUserMessageId: firstUserMessage.id,
          },
        })

        if (!result.ok) {
          logTitleEvent(result.reason)
          if (result.reason === 'llm_generation_failed') {
            const errorMessage =
              result.error instanceof Error
                ? result.error.message
                : typeof result.error === 'string'
                  ? result.error
                  : result.error
                    ? JSON.stringify(result.error)
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
          }
          return null
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
            { title: result.title },
            {
              touchUpdatedAt: false,
            },
          )
          emitChatHistoryUpdated()
          await fetchChatList()
          return result.title
        }
        return null
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
    updateConversationActiveBranches,
    createOrTouchCliConversation,
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
        selectedModelIds: message.selectedModelIds ?? [],
        reasoningLevel: message.reasoningLevel,
        timeContext: message.timeContext,
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
        metadata: message.metadata,
      }
    case 'external_agent_result':
    case 'subagent_result':
    case 'terminal_command_result':
      return message
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
        selectedModelIds: message.selectedModelIds ?? [],
        reasoningLevel: message.reasoningLevel,
        timeContext: message.timeContext,
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
        metadata: message.metadata,
      }
    case 'external_agent_result':
    case 'subagent_result':
    case 'terminal_command_result':
      return message
  }
}

/**
 * Hydrate cache:// refs in tool message contentParts back to data URLs.
 * Mutates messages in place for efficiency.
 */
const hydrateImageCacheRefs = async (
  messages: ChatMessage[],
  app: App,
  settings?: { yolo?: { baseDir?: string } } | null,
): Promise<void> => {
  // Collect all cache keys that need resolution
  const cacheKeys = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'tool') continue
    for (const tc of msg.toolCalls) {
      if (tc.response.status !== ToolCallResponseStatus.Success) continue
      const parts = tc.response.data.contentParts
      if (!parts) continue
      for (const part of parts) {
        if (
          part.type === 'image_url' &&
          part.image_url.url.startsWith('cache://')
        ) {
          cacheKeys.add(part.image_url.cacheKey ?? part.image_url.url.slice(8))
        }
      }
    }
  }

  if (cacheKeys.size === 0) return

  // Batch lookup
  const resolved = await batchLookupImageCache(
    app,
    Array.from(cacheKeys),
    settings,
  )

  // Replace cache refs with resolved data URLs
  for (const msg of messages) {
    if (msg.role !== 'tool') continue
    for (const tc of msg.toolCalls) {
      if (tc.response.status !== ToolCallResponseStatus.Success) continue
      const parts = tc.response.data.contentParts
      if (!parts) continue
      for (const part of parts) {
        if (
          part.type === 'image_url' &&
          part.image_url.url.startsWith('cache://')
        ) {
          const key = part.image_url.cacheKey ?? part.image_url.url.slice(8)
          const dataUrl = resolved.get(key)
          if (dataUrl) {
            part.image_url.url = dataUrl
          }
        }
      }
    }
  }
}
