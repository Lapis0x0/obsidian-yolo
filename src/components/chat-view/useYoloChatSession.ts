import { Notice } from 'obsidian'
import {
  Dispatch,
  MutableRefObject,
  SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { v4 as uuidv4 } from 'uuid'

import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
import { useSettings } from '../../contexts/settings-context'
import { DEFAULT_ASSISTANT_ID } from '../../core/agent/default-assistant'
import type { AgentConversationRunSummary } from '../../core/agent/service'
import {
  type ChatRuntimeId,
  type CliChatMode,
  type CliConversationController,
  type CliRuntimeId,
  type CliRuntimeScope,
  type CliSessionRef,
} from '../../core/cli-runtime'
import {
  getConversationDisplayTitle,
  type useChatHistory,
} from '../../hooks/useChatHistory'
import type { Assistant } from '../../types/assistant.types'
import type {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
  ChatConversationCompactionState,
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'
import type { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import type { MentionableBlockData } from '../../types/mentionable'
import type { ReasoningLevel } from '../../types/reasoning'
import { normalizeHydratedConversationMessages } from '../../utils/chat/conversationHydration'
import { groupAssistantAndToolMessages } from '../../utils/chat/message-groups'
import {
  collectSelectionHighlightIdsFromMessages,
  createSelectionBlockMentionable,
} from '../../utils/chat/selection-mentionables'

import {
  type ChatMode,
  normalizeChatMode,
  normalizeYoloEnabled,
} from './chat-input/ChatModeSelect'
import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'
import {
  beginChatRuntimeNavigation,
  openCliSessionForNavigation,
  prepareCliConversation,
} from './cliChatIntegration'
import { resolveCliModePreference } from './cliRuntimePreferences'
import type { QueryProgressState } from './QueryProgress'
import type { useChatStreamManager } from './useChatStreamManager'

/**
 * 会话分支状态的可持久化裁剪：只保留仍存在于 messages 中的 user 消息 id，
 * 且分支 id 非空的条目。与 Chat.tsx 迁移前的模块级同名函数保持一致。
 */
export const serializeActiveBranchByUserMessageId = (
  messages: ChatMessage[],
  activeBranchByUserMessageId: ReadonlyMap<string, string>,
): Record<string, string> | undefined => {
  const validUserMessageIds = new Set(
    messages
      .filter((message): message is ChatUserMessage => message.role === 'user')
      .map((message) => message.id),
  )

  const entries = Array.from(activeBranchByUserMessageId.entries()).filter(
    ([userMessageId, branchId]) =>
      validUserMessageIds.has(userMessageId) && branchId.trim().length > 0,
  )

  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

export type UseYoloChatSessionParams = {
  // Props
  initialConversationId: string | undefined
  onConversationContextChange:
    | ((context: {
        currentConversationId?: string
        currentConversationPersisted?: boolean
        currentConversationTitle?: string
        currentModelId?: string
        currentOverrides?: ConversationOverrideSettings
      }) => void)
    | undefined

  // Chat history (single `useChatHistory()` instance owned by Chat.tsx)
  createOrUpdateConversation: ReturnType<
    typeof useChatHistory
  >['createOrUpdateConversation']
  createOrUpdateConversationImmediately: ReturnType<
    typeof useChatHistory
  >['createOrUpdateConversationImmediately']
  deleteConversation: ReturnType<typeof useChatHistory>['deleteConversation']
  getConversationById: ReturnType<typeof useChatHistory>['getConversationById']
  updateConversationTitle: ReturnType<
    typeof useChatHistory
  >['updateConversationTitle']
  chatList: ReturnType<typeof useChatHistory>['chatList']

  // Stream manager (single instance owned by Chat.tsx)
  submitChatMutation: ReturnType<
    typeof useChatStreamManager
  >['submitChatMutation']

  // Message/session identity — raw state stays declared in Chat.tsx (shared
  // with useChatInputController and useCliRuntimeOrchestration), threaded in
  // the same way it already is for those hooks.
  chatMessagesStateRef: MutableRefObject<ChatMessage[]>
  chatMessages: ChatMessage[]
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>
  currentConversationId: string
  setCurrentConversationId: Dispatch<SetStateAction<string>>
  activeBranchByUserMessageIdRef: MutableRefObject<Map<string, string>>
  setActiveBranchByUserMessageId: Dispatch<SetStateAction<Map<string, string>>>
  assistantGroupBoundaryMessageIds: string[]
  setAssistantGroupBoundaryMessageIds: Dispatch<SetStateAction<string[]>>
  isCurrentConversationRunActive: boolean
  effectiveCompactionState: ChatConversationCompactionState

  // Per-conversation preference maps/refs owned by Chat.tsx
  messageModelMap: Map<string, string>
  setMessageModelMap: Dispatch<SetStateAction<Map<string, string>>>
  messageReasoningMap: Map<string, ReasoningLevel>
  setMessageReasoningMap: Dispatch<SetStateAction<Map<string, ReasoningLevel>>>
  conversationOverrides: ConversationOverrideSettings | null
  setConversationOverrides: Dispatch<
    SetStateAction<ConversationOverrideSettings | null>
  >
  conversationOverridesRef: MutableRefObject<
    Map<string, ConversationOverrideSettings | null>
  >
  conversationModelId: string
  setConversationModelId: Dispatch<SetStateAction<string>>
  conversationModelIdRef: MutableRefObject<Map<string, string>>
  conversationAssistantId: string
  setConversationAssistantId: Dispatch<SetStateAction<string>>
  conversationAssistantIdRef: MutableRefObject<Map<string, string>>
  reasoningLevel: ReasoningLevel
  setReasoningLevel: Dispatch<SetStateAction<ReasoningLevel>>
  conversationReasoningLevelRef: MutableRefObject<Map<string, ReasoningLevel>>
  chatMode: ChatMode
  setChatMode: Dispatch<SetStateAction<ChatMode>>
  yoloEnabled: boolean
  setYoloEnabled: Dispatch<SetStateAction<boolean>>
  selectedAssistant: Assistant | null
  setCompactionState: Dispatch<SetStateAction<ChatConversationCompactionState>>
  setPendingCompactionAnchorMessageId: Dispatch<SetStateAction<string | null>>
  setEditingAssistantMessageId: Dispatch<SetStateAction<string | null>>
  setIsLoadingConversation: Dispatch<SetStateAction<boolean>>
  setQueryProgress: Dispatch<SetStateAction<QueryProgressState>>
  setAddedBlockKey: Dispatch<SetStateAction<string | null>>

  // Input controller integration
  inputMessageId: string
  getLatestInputMessage: () => ChatUserMessage
  replaceInputMessage: (message: ChatUserMessage) => void
  buildNewInputMessage: (reasoningLevel: ReasoningLevel) => ChatUserMessage
  setInputMessage: Dispatch<SetStateAction<ChatUserMessage>>
  setFocusedMessageId: Dispatch<SetStateAction<string | null>>
  releaseHighlightIds: (ids: readonly string[]) => void

  // Preference helpers owned by Chat.tsx (unmoved)
  normalizeReasoningLevel: (value?: string) => ReasoningLevel | null
  getReasoningLevelForModelId: (modelId?: string | null) => ReasoningLevel
  persistChatRuntimePreference: (runtimeId: ChatRuntimeId) => void

  // CLI runtime orchestration (single instance owned by Chat.tsx, called
  // before this hook)
  cliRuntimeScope: CliRuntimeScope | undefined
  cliRuntimeAvailable: boolean
  activeRuntimeId: ChatRuntimeId
  activeRuntimeIdRef: MutableRefObject<ChatRuntimeId>
  setRequestedRuntimeId: Dispatch<SetStateAction<ChatRuntimeId>>
  lastCliRuntimeIdRef: MutableRefObject<CliRuntimeId>
  cliModeRequestGenerationRef: MutableRefObject<number>
  runtimeNavigationGenerationRef: MutableRefObject<number>
  chatMountedRef: MutableRefObject<boolean>
  prePlanCliModeByConversationRef: MutableRefObject<
    Map<string, { mode: 'agent'; yoloEnabled: boolean }>
  >
  setCliChatMode: Dispatch<SetStateAction<CliChatMode>>
  setCliYoloEnabled: Dispatch<SetStateAction<boolean>>
  setCliConversationController: Dispatch<
    SetStateAction<CliConversationController | null>
  >
  setCliConversationId: Dispatch<SetStateAction<string | null>>
  transitionCliSession: (
    action: (isCurrent: () => boolean) => void | Promise<void>,
  ) => Promise<boolean>
  createFreshCliConversation: (
    runtimeId: CliRuntimeId,
  ) => CliConversationController | null
}

/**
 * Yolo 会话领域：消息状态维护、持久化、加载（Yolo / CLI 会话入口）、用户与
 * assistant 消息的编辑/删除/分支、run summaries 与排队消息订阅。
 *
 * 纯 React 状态编排——不触碰持久化层实现（createOrUpdateConversation 等经
 * useChatHistory() 单例透传），也不重造 cliChatIntegration.ts 的逻辑。
 */
export function useYoloChatSession({
  initialConversationId,
  onConversationContextChange,
  createOrUpdateConversation,
  createOrUpdateConversationImmediately,
  deleteConversation,
  getConversationById,
  updateConversationTitle,
  chatList,
  submitChatMutation,
  chatMessagesStateRef,
  chatMessages,
  setChatMessages,
  currentConversationId,
  setCurrentConversationId,
  activeBranchByUserMessageIdRef,
  setActiveBranchByUserMessageId,
  assistantGroupBoundaryMessageIds,
  setAssistantGroupBoundaryMessageIds,
  isCurrentConversationRunActive,
  effectiveCompactionState,
  messageModelMap,
  setMessageModelMap,
  messageReasoningMap,
  setMessageReasoningMap,
  conversationOverrides,
  setConversationOverrides,
  conversationOverridesRef,
  conversationModelId,
  setConversationModelId,
  conversationModelIdRef,
  conversationAssistantId,
  setConversationAssistantId,
  conversationAssistantIdRef,
  reasoningLevel,
  setReasoningLevel,
  conversationReasoningLevelRef,
  chatMode,
  setChatMode,
  yoloEnabled,
  setYoloEnabled,
  selectedAssistant,
  setCompactionState,
  setPendingCompactionAnchorMessageId,
  setEditingAssistantMessageId,
  setIsLoadingConversation,
  setQueryProgress,
  setAddedBlockKey,
  inputMessageId,
  getLatestInputMessage,
  replaceInputMessage,
  buildNewInputMessage,
  setInputMessage,
  setFocusedMessageId,
  releaseHighlightIds,
  normalizeReasoningLevel,
  getReasoningLevelForModelId,
  persistChatRuntimePreference,
  cliRuntimeScope,
  cliRuntimeAvailable,
  activeRuntimeId,
  activeRuntimeIdRef,
  setRequestedRuntimeId,
  lastCliRuntimeIdRef,
  cliModeRequestGenerationRef,
  runtimeNavigationGenerationRef,
  chatMountedRef,
  prePlanCliModeByConversationRef,
  setCliChatMode,
  setCliYoloEnabled,
  setCliConversationController,
  setCliConversationId,
  transitionCliSession,
  createFreshCliConversation,
}: UseYoloChatSessionParams) {
  const plugin = usePlugin()
  const agentService = plugin.getAgentService()
  const { settings } = useSettings()
  const { t } = useLanguage()

  const [runSummariesByConversationId, setRunSummariesByConversationId] =
    useState<Map<string, AgentConversationRunSummary>>(new Map())
  const [queuedUserMessages, setQueuedUserMessages] = useState<
    ChatUserMessage[]
  >(() => agentService.peekPendingUserMessages(currentConversationId))

  const serializeMessageModelMap = useCallback(
    (
      messages: ChatMessage[],
      sourceMap: Map<string, string> = messageModelMap,
    ): Record<string, string> | undefined => {
      const persistedEntries = messages.flatMap((message) => {
        if (message.role !== 'user') {
          return []
        }
        const modelId = sourceMap.get(message.id)
        return modelId ? [[message.id, modelId] as const] : []
      })
      return persistedEntries.length > 0
        ? Object.fromEntries(persistedEntries)
        : undefined
    },
    [messageModelMap],
  )

  const normalizeAssistantGroupBoundaryMessageIds = useCallback(
    (messages: ChatMessage[], sourceIds: readonly string[]): string[] => {
      const availableNonUserMessageIds = new Set(
        messages
          .filter(
            (message): message is ChatAssistantMessage | ChatToolMessage =>
              message.role === 'assistant' || message.role === 'tool',
          )
          .map((message) => message.id),
      )

      return sourceIds.filter((messageId, index) => {
        return (
          availableNonUserMessageIds.has(messageId) &&
          sourceIds.indexOf(messageId) === index
        )
      })
    },
    [],
  )

  const buildAssistantGroupBoundaryMessageIdsAfterUserRemoval = useCallback(
    (
      sourceMessages: ChatMessage[],
      nextMessages: ChatMessage[],
      existingBoundaryMessageIds: readonly string[],
    ): string[] => {
      const retainedMessageIds = new Set(
        nextMessages.map((message) => message.id),
      )
      const nextBoundaryMessageIds = [
        ...normalizeAssistantGroupBoundaryMessageIds(
          nextMessages,
          existingBoundaryMessageIds,
        ),
      ]
      let lastRetainedNonUserMessageId: string | null = null
      let sawRemovedUserAfterRetainedNonUser = false

      sourceMessages.forEach((message) => {
        const isRetained = retainedMessageIds.has(message.id)

        if (!isRetained) {
          if (message.role === 'user' && lastRetainedNonUserMessageId) {
            sawRemovedUserAfterRetainedNonUser = true
          }
          return
        }

        if (message.role === 'user') {
          lastRetainedNonUserMessageId = null
          sawRemovedUserAfterRetainedNonUser = false
          return
        }

        if (
          lastRetainedNonUserMessageId &&
          sawRemovedUserAfterRetainedNonUser
        ) {
          nextBoundaryMessageIds.push(message.id)
        }

        lastRetainedNonUserMessageId = message.id
        sawRemovedUserAfterRetainedNonUser = false
      })

      return normalizeAssistantGroupBoundaryMessageIds(
        nextMessages,
        nextBoundaryMessageIds,
      )
    },
    [normalizeAssistantGroupBoundaryMessageIds],
  )

  const persistConversation = useCallback(
    async (
      messages: ChatMessage[],
      assistantGroupBoundaryIdsOverride?: readonly string[],
    ) => {
      if (messages.length === 0) return
      try {
        const effectiveOverrides = {
          ...(conversationOverrides ?? {}),
          chatMode,
          agentYoloEnabled: yoloEnabled,
        }
        await createOrUpdateConversation(
          currentConversationId,
          messages,
          effectiveOverrides,
          conversationModelId,
          serializeMessageModelMap(messages),
          serializeActiveBranchByUserMessageId(
            messages,
            activeBranchByUserMessageIdRef.current,
          ),
          conversationReasoningLevelRef.current.get(currentConversationId) ??
            reasoningLevel,
          effectiveCompactionState,
          normalizeAssistantGroupBoundaryMessageIds(
            messages,
            assistantGroupBoundaryIdsOverride ??
              assistantGroupBoundaryMessageIds,
          ),
        )
      } catch (error) {
        new Notice('Failed to save chat history')
        console.error('Failed to save chat history', error)
      }
    },
    [
      chatMode,
      yoloEnabled,
      conversationModelId,
      conversationOverrides,
      createOrUpdateConversation,
      currentConversationId,
      effectiveCompactionState,
      reasoningLevel,
      normalizeAssistantGroupBoundaryMessageIds,
      assistantGroupBoundaryMessageIds,
      serializeMessageModelMap,
      activeBranchByUserMessageIdRef,
      conversationReasoningLevelRef,
    ],
  )

  const persistConversationImmediately = useCallback(
    async (
      messages: ChatMessage[],
      assistantGroupBoundaryIdsOverride?: readonly string[],
    ): Promise<boolean> => {
      if (messages.length === 0) return false
      try {
        const effectiveOverrides = {
          ...(conversationOverrides ?? {}),
          chatMode,
          agentYoloEnabled: yoloEnabled,
        }
        await createOrUpdateConversationImmediately(
          currentConversationId,
          messages,
          effectiveOverrides,
          conversationModelId,
          serializeMessageModelMap(messages),
          serializeActiveBranchByUserMessageId(
            messages,
            activeBranchByUserMessageIdRef.current,
          ),
          conversationReasoningLevelRef.current.get(currentConversationId) ??
            reasoningLevel,
          effectiveCompactionState,
          normalizeAssistantGroupBoundaryMessageIds(
            messages,
            assistantGroupBoundaryIdsOverride ??
              assistantGroupBoundaryMessageIds,
          ),
        )
        return true
      } catch (error) {
        new Notice('Failed to save chat history')
        console.error('Failed to save chat history', error)
        return false
      }
    },
    [
      chatMode,
      yoloEnabled,
      conversationModelId,
      conversationOverrides,
      createOrUpdateConversationImmediately,
      currentConversationId,
      effectiveCompactionState,
      reasoningLevel,
      normalizeAssistantGroupBoundaryMessageIds,
      assistantGroupBoundaryMessageIds,
      serializeMessageModelMap,
      activeBranchByUserMessageIdRef,
      conversationReasoningLevelRef,
    ],
  )

  const isUserMessageEffectivelyEmpty = useCallback(
    (
      message: Pick<
        ChatUserMessage,
        'content' | 'mentionables' | 'selectedSkills'
      >,
    ): boolean => {
      const textContent = message.content
        ? editorStateToPlainText(message.content).trim()
        : ''

      return (
        textContent.length === 0 &&
        message.mentionables.length === 0 &&
        (message.selectedSkills?.length ?? 0) === 0
      )
    },
    [],
  )

  const removeHistoricalUserMessage = useCallback(
    (messageId: string) => {
      const sourceMessages = chatMessagesStateRef.current
      const removedMessages = sourceMessages.filter(
        (message) => message.role === 'user' && message.id === messageId,
      )
      releaseHighlightIds(
        collectSelectionHighlightIdsFromMessages(removedMessages),
      )
      const nextMessages = sourceMessages.filter(
        (message) => !(message.role === 'user' && message.id === messageId),
      )
      const nextAssistantGroupBoundaryMessageIds =
        buildAssistantGroupBoundaryMessageIdsAfterUserRemoval(
          sourceMessages,
          nextMessages,
          assistantGroupBoundaryMessageIds,
        )

      chatMessagesStateRef.current = nextMessages
      setChatMessages(nextMessages)
      setAssistantGroupBoundaryMessageIds(nextAssistantGroupBoundaryMessageIds)
      setFocusedMessageId((prev) =>
        prev === messageId ? inputMessageId : prev,
      )
      setMessageModelMap((prev) => {
        if (!prev.has(messageId)) return prev
        const next = new Map(prev)
        next.delete(messageId)
        return next
      })
      setMessageReasoningMap((prev) => {
        if (!prev.has(messageId)) return prev
        const next = new Map(prev)
        next.delete(messageId)
        return next
      })

      const nextActiveBranchByUserMessageId = new Map(
        activeBranchByUserMessageIdRef.current,
      )
      if (nextActiveBranchByUserMessageId.delete(messageId)) {
        activeBranchByUserMessageIdRef.current = nextActiveBranchByUserMessageId
        setActiveBranchByUserMessageId(nextActiveBranchByUserMessageId)
      }

      if (nextMessages.length === 0) {
        void deleteConversation(currentConversationId)
        return
      }

      void persistConversation(
        nextMessages,
        nextAssistantGroupBoundaryMessageIds,
      )
    },
    [
      assistantGroupBoundaryMessageIds,
      buildAssistantGroupBoundaryMessageIdsAfterUserRemoval,
      currentConversationId,
      deleteConversation,
      inputMessageId,
      persistConversation,
      releaseHighlightIds,
      chatMessagesStateRef,
      setChatMessages,
      setAssistantGroupBoundaryMessageIds,
      setFocusedMessageId,
      setMessageModelMap,
      setMessageReasoningMap,
      activeBranchByUserMessageIdRef,
      setActiveBranchByUserMessageId,
    ],
  )

  const updateHistoricalUserMessage = useCallback(
    (
      messageId: string,
      updater: (message: ChatUserMessage) => ChatUserMessage,
    ) => {
      const nextMessages = chatMessagesStateRef.current.map((message) => {
        if (message.role !== 'user' || message.id !== messageId) {
          return message
        }

        return updater(message)
      })

      const updatedMessage = nextMessages.find(
        (message): message is ChatUserMessage =>
          message.role === 'user' && message.id === messageId,
      )
      if (!updatedMessage) {
        return
      }

      chatMessagesStateRef.current = nextMessages
      setChatMessages(nextMessages)
      setAssistantGroupBoundaryMessageIds((prev) =>
        normalizeAssistantGroupBoundaryMessageIds(nextMessages, prev),
      )
    },
    [
      normalizeAssistantGroupBoundaryMessageIds,
      chatMessagesStateRef,
      setChatMessages,
      setAssistantGroupBoundaryMessageIds,
    ],
  )

  const finalizeHistoricalUserMessageEdit = useCallback(
    (messageId: string) => {
      const message = chatMessagesStateRef.current.find(
        (candidate): candidate is ChatUserMessage =>
          candidate.role === 'user' && candidate.id === messageId,
      )
      if (!message) {
        return
      }

      if (!isUserMessageEffectivelyEmpty(message)) {
        return
      }

      removeHistoricalUserMessage(messageId)
    },
    [
      isUserMessageEffectivelyEmpty,
      removeHistoricalUserMessage,
      chatMessagesStateRef,
    ],
  )

  const dismissHistoricalUserMessage = useCallback(
    (messageId: string) => {
      finalizeHistoricalUserMessageEdit(messageId)
      setFocusedMessageId(inputMessageId)
    },
    [finalizeHistoricalUserMessageEdit, inputMessageId, setFocusedMessageId],
  )

  const loadYoloConversation = useCallback(
    async (conversationId: string, isCurrent: () => boolean = () => true) => {
      setIsLoadingConversation(true)
      try {
        const conversation = await getConversationById(conversationId)
        if (!isCurrent()) return
        if (!conversation) {
          throw new Error('Conversation not found')
        }
        activeRuntimeIdRef.current = 'yolo'
        setRequestedRuntimeId('yolo')
        persistChatRuntimePreference('yolo')
        const normalizedConversation = normalizeHydratedConversationMessages(
          conversation.messages,
        )
        setCurrentConversationId(conversationId)
        setChatMessages(normalizedConversation.messages)
        setAssistantGroupBoundaryMessageIds(
          normalizeAssistantGroupBoundaryMessageIds(
            normalizedConversation.messages,
            conversation.assistantGroupBoundaryMessageIds ?? [],
          ),
        )
        setCompactionState(conversation.compaction ?? [])
        setPendingCompactionAnchorMessageId(null)
        plugin
          .getAgentService()
          .replaceConversationMessages(
            conversationId,
            normalizedConversation.messages,
            conversation.compaction ?? [],
            {
              persistState: true,
              reason: normalizedConversation.changed ? 'self-heal' : 'hydrate',
            },
          )
        setConversationOverrides(conversation.overrides ?? null)
        const loadedAssistantId =
          conversation.assistantId ??
          conversationAssistantIdRef.current.get(conversationId) ??
          settings.currentAssistantId ??
          settings.assistants[0]?.id ??
          DEFAULT_ASSISTANT_ID
        const loadedAssistantModelId =
          settings.assistants.find(
            (assistant) => assistant.id === loadedAssistantId,
          )?.modelId ?? null
        setConversationAssistantId(loadedAssistantId)
        conversationAssistantIdRef.current.set(
          conversationId,
          loadedAssistantId,
        )
        const loadedChatMode = normalizeChatMode(
          conversation.overrides?.chatMode,
          settings.chatOptions.chatMode ?? 'agent',
        )
        setChatMode(loadedChatMode)
        setYoloEnabled(
          normalizeYoloEnabled(
            conversation.overrides?.chatMode,
            conversation.overrides?.agentYoloEnabled,
            settings.chatOptions.agentYoloEnabled ?? false,
          ),
        )
        conversationOverridesRef.current.set(
          conversationId,
          conversation.overrides ?? null,
        )
        const cliRuntimeForPrefs: CliRuntimeId =
          activeRuntimeIdRef.current === 'yolo'
            ? lastCliRuntimeIdRef.current
            : activeRuntimeIdRef.current
        const loadedCliMode = resolveCliModePreference(
          settings,
          cliRuntimeForPrefs,
          conversation.overrides ?? null,
        )
        setCliChatMode(loadedCliMode.mode)
        setCliYoloEnabled(loadedCliMode.yoloEnabled)
        if (
          cliRuntimeForPrefs === 'claude-code' &&
          loadedCliMode.mode !== 'plan'
        ) {
          prePlanCliModeByConversationRef.current.delete(conversationId)
        }
        const modelFromRef =
          conversation.conversationModelId ??
          conversationModelIdRef.current.get(conversationId) ??
          loadedAssistantModelId ??
          settings.chatModelId
        setConversationModelId(modelFromRef)
        conversationModelIdRef.current.set(conversationId, modelFromRef)
        const loadedConversationTitle = getConversationDisplayTitle(
          chatList.find((chat) => chat.id === conversationId)?.title,
          t('chat.untitledConversation', 'New chat'),
        )
        onConversationContextChange?.({
          currentConversationId: conversationId,
          currentConversationPersisted: true,
          currentConversationTitle: loadedConversationTitle,
          currentModelId: modelFromRef,
          currentOverrides: conversation.overrides ?? undefined,
        })
        const storedReasoningLevel = normalizeReasoningLevel(
          conversation.reasoningLevel,
        )
        const resolvedReasoningLevel =
          storedReasoningLevel ?? getReasoningLevelForModelId(modelFromRef)
        setReasoningLevel(resolvedReasoningLevel)
        conversationReasoningLevelRef.current.set(
          conversationId,
          resolvedReasoningLevel,
        )
        setMessageModelMap(
          new Map(Object.entries(conversation.messageModelMap ?? {})),
        )
        const loadedActiveBranchByUserMessageId = new Map(
          Object.entries(conversation.activeBranchByUserMessageId ?? {}),
        )
        activeBranchByUserMessageIdRef.current =
          loadedActiveBranchByUserMessageId
        setActiveBranchByUserMessageId(loadedActiveBranchByUserMessageId)
        const nextMessageReasoningMap = new Map<string, ReasoningLevel>()
        normalizedConversation.messages.forEach((message) => {
          if (message.role !== 'user') return
          const messageLevel = normalizeReasoningLevel(message.reasoningLevel)
          if (messageLevel) {
            nextMessageReasoningMap.set(message.id, messageLevel)
          }
        })
        setMessageReasoningMap(nextMessageReasoningMap)
        const preservedInput = getLatestInputMessage()
        const newInputMessage = buildNewInputMessage(resolvedReasoningLevel)
        newInputMessage.content = preservedInput.content
        newInputMessage.mentionables = [...preservedInput.mentionables]
        newInputMessage.selectedSkills = [
          ...(preservedInput.selectedSkills ?? []),
        ]
        replaceInputMessage(newInputMessage)
        setFocusedMessageId(newInputMessage.id)
        setEditingAssistantMessageId(null)
        setQueryProgress({
          type: 'idle',
        })
        if (normalizedConversation.changed) {
          await createOrUpdateConversationImmediately(
            conversationId,
            normalizedConversation.messages,
            conversation.overrides,
            conversation.conversationModelId,
            conversation.messageModelMap,
            conversation.activeBranchByUserMessageId,
            conversation.reasoningLevel,
            conversation.compaction,
            normalizeAssistantGroupBoundaryMessageIds(
              normalizedConversation.messages,
              conversation.assistantGroupBoundaryMessageIds ?? [],
            ),
            { touchUpdatedAt: false },
          )
        }
      } catch (error) {
        new Notice('Failed to load conversation')
        console.error('Failed to load conversation', error)
      } finally {
        setIsLoadingConversation(false)
      }
    },
    [
      getConversationById,
      chatList,
      createOrUpdateConversationImmediately,
      plugin,
      settings,
      getReasoningLevelForModelId,
      normalizeAssistantGroupBoundaryMessageIds,
      normalizeReasoningLevel,
      onConversationContextChange,
      persistChatRuntimePreference,
      getLatestInputMessage,
      replaceInputMessage,
      t,
      setIsLoadingConversation,
      activeRuntimeIdRef,
      setRequestedRuntimeId,
      setCurrentConversationId,
      setChatMessages,
      setAssistantGroupBoundaryMessageIds,
      setCompactionState,
      setPendingCompactionAnchorMessageId,
      setConversationOverrides,
      conversationAssistantIdRef,
      setConversationAssistantId,
      setChatMode,
      setYoloEnabled,
      conversationOverridesRef,
      lastCliRuntimeIdRef,
      setCliChatMode,
      setCliYoloEnabled,
      prePlanCliModeByConversationRef,
      conversationModelIdRef,
      setConversationModelId,
      setReasoningLevel,
      conversationReasoningLevelRef,
      setMessageModelMap,
      activeBranchByUserMessageIdRef,
      setActiveBranchByUserMessageId,
      setMessageReasoningMap,
      buildNewInputMessage,
      setFocusedMessageId,
      setEditingAssistantMessageId,
      setQueryProgress,
    ],
  )

  const loadCliConversation = useCallback(
    async (
      conversationId: string,
      ref: CliSessionRef,
      overrides: ConversationOverrideSettings | null | undefined,
      isLatestNavigation: () => boolean,
    ) => {
      if (!cliRuntimeScope || !cliRuntimeAvailable) {
        new Notice(
          t(
            'chat.cliSurface.openError',
            'Could not open the CLI session: {message}',
          ).replace('{message}', 'CLI runtime unavailable.'),
        )
        return
      }

      const openSelectedSession = async (isCurrent: () => boolean) => {
        const isCurrentNavigation = () => isCurrent() && isLatestNavigation()
        const result = await openCliSessionForNavigation({
          scope: cliRuntimeScope,
          ref,
          isCurrent: isCurrentNavigation,
        })
        if (!result) return
        const modePreference = resolveCliModePreference(
          settings,
          ref.runtimeId,
          overrides,
        )
        await prepareCliConversation({
          controller: result.controller,
          scope: cliRuntimeScope,
          runtimeId: ref.runtimeId,
          settings,
          permissionProfile: modePreference,
        })
        if (!isCurrentNavigation()) return
        lastCliRuntimeIdRef.current = ref.runtimeId
        activeRuntimeIdRef.current = ref.runtimeId
        setRequestedRuntimeId(ref.runtimeId)
        persistChatRuntimePreference(ref.runtimeId)
        setCliConversationController(result.controller)
        setCliConversationId(conversationId)
        const restoredOverrides = overrides ?? null
        setConversationOverrides(restoredOverrides)
        conversationOverridesRef.current.set(conversationId, restoredOverrides)
        setCliChatMode(modePreference.mode)
        setCliYoloEnabled(modePreference.yoloEnabled)
        if (ref.runtimeId === 'claude-code' && modePreference.mode !== 'plan') {
          prePlanCliModeByConversationRef.current.delete(conversationId)
        }
        if (result.overlayError) {
          console.warn('[YOLO] Failed to restore CLI conversation metadata', {
            conversationId,
            error: result.overlayError.message,
          })
        }
      }

      try {
        if (activeRuntimeIdRef.current === 'yolo') {
          await openSelectedSession(isLatestNavigation)
        } else {
          await transitionCliSession((isCurrent) =>
            openSelectedSession(() => isCurrent() && isLatestNavigation()),
          )
        }
      } catch (error) {
        if (!isLatestNavigation()) return
        new Notice(
          t(
            'chat.cliSurface.openError',
            'Could not open the CLI session: {message}',
          ).replace(
            '{message}',
            error instanceof Error ? error.message : String(error),
          ),
        )
      }
    },
    [
      activeRuntimeIdRef,
      cliRuntimeAvailable,
      cliRuntimeScope,
      persistChatRuntimePreference,
      settings,
      t,
      transitionCliSession,
      setRequestedRuntimeId,
      lastCliRuntimeIdRef,
      setCliConversationController,
      setCliConversationId,
      setConversationOverrides,
      conversationOverridesRef,
      setCliChatMode,
      setCliYoloEnabled,
      prePlanCliModeByConversationRef,
    ],
  )

  const handleLoadConversation = useCallback(
    async (conversationId: string) => {
      cliModeRequestGenerationRef.current += 1
      const isLatestNavigation = beginChatRuntimeNavigation(
        runtimeNavigationGenerationRef,
        () => chatMountedRef.current,
      )
      const conversation = await getConversationById(conversationId)
      if (!isLatestNavigation()) return
      if (!conversation) {
        new Notice('Failed to load conversation')
        return
      }
      if (conversation.cliSession) {
        await loadCliConversation(
          conversationId,
          conversation.cliSession,
          conversation.overrides,
          isLatestNavigation,
        )
        return
      }
      if (activeRuntimeIdRef.current === 'yolo') {
        await loadYoloConversation(conversationId, isLatestNavigation)
        return
      }
      await transitionCliSession(async (isCurrent) => {
        const isCurrentNavigation = () => isCurrent() && isLatestNavigation()
        if (!isCurrentNavigation()) return
        await loadYoloConversation(conversationId, isCurrentNavigation)
      })
    },
    [
      activeRuntimeIdRef,
      getConversationById,
      loadCliConversation,
      loadYoloConversation,
      transitionCliSession,
      cliModeRequestGenerationRef,
      runtimeNavigationGenerationRef,
      chatMountedRef,
    ],
  )

  // Load an initial conversation passed in via props (e.g., from Quick Ask)
  useEffect(() => {
    if (!initialConversationId) return
    void handleLoadConversation(initialConversationId)
  }, [handleLoadConversation, initialConversationId])

  const handleNewChat = useCallback(
    (selectedBlock?: MentionableBlockData) => {
      cliModeRequestGenerationRef.current += 1
      const isLatestNavigation = beginChatRuntimeNavigation(
        runtimeNavigationGenerationRef,
        () => chatMountedRef.current,
      )
      if (activeRuntimeId !== 'yolo') {
        void transitionCliSession((isCurrent) => {
          if (!isCurrent() || !isLatestNavigation()) return
          createFreshCliConversation(activeRuntimeId)
          if (selectedBlock) {
            const mentionableBlock =
              createSelectionBlockMentionable(selectedBlock)
            setInputMessage((message) => ({
              ...message,
              mentionables: [...message.mentionables, mentionableBlock],
            }))
          }
        })
        return
      }
      const newId = uuidv4()
      setCurrentConversationId(newId)
      conversationAssistantIdRef.current.set(newId, conversationAssistantId)
      setConversationAssistantId(conversationAssistantId)
      setConversationOverrides(null)
      const defaultChatMode = chatMode
      setChatMode(defaultChatMode)
      setYoloEnabled(yoloEnabled)
      const defaultConversationModelId =
        selectedAssistant?.modelId ?? settings.chatModelId
      conversationModelIdRef.current.set(newId, defaultConversationModelId)
      setConversationModelId(defaultConversationModelId)
      const defaultReasoningLevel = getReasoningLevelForModelId(
        defaultConversationModelId,
      )
      setReasoningLevel(defaultReasoningLevel)
      conversationReasoningLevelRef.current.set(newId, defaultReasoningLevel)
      setMessageModelMap(new Map())
      setAssistantGroupBoundaryMessageIds([])
      activeBranchByUserMessageIdRef.current = new Map()
      setActiveBranchByUserMessageId(new Map())
      setMessageReasoningMap(new Map())
      setChatMessages([])
      setCompactionState([])
      setPendingCompactionAnchorMessageId(null)
      setEditingAssistantMessageId(null)
      const newInputMessage = buildNewInputMessage(defaultReasoningLevel)
      const latestInputMessage = getLatestInputMessage()
      newInputMessage.content = latestInputMessage.content
      newInputMessage.mentionables = [...latestInputMessage.mentionables]
      newInputMessage.selectedSkills = [
        ...(latestInputMessage.selectedSkills ?? []),
      ]
      if (selectedBlock) {
        const mentionableBlock = createSelectionBlockMentionable(selectedBlock)
        newInputMessage.mentionables = [
          ...newInputMessage.mentionables,
          mentionableBlock,
        ]
      }
      setAddedBlockKey(null)
      replaceInputMessage(newInputMessage)
      setFocusedMessageId(newInputMessage.id)
      setQueryProgress({
        type: 'idle',
      })
    },
    [
      activeRuntimeId,
      transitionCliSession,
      createFreshCliConversation,
      setInputMessage,
      setCurrentConversationId,
      conversationAssistantIdRef,
      conversationAssistantId,
      setConversationAssistantId,
      setConversationOverrides,
      chatMode,
      setChatMode,
      yoloEnabled,
      setYoloEnabled,
      selectedAssistant,
      settings,
      conversationModelIdRef,
      setConversationModelId,
      getReasoningLevelForModelId,
      setReasoningLevel,
      conversationReasoningLevelRef,
      setMessageModelMap,
      setAssistantGroupBoundaryMessageIds,
      activeBranchByUserMessageIdRef,
      setActiveBranchByUserMessageId,
      setMessageReasoningMap,
      setChatMessages,
      setCompactionState,
      setPendingCompactionAnchorMessageId,
      setEditingAssistantMessageId,
      buildNewInputMessage,
      getLatestInputMessage,
      setAddedBlockKey,
      replaceInputMessage,
      setFocusedMessageId,
      setQueryProgress,
      cliModeRequestGenerationRef,
      runtimeNavigationGenerationRef,
      chatMountedRef,
    ],
  )

  const handleAssistantMessageEditSave = useCallback(
    (groupAnchorMessageId: string, replacementMessages: ChatMessage[]) => {
      setChatMessages((prevChatHistory) => {
        const groupedMessages = groupAssistantAndToolMessages(
          prevChatHistory,
          assistantGroupBoundaryMessageIds,
        )
        const targetGroup = groupedMessages.find(
          (item): item is AssistantToolMessageGroup =>
            Array.isArray(item) &&
            item.some((message) => message.id === groupAnchorMessageId),
        )
        if (!targetGroup) {
          return prevChatHistory
        }

        const anchorMessage = targetGroup.find(
          (message) => message.id === groupAnchorMessageId,
        )
        const anchorBranchId = anchorMessage?.metadata?.branchId
        const targetMessages = anchorBranchId
          ? targetGroup.filter(
              (message) => message.metadata?.branchId === anchorBranchId,
            )
          : targetGroup
        const targetIds = new Set(targetMessages.map((message) => message.id))
        const targetIndexes = prevChatHistory
          .map((message, index) => (targetIds.has(message.id) ? index : null))
          .filter((index): index is number => index !== null)
        const startIndex = targetIndexes[0]
        const endIndex = targetIndexes.at(-1)
        if (startIndex === undefined || endIndex === undefined) {
          return prevChatHistory
        }

        const nextMessages = [
          ...prevChatHistory.slice(0, startIndex),
          ...replacementMessages,
          ...prevChatHistory.slice(endIndex + 1),
        ]
        chatMessagesStateRef.current = nextMessages
        void persistConversation(nextMessages)
        return nextMessages
      })
      setEditingAssistantMessageId(null)
    },
    [
      assistantGroupBoundaryMessageIds,
      persistConversation,
      setChatMessages,
      chatMessagesStateRef,
      setEditingAssistantMessageId,
    ],
  )

  const handleAssistantMessageEditCancel = useCallback(() => {
    setEditingAssistantMessageId(null)
  }, [setEditingAssistantMessageId])

  const handleAssistantMessageGroupDelete = useCallback(
    (messageIds: string[]) => {
      const idsToRemove = new Set(messageIds)
      const nextMessages = chatMessagesStateRef.current.filter(
        (message) => !idsToRemove.has(message.id),
      )
      const nextAssistantGroupBoundaryMessageIds =
        normalizeAssistantGroupBoundaryMessageIds(
          nextMessages,
          assistantGroupBoundaryMessageIds,
        )
      chatMessagesStateRef.current = nextMessages
      setChatMessages(nextMessages)
      setAssistantGroupBoundaryMessageIds(nextAssistantGroupBoundaryMessageIds)
      void persistConversation(
        nextMessages,
        nextAssistantGroupBoundaryMessageIds,
      )
      setEditingAssistantMessageId((prev) =>
        prev && idsToRemove.has(prev) ? null : prev,
      )
    },
    [
      assistantGroupBoundaryMessageIds,
      normalizeAssistantGroupBoundaryMessageIds,
      persistConversation,
      chatMessagesStateRef,
      setChatMessages,
      setAssistantGroupBoundaryMessageIds,
      setEditingAssistantMessageId,
    ],
  )

  const handleHistoricalUserMessageDelete = useCallback(
    (userMessageId: string) => {
      if (isCurrentConversationRunActive) return
      const sourceMessages = chatMessagesStateRef.current
      const startIdx = sourceMessages.findIndex(
        (m) => m.id === userMessageId && m.role === 'user',
      )
      if (startIdx < 0) return
      let endIdx = sourceMessages.length
      for (let i = startIdx + 1; i < sourceMessages.length; i += 1) {
        if (sourceMessages[i].role === 'user') {
          endIdx = i
          break
        }
      }
      const removedIds = new Set(
        sourceMessages.slice(startIdx, endIdx).map((m) => m.id),
      )
      const removedMessages = sourceMessages.slice(startIdx, endIdx)
      releaseHighlightIds(
        collectSelectionHighlightIdsFromMessages(removedMessages),
      )
      const nextMessages = sourceMessages.filter((m) => !removedIds.has(m.id))
      const nextAssistantGroupBoundaryMessageIds =
        normalizeAssistantGroupBoundaryMessageIds(
          nextMessages,
          assistantGroupBoundaryMessageIds,
        )
      chatMessagesStateRef.current = nextMessages
      setChatMessages(nextMessages)
      setAssistantGroupBoundaryMessageIds(nextAssistantGroupBoundaryMessageIds)

      setMessageModelMap((prev) => {
        if (!prev.has(userMessageId)) return prev
        const next = new Map(prev)
        next.delete(userMessageId)
        return next
      })
      setMessageReasoningMap((prev) => {
        if (!prev.has(userMessageId)) return prev
        const next = new Map(prev)
        next.delete(userMessageId)
        return next
      })
      if (activeBranchByUserMessageIdRef.current.has(userMessageId)) {
        const nextBranchMap = new Map(activeBranchByUserMessageIdRef.current)
        nextBranchMap.delete(userMessageId)
        activeBranchByUserMessageIdRef.current = nextBranchMap
        setActiveBranchByUserMessageId(nextBranchMap)
      }
      setEditingAssistantMessageId((prev) =>
        prev && removedIds.has(prev) ? null : prev,
      )
      setFocusedMessageId((prev) =>
        prev && removedIds.has(prev) ? inputMessageId : prev,
      )
      if (nextMessages.length === 0) {
        void deleteConversation(currentConversationId)
        return
      }
      void persistConversation(
        nextMessages,
        nextAssistantGroupBoundaryMessageIds,
      )
    },
    [
      assistantGroupBoundaryMessageIds,
      currentConversationId,
      deleteConversation,
      inputMessageId,
      isCurrentConversationRunActive,
      normalizeAssistantGroupBoundaryMessageIds,
      persistConversation,
      releaseHighlightIds,
      chatMessagesStateRef,
      setChatMessages,
      setAssistantGroupBoundaryMessageIds,
      setMessageModelMap,
      setMessageReasoningMap,
      activeBranchByUserMessageIdRef,
      setActiveBranchByUserMessageId,
      setEditingAssistantMessageId,
      setFocusedMessageId,
    ],
  )

  const handleAssistantMessageGroupBranch = useCallback(
    (messageIds: string[]) => {
      if (messageIds.length === 0) return

      const sourceMessages = chatMessagesStateRef.current
      const targetIds = new Set(messageIds)
      let branchEndIndex = -1
      for (let i = sourceMessages.length - 1; i >= 0; i -= 1) {
        if (targetIds.has(sourceMessages[i].id)) {
          branchEndIndex = i
          break
        }
      }

      if (branchEndIndex < 0) {
        new Notice(t('chat.branchCreateFailed', 'Failed to create branch'))
        return
      }

      const nextMessages = sourceMessages.slice(0, branchEndIndex + 1)
      if (nextMessages.length === 0) {
        new Notice(t('chat.branchCreateFailed', 'Failed to create branch'))
        return
      }

      const sourceTitle = getConversationDisplayTitle(
        chatList.find((chat) => chat.id === currentConversationId)?.title,
        t('chat.untitledConversation', 'New chat'),
      )
      const branchTitle = `${sourceTitle} (copy)`

      const newConversationId = uuidv4()
      const nextOverrides =
        conversationOverridesRef.current.get(currentConversationId) ??
        conversationOverrides ??
        null
      const nextChatMode = normalizeChatMode(nextOverrides?.chatMode, chatMode)
      const nextYoloEnabled = normalizeYoloEnabled(
        nextOverrides?.chatMode,
        nextOverrides?.agentYoloEnabled,
        yoloEnabled,
      )

      const resolvedConversationModelId =
        conversationModelIdRef.current.get(currentConversationId) ??
        conversationModelId ??
        settings.chatModelId
      const resolvedReasoningLevel =
        conversationReasoningLevelRef.current.get(currentConversationId) ??
        reasoningLevel

      const retainedUserMessageIds = new Set(
        nextMessages
          .filter(
            (message): message is ChatUserMessage => message.role === 'user',
          )
          .map((message) => message.id),
      )

      const nextMessageModelMap = new Map(
        Array.from(messageModelMap.entries()).filter(([messageId]) =>
          retainedUserMessageIds.has(messageId),
        ),
      )
      const nextMessageReasoningMap = new Map(
        Array.from(messageReasoningMap.entries()).filter(([messageId]) =>
          retainedUserMessageIds.has(messageId),
        ),
      )
      const nextAssistantGroupBoundaryMessageIds =
        normalizeAssistantGroupBoundaryMessageIds(
          nextMessages,
          assistantGroupBoundaryMessageIds,
        )
      const nextActiveBranchByUserMessageId = new Map(
        Array.from(activeBranchByUserMessageIdRef.current.entries()).filter(
          ([messageId]) => retainedUserMessageIds.has(messageId),
        ),
      )
      const branchedCompactionState = effectiveCompactionState.filter((entry) =>
        nextMessages.some((message) => message.id === entry.anchorMessageId),
      )

      setCurrentConversationId(newConversationId)
      setChatMessages(nextMessages)
      setCompactionState(branchedCompactionState)
      setPendingCompactionAnchorMessageId(null)
      setEditingAssistantMessageId(null)

      setConversationOverrides(nextOverrides)
      if (nextOverrides) {
        conversationOverridesRef.current.set(newConversationId, nextOverrides)
      } else {
        conversationOverridesRef.current.delete(newConversationId)
      }

      setChatMode(nextChatMode)
      setYoloEnabled(nextYoloEnabled)

      setConversationAssistantId(conversationAssistantId)
      conversationAssistantIdRef.current.set(
        newConversationId,
        conversationAssistantId,
      )

      setConversationModelId(resolvedConversationModelId)
      conversationModelIdRef.current.set(
        newConversationId,
        resolvedConversationModelId,
      )

      setReasoningLevel(resolvedReasoningLevel)
      conversationReasoningLevelRef.current.set(
        newConversationId,
        resolvedReasoningLevel,
      )

      setMessageModelMap(nextMessageModelMap)
      setMessageReasoningMap(nextMessageReasoningMap)
      setAssistantGroupBoundaryMessageIds(nextAssistantGroupBoundaryMessageIds)
      activeBranchByUserMessageIdRef.current = nextActiveBranchByUserMessageId
      setActiveBranchByUserMessageId(nextActiveBranchByUserMessageId)

      const newInputMessage = buildNewInputMessage(resolvedReasoningLevel)
      replaceInputMessage(newInputMessage)
      setFocusedMessageId(newInputMessage.id)
      setQueryProgress({ type: 'idle' })

      void (async () => {
        await createOrUpdateConversationImmediately(
          newConversationId,
          nextMessages,
          {
            ...(nextOverrides ?? {}),
            chatMode: nextChatMode,
            agentYoloEnabled: nextYoloEnabled,
          },
          resolvedConversationModelId,
          serializeMessageModelMap(nextMessages, nextMessageModelMap),
          serializeActiveBranchByUserMessageId(
            nextMessages,
            nextActiveBranchByUserMessageId,
          ),
          resolvedReasoningLevel,
          branchedCompactionState,
          nextAssistantGroupBoundaryMessageIds,
        )
        await updateConversationTitle(newConversationId, branchTitle)
        new Notice(t('chat.branchCreated', 'Branch created'))
      })().catch((error) => {
        new Notice(t('chat.branchCreateFailed', 'Failed to create branch'))
        console.error('Failed to create branched conversation', error)
      })
    },
    [
      chatList,
      chatMode,
      yoloEnabled,
      conversationAssistantId,
      conversationModelId,
      conversationOverrides,
      createOrUpdateConversationImmediately,
      currentConversationId,
      effectiveCompactionState,
      messageModelMap,
      messageReasoningMap,
      assistantGroupBoundaryMessageIds,
      normalizeAssistantGroupBoundaryMessageIds,
      reasoningLevel,
      serializeMessageModelMap,
      settings,
      t,
      updateConversationTitle,
      chatMessagesStateRef,
      conversationOverridesRef,
      conversationModelIdRef,
      conversationReasoningLevelRef,
      activeBranchByUserMessageIdRef,
      setCurrentConversationId,
      setChatMessages,
      setCompactionState,
      setPendingCompactionAnchorMessageId,
      setEditingAssistantMessageId,
      setConversationOverrides,
      setChatMode,
      setYoloEnabled,
      setConversationAssistantId,
      conversationAssistantIdRef,
      setConversationModelId,
      setReasoningLevel,
      setMessageModelMap,
      setMessageReasoningMap,
      setAssistantGroupBoundaryMessageIds,
      setActiveBranchByUserMessageId,
      buildNewInputMessage,
      replaceInputMessage,
      setFocusedMessageId,
      setQueryProgress,
    ],
  )

  useEffect(() => {
    const unsubscribe = agentService.subscribeToRunSummaries((summaries) => {
      setRunSummariesByConversationId(summaries)
    })

    return () => {
      unsubscribe()
    }
  }, [agentService])

  // Re-peek the mid-run user message queue on every conversation state push
  // so the queued bubble stays in sync with enqueue / drain / abort events.
  useEffect(() => {
    const refreshQueued = () => {
      setQueuedUserMessages(
        agentService.peekPendingUserMessages(currentConversationId),
      )
    }
    refreshQueued()
    const unsubscribe = agentService.subscribe(
      currentConversationId,
      refreshQueued,
      { emitCurrent: false },
    )
    return () => {
      unsubscribe()
    }
  }, [agentService, currentConversationId])

  // When the user aborts a run, restore the most recently queued message into
  // the input box so its content is not silently lost. If multiple messages
  // were queued, only the latest is restored (it best reflects the user's
  // current intent); a notice surfaces the count of dropped earlier entries.
  useEffect(() => {
    const unsubscribe = agentService.subscribeToAbortedQueuedMessages(
      (conversationId, messages) => {
        if (conversationId !== currentConversationId) return
        if (messages.length === 0) return
        const latest = messages[messages.length - 1]
        releaseHighlightIds(
          collectSelectionHighlightIdsFromMessages(messages.slice(0, -1)),
        )
        const currentInputMessage = getLatestInputMessage()
        replaceInputMessage({
          ...currentInputMessage,
          content: latest.content,
          promptContent: latest.promptContent,
          snapshotRef: latest.snapshotRef,
          mentionables: latest.mentionables,
          selectedSkills: latest.selectedSkills,
          selectedModelIds: latest.selectedModelIds,
          reasoningLevel:
            latest.reasoningLevel ?? currentInputMessage.reasoningLevel,
          // 该消息从未真正发送出去 → 清掉入队时打的旧时间,下次提交会重新打戳。
          timeContext: undefined,
        })
        if (messages.length > 1) {
          new Notice(
            t(
              'chat.queueMessage.abortedRestoredMany',
              '已恢复最新 1 条排队消息到输入框（共取消 {{count}} 条）',
            ).replace('{{count}}', String(messages.length)),
          )
        } else {
          new Notice(
            t(
              'chat.queueMessage.abortedRestoredOne',
              '已将排队消息恢复到输入框',
            ),
          )
        }
      },
    )
    return () => {
      unsubscribe()
    }
  }, [
    agentService,
    currentConversationId,
    getLatestInputMessage,
    releaseHighlightIds,
    replaceInputMessage,
    t,
  ])

  // Auto-run when external agent results arrive for the current conversation
  useEffect(() => {
    const unsubscribe = agentService.subscribeToPendingBackgroundTaskResults(
      (conversationId) => {
        if (conversationId !== currentConversationId) return
        if (agentService.isRunning(conversationId)) return
        // Pull the latest messages directly from AgentService — the React
        // closure's `chatMessages` is stale at this point because the result
        // was just appended synchronously and React hasn't re-rendered yet.
        const latestMessages = agentService.getState(conversationId).messages
        submitChatMutation.mutate({
          chatMessages: latestMessages,
          conversationId,
        })
      },
    )
    return () => {
      unsubscribe()
    }
  }, [agentService, currentConversationId, submitChatMutation])

  // Ensure the conversation is persisted once a run that was in-flight while
  // the persist call would have been skipped settles.
  const submitMutationPendingRef = useRef(false)
  useEffect(() => {
    if (isCurrentConversationRunActive) {
      submitMutationPendingRef.current = true
      return
    }
    if (submitMutationPendingRef.current) {
      submitMutationPendingRef.current = false
      void (async () => {
        await persistConversationImmediately(chatMessages)
      })().catch((error) => {
        console.error('Failed to persist conversation after run', error)
      })
    }
  }, [
    chatMessages,
    isCurrentConversationRunActive,
    persistConversationImmediately,
  ])

  return {
    runSummariesByConversationId,
    queuedUserMessages,
    setQueuedUserMessages,
    serializeMessageModelMap,
    normalizeAssistantGroupBoundaryMessageIds,
    buildAssistantGroupBoundaryMessageIdsAfterUserRemoval,
    persistConversation,
    persistConversationImmediately,
    isUserMessageEffectivelyEmpty,
    updateHistoricalUserMessage,
    finalizeHistoricalUserMessageEdit,
    dismissHistoricalUserMessage,
    handleLoadConversation,
    handleNewChat,
    handleAssistantMessageEditSave,
    handleAssistantMessageEditCancel,
    handleAssistantMessageGroupDelete,
    handleHistoricalUserMessageDelete,
    handleAssistantMessageGroupBranch,
  }
}
