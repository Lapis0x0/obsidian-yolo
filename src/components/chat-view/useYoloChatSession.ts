import { Notice } from 'obsidian'
import {
  Dispatch,
  MutableRefObject,
  SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
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
import {
  collectSelectionHighlightIdsFromMessages,
  createSelectionBlockMentionable,
} from '../../utils/chat/selection-mentionables'

import {
  type ChatMode,
  chatModeForSave,
  isModuleChatMode,
  normalizePersistedChatMode,
  normalizeYoloEnabled,
  resolveEffectiveChatMode,
} from './chat-input/ChatModeSelect'
import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'
import type { ChatSessionController } from './ChatSessionController'
import {
  beginChatRuntimeNavigation,
  openCliSessionForNavigation,
  prepareCliConversation,
  resolveHermesSessionFallbackUpdate,
} from './cliChatIntegration'
import {
  type PrePlanCliModeMemory,
  prunePrePlanCliMode,
  resolveCliModePreference,
} from './cliRuntimePreferences'
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
  /**
   * 消息态八件套的唯一 owner——见架构治理第三步分期 C1。历史消息编辑/删除/
   * 分支命令直接调用其命令 API；`loadYoloConversation`/`handleNewChat`
   * 仍经下方各 setX props 写入（同一批函数，指向 controller 方法）。
   */
  sessionController: ChatSessionController
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
  updateConversationActiveBranches: ReturnType<
    typeof useChatHistory
  >['updateConversationActiveBranches']
  createOrTouchCliConversation: ReturnType<
    typeof useChatHistory
  >['createOrTouchCliConversation']
  getConversationById: ReturnType<typeof useChatHistory>['getConversationById']
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
  setMessageReasoningMap: Dispatch<SetStateAction<Map<string, ReasoningLevel>>>
  conversationOverrides: ConversationOverrideSettings | null
  setConversationOverrides: Dispatch<
    SetStateAction<ConversationOverrideSettings | null>
  >
  conversationOverridesRef: MutableRefObject<
    Map<string, ConversationOverrideSettings | null>
  >
  conversationModelId: string
  conversationModelIdRef: MutableRefObject<Map<string, string>>
  conversationAssistantId: string
  conversationAssistantIdRef: MutableRefObject<Map<string, string>>
  reasoningLevel: ReasoningLevel
  conversationReasoningLevelRef: MutableRefObject<Map<string, ReasoningLevel>>
  /**
   * Setter for the effective (runtime) chat mode — see
   * `resolveEffectiveChatMode`. This hook only ever derives and writes this
   * value (from `persistedChatMode` + the live module registry) via the
   * module-availability recompute effect below; every other write to the
   * preference septet goes through `switchConversation`.
   */
  setChatMode: Dispatch<SetStateAction<ChatMode>>
  /**
   * The chat mode as it should be written to conversation storage — never
   * downgraded by module (un)availability. Updated only alongside the
   * effective `chatMode` at session load, new-conversation default, branch
   * copy, and user-driven mode switches (`useChatRuntimePreferences`). All
   * write-back call sites must read this via `chatModeForSave`.
   */
  persistedChatMode: ChatMode
  yoloEnabled: boolean
  /**
   * 会话切换（加载已有会话 / 新建会话 / 分支复制）时一次性提交偏好七件套
   * 中被恢复的字段，并同步写入 ConversationPreferencesController 内部的
   * 每会话 Ref 缓存——取代逐字段调用 `setX` + 手动 `xRef.current.set` 的
   * 散落写法。见 `ConversationPreferencesController.switchConversation`。
   */
  switchConversation: (
    conversationId: string,
    values: Partial<{
      conversationModelId: string
      conversationAssistantId: string
      reasoningLevel: ReasoningLevel
      chatMode: ChatMode
      persistedChatMode: ChatMode
      yoloEnabled: boolean
      conversationOverrides: ConversationOverrideSettings | null
    }>,
  ) => void
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
  prePlanCliModeByConversationRef: PrePlanCliModeMemory
  setCliChatMode: Dispatch<SetStateAction<CliChatMode>>
  setCliYoloEnabled: Dispatch<SetStateAction<boolean>>
  setCliConversationController: Dispatch<
    SetStateAction<CliConversationController | null>
  >
  setCliConversationId: Dispatch<SetStateAction<string | null>>
  hermesProfileId: string | undefined
  setHermesProfileId: Dispatch<SetStateAction<string | undefined>>
  transitionCliSession: (
    action: (isCurrent: () => boolean) => void | Promise<void>,
  ) => Promise<boolean>
  createFreshCliConversation: (
    runtimeId: CliRuntimeId,
    profileId?: string,
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
  sessionController,
  initialConversationId,
  onConversationContextChange,
  createOrUpdateConversation,
  createOrUpdateConversationImmediately,
  updateConversationActiveBranches,
  createOrTouchCliConversation,
  getConversationById,
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
  setMessageReasoningMap,
  conversationOverrides,
  setConversationOverrides,
  conversationOverridesRef,
  conversationModelId,
  conversationModelIdRef,
  conversationAssistantId,
  conversationAssistantIdRef,
  reasoningLevel,
  conversationReasoningLevelRef,
  setChatMode,
  persistedChatMode,
  yoloEnabled,
  switchConversation,
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
  hermesProfileId,
  setHermesProfileId,
  transitionCliSession,
  createFreshCliConversation,
}: UseYoloChatSessionParams) {
  const plugin = usePlugin()
  const agentService = plugin.getAgentService()
  const { settings } = useSettings()
  const { t } = useLanguage()

  const moduleChatModeRegistry = plugin.getModuleChatModeRegistry()
  const moduleChatModeSnapshot = useSyncExternalStore(
    moduleChatModeRegistry.subscribe,
    moduleChatModeRegistry.getSnapshot,
  )

  // Keeps the effective (runtime) chat mode in sync with the persisted value
  // and live module availability — e.g. a module getting disabled/enabled
  // while its chat mode is the active one downgrades/restores `chatMode`
  // without ever touching `persistedChatMode` or conversation storage.
  useEffect(() => {
    setChatMode((current) => {
      const next = resolveEffectiveChatMode(
        persistedChatMode,
        moduleChatModeSnapshot,
      )
      return current === next ? current : next
    })
  }, [persistedChatMode, moduleChatModeSnapshot, setChatMode])

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
          chatMode: chatModeForSave(persistedChatMode),
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
      persistedChatMode,
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

  /**
   * 分支切换只改这一项元数据，因此只写这一项。
   *
   * 附带写一份 UI 手里的 messages 是数据覆盖风险：生成期间正文走 assistant
   * render stream，UI 快照可能落后整个生成阶段，而这条写入与 AgentService 的
   * 最终持久化不共享同一条串行链——它若后落地，数据库就会留下被截断的正文。
   */
  const persistActiveBranchSelection = useCallback(async () => {
    try {
      await updateConversationActiveBranches(
        currentConversationId,
        activeBranchByUserMessageIdRef.current,
      )
    } catch (error) {
      new Notice('Failed to save chat history')
      console.error('Failed to save active branch selection', error)
    }
  }, [
    activeBranchByUserMessageIdRef,
    currentConversationId,
    updateConversationActiveBranches,
  ])

  const persistConversationImmediately = useCallback(
    async (
      messages: ChatMessage[],
      assistantGroupBoundaryIdsOverride?: readonly string[],
    ): Promise<boolean> => {
      if (messages.length === 0) return false
      try {
        const effectiveOverrides = {
          ...(conversationOverrides ?? {}),
          chatMode: chatModeForSave(persistedChatMode),
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
      persistedChatMode,
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

  // 消息态写入已收编进 ChatSessionController（架构治理第三步分期 C1）——
  // 本函数只做 Notice/焦点/高亮释放等 UI 反应，翻译 controller 命令的
  // 类型化返回结果。
  const removeHistoricalUserMessage = useCallback(
    (messageId: string) => {
      const result = sessionController.removeHistoricalUserMessage(messageId)
      releaseHighlightIds(
        collectSelectionHighlightIdsFromMessages(result.removedMessages),
      )
      setFocusedMessageId((prev) =>
        prev === messageId ? inputMessageId : prev,
      )
      if (result.outcome.kind === 'persisted') {
        void result.outcome.ok.then((ok) => {
          if (!ok) new Notice('Failed to save chat history')
        })
      }
    },
    [
      sessionController,
      releaseHighlightIds,
      setFocusedMessageId,
      inputMessageId,
    ],
  )

  const updateHistoricalUserMessage = useCallback(
    (
      messageId: string,
      updater: (message: ChatUserMessage) => ChatUserMessage,
    ) => {
      sessionController.updateHistoricalUserMessage(messageId, updater)
    },
    [sessionController],
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
        const loadedOverrides = conversation.overrides ?? null
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
        const loadedPersistedChatMode = normalizePersistedChatMode(
          conversation.overrides?.chatMode,
          settings.chatOptions.chatMode ?? 'agent',
        )
        const loadedChatMode = resolveEffectiveChatMode(
          loadedPersistedChatMode,
          moduleChatModeSnapshot,
        )
        const loadedYoloEnabled = normalizeYoloEnabled(
          conversation.overrides?.chatMode,
          conversation.overrides?.agentYoloEnabled,
          settings.chatOptions.agentYoloEnabled ?? false,
        )
        const modelFromRef =
          conversation.conversationModelId ??
          conversationModelIdRef.current.get(conversationId) ??
          loadedAssistantModelId ??
          settings.chatModelId
        const storedReasoningLevel = normalizeReasoningLevel(
          conversation.reasoningLevel,
        )
        const resolvedReasoningLevel =
          storedReasoningLevel ?? getReasoningLevelForModelId(modelFromRef)

        // 偏好七件套一次性提交 + 写入每会话 Ref 缓存——取代原先逐字段
        // setX + 手动 ref.set 的散落写法。
        switchConversation(conversationId, {
          conversationOverrides: loadedOverrides,
          conversationAssistantId: loadedAssistantId,
          persistedChatMode: loadedPersistedChatMode,
          chatMode: loadedChatMode,
          yoloEnabled: loadedYoloEnabled,
          conversationModelId: modelFromRef,
          reasoningLevel: resolvedReasoningLevel,
        })

        const cliRuntimeForPrefs: CliRuntimeId =
          activeRuntimeIdRef.current === 'yolo'
            ? lastCliRuntimeIdRef.current
            : activeRuntimeIdRef.current
        const loadedCliMode = resolveCliModePreference(
          settings,
          cliRuntimeForPrefs,
          loadedOverrides,
        )
        setCliChatMode(loadedCliMode.mode)
        setCliYoloEnabled(loadedCliMode.yoloEnabled)
        prunePrePlanCliMode(
          prePlanCliModeByConversationRef,
          conversationId,
          cliRuntimeForPrefs,
          loadedCliMode.mode,
        )
        const loadedConversationTitle = getConversationDisplayTitle(
          chatList.find((chat) => chat.id === conversationId)?.title,
          t('chat.untitledConversation', 'New chat'),
        )
        onConversationContextChange?.({
          currentConversationId: conversationId,
          currentConversationPersisted: true,
          currentConversationTitle: loadedConversationTitle,
          currentModelId: modelFromRef,
          currentOverrides: loadedOverrides ?? undefined,
        })
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
      conversationAssistantIdRef,
      switchConversation,
      moduleChatModeSnapshot,
      lastCliRuntimeIdRef,
      setCliChatMode,
      setCliYoloEnabled,
      prePlanCliModeByConversationRef,
      conversationModelIdRef,
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
        if (!result || !result.hydration) return
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
        // A historical CLI session's own `ChatConversationCliSession` is
        // authoritative on which Hermes profile it lives under; no record
        // means the default profile (see `ChatConversationCliSession.profileId`).
        // Unless a fallback occurred — in the `openCliSessionForNavigation()`
        // peek above or in `prepareCliConversation()`'s own `ensureReady()`
        // load — because the stored profile no longer resolves (see
        // `AcpCliRuntimeOptions.sessionRecovery`). Either way the *fallback*
        // session is what's actually live, so both the header and
        // conversation storage must reflect it instead of the now-dead
        // requested profile — this reads the controller's settled snapshot,
        // not just the first load's hydration, to catch a fallback from
        // either load (see `resolveHermesSessionFallbackUpdate`).
        const fallbackUpdate = resolveHermesSessionFallbackUpdate(
          ref.runtimeId,
          result.controller.getSnapshot(),
        )
        setHermesProfileId(
          fallbackUpdate
            ? fallbackUpdate.hermesProfileId
            : ref.runtimeId === 'hermes'
              ? ref.profileId
              : undefined,
        )
        const restoredOverrides = overrides ?? null
        setConversationOverrides(restoredOverrides)
        conversationOverridesRef.current.set(conversationId, restoredOverrides)
        setCliChatMode(modePreference.mode)
        setCliYoloEnabled(modePreference.yoloEnabled)
        prunePrePlanCliMode(
          prePlanCliModeByConversationRef,
          conversationId,
          ref.runtimeId,
          modePreference.mode,
        )
        if (fallbackUpdate) {
          void createOrTouchCliConversation(
            conversationId,
            fallbackUpdate.cliSession,
            restoredOverrides,
          ).catch((error: unknown) => {
            console.error(
              '[YOLO] Failed to persist Hermes fallback session',
              error,
            )
          })
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
      createOrTouchCliConversation,
      persistChatRuntimePreference,
      settings,
      t,
      transitionCliSession,
      setRequestedRuntimeId,
      lastCliRuntimeIdRef,
      setCliConversationController,
      setCliConversationId,
      setHermesProfileId,
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
          // "+ New chat" starts a fresh conversation under whichever Hermes
          // profile is currently active — it is not a profile switch, so it
          // must not silently fall back to default.
          createFreshCliConversation(
            activeRuntimeId,
            activeRuntimeId === 'hermes' ? hermesProfileId : undefined,
          )
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
      const defaultPersistedChatMode = persistedChatMode
      const defaultChatMode = resolveEffectiveChatMode(
        defaultPersistedChatMode,
        moduleChatModeSnapshot,
      )
      const defaultConversationModelId = isModuleChatMode(defaultChatMode)
        ? settings.chatModelId
        : (selectedAssistant?.modelId ?? settings.chatModelId)
      const defaultReasoningLevel = getReasoningLevelForModelId(
        defaultConversationModelId,
      )

      // 偏好七件套一次性提交 + 写入每会话 Ref 缓存——取代原先逐字段
      // setX + 手动 ref.set 的散落写法。新会话延续当前会话的 assistant/
      // yolo 值,重置 overrides,mode/model/reasoningLevel 取默认值。
      switchConversation(newId, {
        conversationAssistantId,
        conversationOverrides: null,
        persistedChatMode: defaultPersistedChatMode,
        chatMode: defaultChatMode,
        yoloEnabled,
        conversationModelId: defaultConversationModelId,
        reasoningLevel: defaultReasoningLevel,
      })
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
      hermesProfileId,
      setInputMessage,
      setCurrentConversationId,
      conversationAssistantId,
      switchConversation,
      persistedChatMode,
      moduleChatModeSnapshot,
      yoloEnabled,
      selectedAssistant,
      settings,
      getReasoningLevelForModelId,
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
      const result = sessionController.handleAssistantMessageEditSave(
        groupAnchorMessageId,
        replacementMessages,
      )
      setEditingAssistantMessageId(null)
      if (result.outcome?.kind === 'persisted') {
        void result.outcome.ok.then((ok) => {
          if (!ok) new Notice('Failed to save chat history')
        })
      }
    },
    [sessionController, setEditingAssistantMessageId],
  )

  const handleAssistantMessageEditCancel = useCallback(() => {
    setEditingAssistantMessageId(null)
  }, [setEditingAssistantMessageId])

  const handleAssistantMessageGroupDelete = useCallback(
    (messageIds: string[]) => {
      const idsToRemove = new Set(messageIds)
      const result =
        sessionController.handleAssistantMessageGroupDelete(messageIds)
      setEditingAssistantMessageId((prev) =>
        prev && idsToRemove.has(prev) ? null : prev,
      )
      if (result.outcome.kind === 'persisted') {
        void result.outcome.ok.then((ok) => {
          if (!ok) new Notice('Failed to save chat history')
        })
      }
    },
    [sessionController, setEditingAssistantMessageId],
  )

  const handleHistoricalUserMessageDelete = useCallback(
    (userMessageId: string) => {
      if (isCurrentConversationRunActive) return
      const result =
        sessionController.handleHistoricalUserMessageDelete(userMessageId)
      if (!result) return
      releaseHighlightIds(
        collectSelectionHighlightIdsFromMessages(result.removedMessages),
      )
      const removedIds = new Set(result.removedMessages.map((m) => m.id))
      setEditingAssistantMessageId((prev) =>
        prev && removedIds.has(prev) ? null : prev,
      )
      setFocusedMessageId((prev) =>
        prev && removedIds.has(prev) ? inputMessageId : prev,
      )
      if (result.outcome.kind === 'persisted') {
        void result.outcome.ok.then((ok) => {
          if (!ok) new Notice('Failed to save chat history')
        })
      }
    },
    [
      sessionController,
      inputMessageId,
      isCurrentConversationRunActive,
      releaseHighlightIds,
      setEditingAssistantMessageId,
      setFocusedMessageId,
    ],
  )

  // 消息态/偏好切换/AgentService 注册/持久化全部收编进
  // ChatSessionController.branchFromAssistantGroup（含分支缺口修复：分支的
  // 消息现在会注册进 AgentService 内存态,不再只写 React state + 磁盘）。
  // 本函数只解析 policy（settings / module 注册表 / i18n 都不下放进
  // controller）并翻译结果为 UI 反应。
  const handleAssistantMessageGroupBranch = useCallback(
    (messageIds: string[]) => {
      if (messageIds.length === 0) return

      const sourceTitle = getConversationDisplayTitle(
        chatList.find((chat) => chat.id === currentConversationId)?.title,
        t('chat.untitledConversation', 'New chat'),
      )
      const branchTitle = `${sourceTitle} (copy)`

      const nextOverrides =
        conversationOverridesRef.current.get(currentConversationId) ??
        conversationOverrides ??
        null
      const nextPersistedChatMode = normalizePersistedChatMode(
        nextOverrides?.chatMode,
        persistedChatMode,
      )
      const nextChatMode = resolveEffectiveChatMode(
        nextPersistedChatMode,
        moduleChatModeSnapshot,
      )
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

      const result = sessionController.branchFromAssistantGroup(messageIds, {
        nextOverrides,
        nextChatMode,
        nextPersistedChatMode,
        nextYoloEnabled,
        conversationAssistantId,
        resolvedConversationModelId,
        resolvedReasoningLevel,
        branchTitle,
      })

      if (!result) {
        new Notice(t('chat.branchCreateFailed', 'Failed to create branch'))
        return
      }

      setEditingAssistantMessageId(null)
      const newInputMessage = buildNewInputMessage(
        result.resolvedReasoningLevel,
      )
      replaceInputMessage(newInputMessage)
      setFocusedMessageId(newInputMessage.id)
      setQueryProgress({ type: 'idle' })

      void result.persisted.then((ok) => {
        if (ok) {
          new Notice(t('chat.branchCreated', 'Branch created'))
        } else {
          new Notice(t('chat.branchCreateFailed', 'Failed to create branch'))
        }
      })
    },
    [
      sessionController,
      chatList,
      currentConversationId,
      t,
      conversationOverridesRef,
      conversationOverrides,
      persistedChatMode,
      moduleChatModeSnapshot,
      yoloEnabled,
      conversationModelIdRef,
      conversationModelId,
      settings,
      conversationReasoningLevelRef,
      reasoningLevel,
      conversationAssistantId,
      setEditingAssistantMessageId,
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
    persistActiveBranchSelection,
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
