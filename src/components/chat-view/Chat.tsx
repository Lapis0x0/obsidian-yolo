import { EditorView } from '@codemirror/view'
import { Pencil, Trash2 } from 'lucide-react'
import { MarkdownView, TFile, TFolder } from 'obsidian'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import { v4 as uuidv4 } from 'uuid'

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
import { useSettings } from '../../contexts/settings-context'
import {
  resolveAssistantIncludeCurrentFileContent,
  resolveAssistantTimeContextEnabled,
} from '../../core/agent/assistant-capabilities'
import { resolveAssistantModelId } from '../../core/agent/assistant-model'
import { getLatestAssistantContextUsage } from '../../core/agent/compaction'
import { DEFAULT_ASSISTANT_ID } from '../../core/agent/default-assistant'
import {
  type ChatRuntimeId,
  type CliRuntimeScope,
  type CliSessionRef,
  createYoloChatRuntimeActions,
  isCliRuntimeAvailable,
} from '../../core/cli-runtime'
import type { ChatLeafPlacement } from '../../features/chat/chatLeafSessionManager'
import { useChatHighlightSession } from '../../features/editor/selection-highlight/useChatHighlightSession'
import {
  getConversationDisplayTitle,
  useChatHistory,
} from '../../hooks/useChatHistory'
import { useChatManager } from '../../hooks/useJsonManagers'
import { useLiteSkillEntries } from '../../hooks/useLiteSkillEntries'
import type {
  ChatConversationCompactionState,
  ChatMessage,
  ChatUserMessage,
} from '../../types/chat'
import type { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import type {
  Mentionable,
  MentionableAssistantQuote,
  MentionableBlockData,
  MentionableImage,
  MentionableWebSelection,
} from '../../types/mentionable'
import {
  REASONING_LEVELS,
  ReasoningLevel,
  getDefaultReasoningLevel,
  normalizeStoredReasoningLevel,
} from '../../types/reasoning'
import {
  getMentionableKey,
  serializeMentionable,
} from '../../utils/chat/mentionable'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import {
  collectSelectionHighlightIds,
  createSelectionBlockMentionable,
} from '../../utils/chat/selection-mentionables'
import { resolveEffectiveMaxContextTokens } from '../../utils/llm/model-capability-registry'

// removed Prompt Templates feature

import {
  CHAT_MODES,
  CLAUDE_CODE_CHAT_MODES,
  CODEX_CHAT_MODES,
  type ChatMode,
} from './chat-input/ChatModeSelect'
import ChatUserInput from './chat-input/ChatUserInput'
import type { ChatUserInputProps } from './chat-input/ChatUserInput'
import { CliRuntimeControls } from './chat-input/CliRuntimeControls'
import MentionableBadge from './chat-input/MentionableBadge'
import type { SlashCommand } from './chat-input/plugins/mention/SkillSlashPlugin'
import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'
import { ChatHeader } from './ChatHeader'
import {
  getDisplayedAssistantToolMessages,
  getSourceUserMessageIdForGroup,
} from './chatRetry'
import CliChatSurface from './CliChatSurface'
import Composer from './Composer'
import { useActiveViewState } from './hooks/useActiveViewState'
import {
  useMobileChatViewContentClass,
  useMobileKeyboardViewportHeight,
} from './hooks/useMobileViewport'
import { useSnippetEntries } from './hooks/useSnippetEntries'
import { getInputOverlayReserveHeight } from './inputOverlayReserve'
import type { QueryProgressState } from './QueryProgress'
import { TodoListPanel } from './TodoListPanel'
import { useChatDomainActions } from './useChatDomainActions'
import { useChatInputController } from './useChatInputController'
import { useChatRuntimePreferences } from './useChatRuntimePreferences'
import { useChatRuntimeSnapshot } from './useChatRuntimeSnapshot'
import { useChatStreamManager } from './useChatStreamManager'
import { useChatTimelineReadModel } from './useChatTimelineReadModel'
import { useCliRuntimeOrchestration } from './useCliRuntimeOrchestration'
import { useYoloChatSession } from './useYoloChatSession'
import { YoloChatSurface } from './YoloChatSurface'

const EMPTY_SELECTED_SKILLS: NonNullable<ChatUserInputProps['selectedSkills']> =
  []

function useLatestRef<T>(value: T) {
  const ref = useRef(value)
  ref.current = value
  return ref
}

const getNewInputMessage = (
  reasoningLevel: ReasoningLevel,
): ChatUserMessage => {
  return {
    role: 'user',
    content: null,
    promptContent: null,
    id: uuidv4(),
    reasoningLevel,
    mentionables: [],
    selectedSkills: [],
    selectedModelIds: [],
  }
}

const REASONING_LEVEL_CANDIDATES: ReasoningLevel[] = [...REASONING_LEVELS]

export type ChatRef = {
  openNewChat: (selectedBlock?: MentionableBlockData) => void
  loadConversation: (conversationId: string) => Promise<void>
  addSelectionToChat: (selectedBlock: MentionableBlockData) => void
  addSelectionToInput: (selectedBlock: MentionableBlockData) => void
  applySelectionToMainInput: (
    selectedBlock: MentionableBlockData,
    text: string,
    options?: {
      submit?: boolean
      assistantId?: string
    },
  ) => void
  syncSelectionToChat: (selectedBlock: MentionableBlockData) => void
  syncSelectionToInput: (selectedBlock: MentionableBlockData) => void
  syncWebSelectionToInput: (selection: MentionableWebSelection) => void
  clearSelectionFromChat: () => void
  addFileToChat: (file: TFile) => void
  addFolderToChat: (folder: TFolder) => void
  addImageToChat: (image: MentionableImage) => void
  insertTextToInput: (text: string) => void
  appendTextToInput: (text: string) => void
  setMainInputText: (text: string) => void
  focusMessage: () => void
  focusMainInput: () => void
  submitMainInput: () => void
  getCurrentConversationOverrides: () =>
    | ConversationOverrideSettings
    | undefined
  getCurrentConversationModelId: () => string | undefined
  getRuntimeSnapshot: () => ChatRuntimeSnapshot
}

/**
 * 一份足以让 Chat 在 host DOM 被替换后无缝重建的 React state 快照。
 * 只接「会被用户实际改动 / 影响 UI 当前态」的字段——不要把整个 Chat state
 * 都塞进来（消息列表会从 DB 自动恢复，无需快照）。
 */
export type ChatRuntimeSnapshot = {
  activeRuntimeId: ChatRuntimeId
  cliSessionRef: CliSessionRef | null
  cliConversationId: string | null
  currentConversationId: string
  inputMessage: ChatUserMessage
  inputDraftRevision: number
  conversationModelId: string
  conversationAssistantId: string
  chatMode: ChatMode
  yoloEnabled: boolean
  reasoningLevel: ReasoningLevel
  conversationOverrides: ConversationOverrideSettings | null
}

export type ChatProps = {
  cliRuntimeScope?: CliRuntimeScope
  selectedBlock?: MentionableBlockData
  activeView?: 'chat' | 'composer'
  onChangeView?: (view: 'chat' | 'composer') => void
  placement?: ChatLeafPlacement
  initialConversationId?: string
  /**
   * 仅用于 ChatView 在 host DOM 被替换后重建 React tree 时的 state 接力。
   * 首次打开 ChatView 不传；只有 pop-out / dock back 触发的 rebuild 才传。
   */
  seededRuntimeSnapshot?: ChatRuntimeSnapshot
  /** 每当影响 ChatRuntimeSnapshot 的 state 变化时上报当前快照。 */
  onRuntimeSnapshotChange?: (snapshot: ChatRuntimeSnapshot) => void
  onConversationContextChange?: (context: {
    currentConversationId?: string
    currentConversationPersisted?: boolean
    currentConversationTitle?: string
    currentModelId?: string
    currentOverrides?: ConversationOverrideSettings
  }) => void
}

const Chat = forwardRef<ChatRef, ChatProps>((props, ref) => {
  const app = useApp()
  const plugin = usePlugin()
  const agentService = plugin.getAgentService()
  const runtimeActions = useMemo(
    () => createYoloChatRuntimeActions(agentService),
    [agentService],
  )
  const { settings, setSettings, updateSettings } = useSettings()
  const quickAccessSkillEntries = useLiteSkillEntries(app, { settings })
  const quickAccessSnippetEntries = useSnippetEntries()
  const { t } = useLanguage()

  const {
    createOrUpdateConversation,
    createOrUpdateConversationImmediately,
    createOrTouchCliConversation,
    deleteConversation,
    getConversationById,
    updateConversationTitle,
    toggleConversationPinned,
    generateConversationTitle,
    chatList,
  } = useChatHistory()
  const chatManager = useChatManager()
  const seededRuntimeSnapshot = props.seededRuntimeSnapshot
  const cliRuntimeScope = props.cliRuntimeScope
  const cliRuntimeAvailable = isCliRuntimeAvailable()
  const chatMountedRef = useRef(true)
  useEffect(() => {
    chatMountedRef.current = true
    return () => {
      chatMountedRef.current = false
    }
  }, [])
  const [conversationAssistantId, setConversationAssistantId] =
    useState<string>(
      seededRuntimeSnapshot?.conversationAssistantId ??
        settings.currentAssistantId ??
        DEFAULT_ASSISTANT_ID,
    )
  // seed 早于 useChatInputController：activeRuntimeId 直接消费本 state。
  const [currentConversationId, setCurrentConversationId] = useState<string>(
    () =>
      seededRuntimeSnapshot?.currentConversationId ??
      props.initialConversationId ??
      uuidv4(),
  )
  const {
    activeRuntimeId,
    activeRuntimeIdRef,
    setRequestedRuntimeId,
    lastCliRuntimeIdRef,
    initialActiveRuntimeId,
    initialCliModePreference,
    cliModeRequestGenerationRef,
    prePlanCliModeByConversationRef,
    runtimeNavigationGenerationRef,
    handleRuntimeChange,
    conversationModelIdRef,
    conversationReasoningLevelRef,
    conversationAssistantIdRef,
    conversationOverridesRef,
    persistReasoningLevelForModel,
    persistChatRuntimePreference,
    applyAssistantDefaultModel,
    handleConversationAssistantSelect,
    handleChatModeChange,
    handleYoloChange,
    lateStateRef: runtimePreferencesLateStateRef,
  } = useChatRuntimePreferences({
    app,
    t,
    settings,
    setSettings,
    cliRuntimeScope,
    cliRuntimeAvailable,
    chatMountedRef,
    seededActiveRuntimeId: seededRuntimeSnapshot?.activeRuntimeId,
    seededConversationOverrides: seededRuntimeSnapshot?.conversationOverrides,
    hasInitialConversationId: props.initialConversationId !== undefined,
    currentConversationId,
    conversationAssistantId,
    setConversationAssistantId,
  })
  const effectiveSettings = useMemo(
    () => ({
      ...settings,
      currentAssistantId: conversationAssistantId,
    }),
    [conversationAssistantId, settings],
  )
  const requestContextBuilder = useMemo(() => {
    return new RequestContextBuilder(app, effectiveSettings, {
      systemPromptSnapshotStore: agentService.getSystemPromptSnapshotStore(),
      getPromptSourceRevision: () =>
        agentService.getPromptSourceWatcher().getRevision(),
      promptSourcePathsCallback: (paths) =>
        agentService.getPromptSourceWatcher().setWatchedPaths(paths),
    })
  }, [app, effectiveSettings, agentService])

  const normalizeReasoningLevel = useCallback(
    (value?: string): ReasoningLevel | null => {
      const normalized = normalizeStoredReasoningLevel(value)
      if (!normalized) return null
      return REASONING_LEVEL_CANDIDATES.includes(normalized) ? normalized : null
    },
    [],
  )

  const initialReasoningLevel = useMemo(() => {
    const initialModel =
      settings.chatModels.find((m) => m.id === settings.chatModelId) ?? null
    const rememberedLevel = normalizeReasoningLevel(
      settings.chatOptions.reasoningLevelByModelId?.[settings.chatModelId],
    )
    return rememberedLevel ?? getDefaultReasoningLevel(initialModel)
  }, [
    normalizeReasoningLevel,
    settings.chatModelId,
    settings.chatModels,
    settings.chatOptions.reasoningLevelByModelId,
  ])

  const { file: activeFile, viewState: activeViewState } = useActiveViewState()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [containerElement, setContainerElement] =
    useState<HTMLDivElement | null>(null)
  const handleContainerRef = useCallback((element: HTMLDivElement | null) => {
    containerRef.current = element
    setContainerElement(element)
  }, [])
  const mobileKeyboardViewportHeight =
    useMobileKeyboardViewportHeight(containerElement)
  useMobileChatViewContentClass(
    containerElement,
    mobileKeyboardViewportHeight !== null,
  )
  const [isWorkspaceWideHeader, setIsWorkspaceWideHeader] = useState(false)
  const [workspaceWideHeaderHeight, setWorkspaceWideHeaderHeight] = useState(0)

  const [queuedMessageEditState, setQueuedMessageEditState] = useState<{
    preservedInputMessage: ChatUserMessage
    preservedReasoningLevel: ReasoningLevel
  } | null>(null)
  const chatMessagesStateRef = useRef<ChatMessage[]>([])
  const activeBranchByUserMessageIdRef = useRef<Map<string, string>>(new Map())
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [compactionState, setCompactionState] =
    useState<ChatConversationCompactionState>([])
  const [
    pendingCompactionAnchorMessageId,
    setPendingCompactionAnchorMessageId,
  ] = useState<string | null>(null)
  const inputController = useChatInputController({
    seededInputMessage: seededRuntimeSnapshot?.inputMessage,
    seededInputDraftRevision: seededRuntimeSnapshot?.inputDraftRevision,
    initialReasoningLevel,
    selectedBlock: props.selectedBlock,
    activeRuntimeId,
    buildNewInputMessage: getNewInputMessage,
    chatMessagesStateRef,
    setChatMessages,
  })
  const {
    inputMessage,
    inputDraftRevisionRef,
    getLatestInputMessage,
    getLatestInputContent,
    setInputMessage,
    replaceInputMessage,
    inputReplacementVersion,
    focusedMessageId,
    setFocusedMessageId,
    addedBlockKey,
    setAddedBlockKey,
    chatUserInputRefs,
    registerChatUserInputRef,
    handleQuoteAssistantSelection,
    handleDeleteAssistantQuote,
    syncSelectionMentionable,
    syncSelectionMentionableToInput,
    syncWebSelectionMentionableToInput,
    upsertSelectionMentionableInMainInput,
    clearSelectionMentionable,
    handleMainInputRef,
    handleMainInputChange,
    handleMainInputSubmit,
    handleMainInputFocus,
    handleMainInputMentionablesChange,
    handleMainInputRuntimeSkillsChange,
    handleMainInputMentionableDelete,
    handleMainInputModelChange,
    handleMainInputReasoningChange,
    handleMainInputRunSlashCommand,
    handleMainInputAbort,
    addSelectionToChat,
    addFileToChat,
    addFolderToChat,
    addImageToChat,
    insertTextToInput,
    appendTextToInput,
    setMainInputText,
    focusMessage,
    focusMainInput,
    submitMainInput,
  } = inputController
  const cancelRuntimeRun = useCallback(
    (conversationId: string) => {
      void runtimeActions.cancelRun({ runtimeId: 'yolo', conversationId })
    },
    [runtimeActions],
  )
  const [isLoadingConversation, setIsLoadingConversation] = useState(() =>
    Boolean(props.initialConversationId),
  )
  const untitledFallback = t('chat.untitledConversation', 'New chat')
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>(
    seededRuntimeSnapshot?.reasoningLevel ?? initialReasoningLevel,
  )
  const [messageReasoningMap, setMessageReasoningMap] = useState<
    Map<string, ReasoningLevel>
  >(new Map())
  const [editingAssistantMessageId, setEditingAssistantMessageId] = useState<
    string | null
  >(null)
  const [activeApplyRequestKey, setActiveApplyRequestKey] = useState<
    string | null
  >(null)
  const [undoingEditSummaryTarget, setUndoingEditSummaryTarget] = useState<
    string | null
  >(null)
  const applyAbortControllerRef = useRef<AbortController | null>(null)
  const getEditorViewForFile = useCallback(
    (file: TFile): EditorView | null => {
      const markdownLeaves = app.workspace.getLeavesOfType('markdown')
      const targetLeaf = markdownLeaves.find((leaf) => {
        const view = leaf.view
        return view instanceof MarkdownView && view.file?.path === file.path
      })

      if (!(targetLeaf?.view instanceof MarkdownView)) {
        return null
      }

      const editor = targetLeaf.view.editor as { cm?: unknown } | undefined
      return editor?.cm instanceof EditorView ? editor.cm : null
    },
    [app.workspace],
  )
  const [queryProgress, setQueryProgress] = useState<QueryProgressState>({
    type: 'idle',
  })

  const isSidebarPlacement = props.placement === 'sidebar'
  const activeView = isSidebarPlacement ? (props.activeView ?? 'chat') : 'chat'
  const onChangeView = props.onChangeView

  const containerClassName = `yolo-chat-container${
    isSidebarPlacement
      ? ' yolo-chat-container--sidebar'
      : ' yolo-chat-container--centered'
  }${
    !isSidebarPlacement && isWorkspaceWideHeader
      ? ' yolo-chat-container--workspace-wide-header'
      : ''
  }${
    mobileKeyboardViewportHeight !== null
      ? ' yolo-chat-container--mobile-keyboard-managed'
      : ''
  }`
  const fontScale = settings.chatOptions.chatFontScale
  const containerStyle = {
    ...(!isSidebarPlacement && isWorkspaceWideHeader
      ? {
          '--yolo-chat-workspace-header-height': `${workspaceWideHeaderHeight}px`,
        }
      : {}),
    ...(mobileKeyboardViewportHeight !== null
      ? {
          '--yolo-chat-mobile-viewport-height': `${mobileKeyboardViewportHeight}px`,
        }
      : {}),
    ...(fontScale != null ? { zoom: fontScale } : {}),
  } as CSSProperties

  // Per-conversation override settings (temperature, top_p, context, stream)
  const [conversationOverrides, setConversationOverrides] =
    useState<ConversationOverrideSettings | null>(
      seededRuntimeSnapshot?.conversationOverrides ?? null,
    )
  const [chatMode, setChatMode] = useState<ChatMode>(() => {
    if (seededRuntimeSnapshot) {
      return seededRuntimeSnapshot.chatMode
    }
    const defaultMode = settings.chatOptions.chatMode ?? 'agent'
    return defaultMode
  })
  const [yoloEnabled, setYoloEnabled] = useState<boolean>(() => {
    if (seededRuntimeSnapshot) {
      return seededRuntimeSnapshot.yoloEnabled
    }
    return settings.chatOptions.agentYoloEnabled ?? false
  })
  const selectedAssistant = useMemo(() => {
    return (
      settings.assistants.find(
        (assistant) => assistant.id === conversationAssistantId,
      ) ?? null
    )
  }, [conversationAssistantId, settings.assistants])
  const selectedAssistantTimeContextEnabled = useMemo(
    () => resolveAssistantTimeContextEnabled(selectedAssistant, settings),
    [selectedAssistant, settings],
  )

  // Per-conversation model id (do NOT write back to global settings)
  const [conversationModelId, setConversationModelId] = useState<string>(() => {
    if (seededRuntimeSnapshot) {
      return seededRuntimeSnapshot.conversationModelId
    }
    const initialAssistantId =
      settings.currentAssistantId ?? DEFAULT_ASSISTANT_ID
    const initialAssistant = settings.assistants.find(
      (assistant) => assistant.id === initialAssistantId,
    )
    return initialAssistant?.modelId ?? settings.chatModelId
  })

  const currentConversationModel = useMemo(() => {
    return (
      settings.chatModels.find((model) => model.id === conversationModelId) ??
      null
    )
  }, [conversationModelId, settings.chatModels])

  const effectiveMaxContextTokens = useMemo(
    () => resolveEffectiveMaxContextTokens(currentConversationModel),
    [currentConversationModel],
  )

  const headerContextUsage = useMemo(() => {
    const contextUsage = getLatestAssistantContextUsage({
      messages: chatMessages,
      maxContextTokens: effectiveMaxContextTokens,
    })
    if (!contextUsage) {
      return null
    }

    return {
      promptTokens: contextUsage.promptTokens,
      maxContextTokens: contextUsage.maxContextTokens,
      ...(contextUsage.cacheHitRate !== undefined
        ? { cacheHitRate: contextUsage.cacheHitRate }
        : {}),
    }
  }, [chatMessages, effectiveMaxContextTokens])

  const getReasoningLevelForModelId = useCallback(
    (modelId?: string | null): ReasoningLevel => {
      if (!modelId) return 'off'
      const model = settings.chatModels.find((m) => m.id === modelId) ?? null
      const rememberedLevel = normalizeReasoningLevel(
        settings.chatOptions.reasoningLevelByModelId?.[modelId],
      )
      return rememberedLevel ?? getDefaultReasoningLevel(model)
    },
    [
      normalizeReasoningLevel,
      settings.chatModels,
      settings.chatOptions.reasoningLevelByModelId,
    ],
  )

  // Per-message model mapping for historical user messages
  const [messageModelMap, setMessageModelMap] = useState<Map<string, string>>(
    new Map(),
  )
  const [
    assistantGroupBoundaryMessageIds,
    setAssistantGroupBoundaryMessageIds,
  ] = useState<string[]>([])
  const [activeBranchByUserMessageId, setActiveBranchByUserMessageId] =
    useState<Map<string, string>>(new Map())

  const chatTimelineReadModel = useChatTimelineReadModel({
    messages: chatMessages,
    assistantGroupBoundaryMessageIds,
  })
  const groupedChatMessages = chatTimelineReadModel.groupedChatMessages
  const groupedChatMessagesRef = useLatestRef(groupedChatMessages)

  const displayedChatMessages = useMemo(() => {
    return groupedChatMessages.flatMap((messageOrGroup): ChatMessage[] => {
      if (!Array.isArray(messageOrGroup)) {
        return [messageOrGroup]
      }

      return getDisplayedAssistantToolMessages(
        messageOrGroup,
        activeBranchByUserMessageId.get(
          getSourceUserMessageIdForGroup(messageOrGroup) ?? '',
        ),
      )
    })
  }, [activeBranchByUserMessageId, groupedChatMessages])

  const effectiveCompactionState = useMemo(
    () =>
      compactionState.filter((entry) =>
        chatMessages.some((message) => message.id === entry.anchorMessageId),
      ),
    [chatMessages, compactionState],
  )

  useEffect(() => {
    setQueuedMessageEditState(null)
  }, [currentConversationId])

  useEffect(() => {
    chatMessagesStateRef.current = chatMessages
  }, [chatMessages])

  // Selection-highlight lifecycle — see useChatHighlightSession for the full
  // contract. In-input mentions reconcile immediately on delete; sent
  // selection mentions commit to sticky on submit, then drop on the next
  // editor interaction.
  const focusedHistoricalMentionables = useMemo<Mentionable[] | null>(() => {
    if (!focusedMessageId || focusedMessageId === inputMessage.id) return null
    const focused = chatMessages.find(
      (message) => message.role === 'user' && message.id === focusedMessageId,
    )
    return focused?.role === 'user' ? focused.mentionables : null
  }, [chatMessages, focusedMessageId, inputMessage.id])
  const activeAssistantQuotes = useMemo(
    () =>
      (focusedHistoricalMentionables ?? inputMessage.mentionables).filter(
        (mentionable): mentionable is MentionableAssistantQuote =>
          mentionable.type === 'assistant-quote',
      ),
    [focusedHistoricalMentionables, inputMessage.mentionables],
  )

  const { commitSentSelectionHighlights, releaseHighlightIds } =
    useChatHighlightSession({
      conversationId: currentConversationId,
      containerRef,
      inputMentionables: inputMessage.mentionables,
      focusedHistoricalMentionables,
    })
  const {
    cliPreferenceSettingsRef,
    syncCliConversationTitle,
    cliChatMode,
    setCliChatMode,
    cliYoloEnabled,
    setCliYoloEnabled,
    cliConversationController,
    setCliConversationController,
    cliConversationId,
    setCliConversationId,
    activeCliConversationSnapshot,
    isCliRunActive,
    cliOperationCoordinator,
    cliOperationSnapshot,
    cliSubmissionPending,
    cliTransitioning,
    cliModelCatalog,
    cliSkillEntries,
    refreshCliSkills,
    activeHistoryConversationId,
    transitionCliSession,
    createFreshCliConversation,
    consumeAcceptedCliDraft,
    consumePresentedCliDraft,
    handleCliModeSelectChange,
    handleCliYoloChange,
    handleClaudePlanShortcut,
    cliChatRuntimeActions,
    handleCliModelChange,
    handleCliReasoningEffortChange,
    handleCliUserMessageRewrite,
  } = useCliRuntimeOrchestration({
    app,
    t,
    settings,
    updateSettings,
    cliRuntimeScope,
    getConversationById,
    createOrTouchCliConversation,
    activeRuntimeId,
    initialActiveRuntimeId,
    initialCliModePreference,
    activeRuntimeIdRef,
    setRequestedRuntimeId,
    lastCliRuntimeIdRef,
    cliModeRequestGenerationRef,
    prePlanCliModeByConversationRef,
    chatMountedRef,
    seededCliSessionRef: seededRuntimeSnapshot?.cliSessionRef,
    seededCliConversationId: seededRuntimeSnapshot?.cliConversationId,
    currentConversationId,
    conversationOverrides,
    setConversationOverrides,
    conversationOverridesRef,
    reasoningLevel,
    getLatestInputMessage,
    replaceInputMessage,
    buildNewInputMessage: getNewInputMessage,
    commitSentSelectionHighlights,
    inputDraftRevisionRef,
    activeFile,
    activeViewState,
  })

  // useChatRuntimePreferences 的处理器（applyAssistantDefaultModel/
  // handleConversationAssistantSelect/handleChatModeChange/handleYoloChange/
  // handleRuntimeChange）依赖输入控制器与 CLI 编排 hook 都已就绪之后才产生
  // 的值,一律经 lateStateRef 注入——与 inputController.lateStateRef 完全
  // 相同的惯例,只是本对象在两者都就绪后立即写入。
  runtimePreferencesLateStateRef.current = {
    setInputMessage,
    conversationModelId,
    setConversationModelId,
    setReasoningLevel,
    setChatMode,
    setYoloEnabled,
    conversationOverrides,
    setConversationOverrides,
    selectedAssistant,
    getReasoningLevelForModelId,
    cliPreferenceSettingsRef,
    cliModelCatalog,
    setCliConversationController,
    setCliConversationId,
    setCliChatMode,
    setCliYoloEnabled,
    transitionCliSession,
    activeHistoryConversationId,
  }

  const currentConversationPersisted = useMemo(
    () =>
      chatList.some(
        (conversation) => conversation.id === activeHistoryConversationId,
      ),
    [activeHistoryConversationId, chatList],
  )
  const currentConversationTitle = useMemo(() => {
    const rawTitle = activeHistoryConversationId
      ? chatList.find(
          (conversation) => conversation.id === activeHistoryConversationId,
        )?.title
      : undefined
    return getConversationDisplayTitle(rawTitle, untitledFallback)
  }, [activeHistoryConversationId, chatList, untitledFallback])

  useEffect(() => {
    props.onConversationContextChange?.({
      currentConversationId: activeHistoryConversationId,
      currentConversationPersisted,
      currentConversationTitle,
      currentModelId:
        conversationModelId ??
        (currentConversationId
          ? conversationModelIdRef.current.get(currentConversationId)
          : undefined),
      currentOverrides:
        conversationOverrides === null
          ? undefined
          : (conversationOverrides ??
            (currentConversationId
              ? conversationOverridesRef.current.get(currentConversationId)
              : undefined)),
    })
  }, [
    currentConversationTitle,
    currentConversationPersisted,
    conversationModelId,
    conversationOverrides,
    activeHistoryConversationId,
    props.onConversationContextChange,
  ])

  const displayMentionablesForInput = inputMessage.mentionables

  const currentFileOverride = resolveAssistantIncludeCurrentFileContent(
    selectedAssistant,
    settings,
  )
    ? activeFile
    : null

  // Callback-ref + state for the overlay element. A plain useRef with a
  // mount-once effect would lose its observation when the chat view unmounts
  // (e.g. switching to the composer view and back), since the new overlay
  // element never re-binds. Driving the measurement effect off element state
  // ensures attach/detach cleanly drive observer setup/teardown.
  const [inputOverlayElement, setInputOverlayElement] =
    useState<HTMLDivElement | null>(null)
  const [inputOverlayHeight, setInputOverlayHeight] = useState(0)
  // YoloChatSurface 现在拥有自己的 chatMessagesRef/useAutoScroll（与
  // CliChatSurface 对称）。useChatStreamManager 仍需要在流式消息到达时触发
  // 自动滚动，因此这里保留一个稳定引用作为 ref 注入桥——YoloChatSurface 把
  // 它内部最新的 autoScrollToBottom 写入这个 ref，triggerAutoScrollToBottom
  // 的身份永远不变，不会导致 useChatStreamManager 的订阅 effect 反复重建。
  const autoScrollToBottomRef = useRef<() => void>(() => {})
  const triggerAutoScrollToBottom = useCallback(() => {
    autoScrollToBottomRef.current()
  }, [])
  // 同上：useChatDomainActions 在 apply/提交等动作后需要强制滚到底部。
  const forceScrollToBottomRef = useRef<() => void>(() => {})
  const triggerForceScrollToBottom = useCallback(() => {
    forceScrollToBottomRef.current()
  }, [])

  // Measure the overlay above the input box so the timeline can reserve
  // equivalent scrollable space at its bottom — keeps the last assistant
  // message's metadata bar reachable instead of hidden behind the overlay.
  // Reserve only while the overlay has renderable children; otherwise a stale
  // measurement can leave an invisible spacer between the footer and input.
  useLayoutEffect(() => {
    if (!inputOverlayElement) {
      // Element detached (e.g. switched to composer view). Reset budget so
      // the timeline doesn't keep reserving phantom space.
      setInputOverlayHeight(0)
      return
    }

    const ownerWindow = inputOverlayElement.ownerDocument.defaultView ?? window
    let animationFrameId: number | null = null

    const publishHeight = () => {
      const nextHeight = getInputOverlayReserveHeight(inputOverlayElement)
      setInputOverlayHeight((previous) =>
        previous === nextHeight ? previous : nextHeight,
      )
    }

    const schedulePublishHeight = () => {
      if (animationFrameId !== null) {
        ownerWindow.cancelAnimationFrame(animationFrameId)
      }
      animationFrameId = ownerWindow.requestAnimationFrame(() => {
        animationFrameId = null
        publishHeight()
      })
    }

    publishHeight()

    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(schedulePublishHeight)
    resizeObserver?.observe(inputOverlayElement)

    const mutationObserver =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(schedulePublishHeight)
    mutationObserver?.observe(inputOverlayElement, {
      attributes: true,
      attributeFilter: ['class', 'hidden', 'style'],
      childList: true,
      subtree: true,
    })

    return () => {
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      if (animationFrameId !== null) {
        ownerWindow.cancelAnimationFrame(animationFrameId)
      }
    }
  }, [inputOverlayElement])

  const {
    abortConversationRun,
    compactConversation,
    currentConversationRunSummary,
    submitChatMutation,
    buildContextBreakdownInputs,
  } = useChatStreamManager({
    setChatMessages,
    setCompactionState,
    setPendingCompactionAnchorMessageId,
    autoScrollToBottom: triggerAutoScrollToBottom,
    requestContextBuilder,
    currentConversationId,
    cancelRuntimeRun,
    conversationOverrides: conversationOverrides ?? undefined,
    modelId: conversationModelId,
    chatMode,
    yoloEnabled,
    currentFileOverride,
    currentFileViewState: activeViewState,
    assistantIdOverride: conversationAssistantId,
    compaction: effectiveCompactionState,
  })
  const isCurrentConversationRunActive = currentConversationRunSummary.isActive

  const {
    runSummariesByConversationId,
    queuedUserMessages,
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
  } = useYoloChatSession({
    initialConversationId: props.initialConversationId,
    onConversationContextChange: props.onConversationContextChange,
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
    inputMessageId: inputMessage.id,
    getLatestInputMessage,
    replaceInputMessage,
    buildNewInputMessage: getNewInputMessage,
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
  })

  const {
    handleManualContextCompaction,
    handleRecoverPendingToolCall,
    handleRecoverAnswerUserQuestion,
    handleUserMessageSubmit,
    handleAssistantMessageGroupRetry,
    handleAssistantErrorContinue,
    applyMutation,
    handleApply,
    handleUndoEditSummary,
    handleOpenEditSummaryFile,
    handleToolMessageUpdate,
    handleToolCallResponseUpdate,
    handleContinueResponse,
    handleExportChatToVault,
  } = useChatDomainActions({
    chatMessages,
    chatMessagesStateRef,
    setChatMessages,
    currentConversationId,
    conversationOverrides,
    conversationModelId,
    chatMode,
    yoloEnabled,
    effectiveCompactionState,
    setCompactionState,
    setPendingCompactionAnchorMessageId,
    assistantGroupBoundaryMessageIds,
    setAssistantGroupBoundaryMessageIds,
    activeBranchByUserMessageIdRef,
    setActiveBranchByUserMessageId,
    messageModelMap,
    reasoningLevel,
    conversationReasoningLevelRef,
    groupedChatMessagesRef,
    selectedAssistant,
    setQueryProgress,
    setUndoingEditSummaryTarget,
    activeApplyRequestKey,
    setActiveApplyRequestKey,
    applyAbortControllerRef,
    forceScrollToBottom: triggerForceScrollToBottom,
    runtimeNavigationGenerationRef,
    getEditorViewForFile,
    persistConversationImmediately,
    normalizeAssistantGroupBoundaryMessageIds,
    serializeMessageModelMap,
    createOrUpdateConversation,
    createOrUpdateConversationImmediately,
    generateConversationTitle,
    submitChatMutation,
    abortConversationRun,
    compactConversation,
    currentConversationRunSummary,
    requestContextBuilder,
    chatManager,
    normalizeReasoningLevel,
  })

  const { buildRuntimeSnapshot } = useChatRuntimeSnapshot({
    onRuntimeSnapshotChange: props.onRuntimeSnapshotChange,
    activeRuntimeId,
    cliSessionRef: activeCliConversationSnapshot?.sessionRef,
    cliConversationId,
    currentConversationId,
    inputMessage,
    getLatestInputMessage,
    inputDraftRevisionRef,
    conversationModelId,
    conversationAssistantId,
    chatMode,
    yoloEnabled,
    reasoningLevel,
    conversationOverrides,
  })

  useEffect(() => {
    setFocusedMessageId(inputMessage.id)
  }, [inputMessage.id])

  useImperativeHandle(ref, () => ({
    openNewChat: (selectedBlock?: MentionableBlockData) =>
      handleNewChat(selectedBlock),
    loadConversation: async (conversationId: string) =>
      await handleLoadConversation(conversationId),
    addSelectionToChat,
    addSelectionToInput: (selectedBlock: MentionableBlockData) => {
      const mentionable = createSelectionBlockMentionable({
        ...selectedBlock,
        source: 'selection-pinned',
      })

      setAddedBlockKey(null)
      upsertSelectionMentionableInMainInput(mentionable)
    },
    applySelectionToMainInput: (
      selectedBlock: MentionableBlockData,
      text: string,
      options?: {
        submit?: boolean
        assistantId?: string
      },
    ) => {
      const mentionable = createSelectionBlockMentionable({
        ...selectedBlock,
        source: 'selection-pinned',
      })

      setAddedBlockKey(null)
      // Override the conversation's assistant/model inside the same flushSync
      // as the mentionable update so the subsequent submit() reads the new
      // state. The override is scoped to this conversation: we do NOT persist
      // it to settings.currentAssistantId, so the user's global default is
      // preserved.
      const overrideAssistantId = options?.assistantId
      const overrideAssistant = overrideAssistantId
        ? (settings.assistants.find(
            (assistant) => assistant.id === overrideAssistantId,
          ) ?? null)
        : null
      const applySelection = () => {
        flushSync(() => {
          if (overrideAssistant) {
            if (activeRuntimeIdRef.current === 'yolo') {
              setConversationAssistantId(overrideAssistant.id)
              conversationAssistantIdRef.current.set(
                currentConversationId,
                overrideAssistant.id,
              )
              applyAssistantDefaultModel(
                resolveAssistantModelId(
                  overrideAssistant.modelId,
                  settings.chatModelId,
                ),
              )
            }
          }
          upsertSelectionMentionableInMainInput(mentionable)
        })

        const inputRef = chatUserInputRefs.current.get(inputMessage.id)
        if (text) inputRef?.appendText(text)
        if (options?.submit) {
          inputRef?.submit()
        } else {
          inputRef?.focus()
        }
      }

      applySelection()
    },
    syncSelectionToChat: (selectedBlock: MentionableBlockData) => {
      syncSelectionMentionable(selectedBlock)
    },
    syncSelectionToInput: (selectedBlock: MentionableBlockData) => {
      syncSelectionMentionableToInput(selectedBlock)
    },
    syncWebSelectionToInput: (selection: MentionableWebSelection) => {
      syncWebSelectionMentionableToInput(selection)
    },
    clearSelectionFromChat: () => {
      clearSelectionMentionable()
    },
    addFileToChat,
    addFolderToChat,
    addImageToChat,
    insertTextToInput,
    appendTextToInput,
    setMainInputText,
    focusMessage,
    focusMainInput,
    submitMainInput,
    getCurrentConversationOverrides: () => {
      if (conversationOverrides) {
        return conversationOverrides
      }
      if (!currentConversationId) {
        return undefined
      }
      const stored = conversationOverridesRef.current.get(currentConversationId)
      return stored ?? undefined
    },
    getCurrentConversationModelId: () => {
      if (conversationModelId) {
        return conversationModelId
      }
      if (!currentConversationId) {
        return undefined
      }
      return conversationModelIdRef.current.get(currentConversationId)
    },
    getRuntimeSnapshot: () => buildRuntimeSnapshot(),
  }))

  const header = (
    <ChatHeader
      isSidebarPlacement={isSidebarPlacement}
      activeView={activeView}
      onChangeView={onChangeView}
      activeRuntimeId={activeRuntimeId}
      handleRuntimeChange={handleRuntimeChange}
      lastCliRuntimeIdRef={lastCliRuntimeIdRef}
      cliRuntimeAvailable={cliRuntimeAvailable}
      cliRuntimeScope={cliRuntimeScope}
      containerRef={containerRef}
      isWorkspaceWideHeader={isWorkspaceWideHeader}
      setIsWorkspaceWideHeader={setIsWorkspaceWideHeader}
      setWorkspaceWideHeaderHeight={setWorkspaceWideHeaderHeight}
      conversationAssistantId={conversationAssistantId}
      handleConversationAssistantSelect={handleConversationAssistantSelect}
      handleNewChat={handleNewChat}
      handleExportChatToVault={handleExportChatToVault}
      currentConversationId={currentConversationId}
      chatList={chatList}
      activeHistoryConversationId={activeHistoryConversationId}
      runSummariesByConversationId={runSummariesByConversationId}
      handleLoadConversation={handleLoadConversation}
      getConversationById={getConversationById}
      deleteConversation={deleteConversation}
      updateConversationTitle={updateConversationTitle}
      syncCliConversationTitle={syncCliConversationTitle}
      toggleConversationPinned={toggleConversationPinned}
      generateConversationTitle={generateConversationTitle}
    />
  )

  const buildContextBreakdownInputsRef = useLatestRef(
    buildContextBreakdownInputs,
  )

  // 输入控制器的「延迟依赖」——CLI 编排、会话持久化、useChatStreamManager
  // 均在 useChatInputController 调用之后才产生；本对象在每次渲染的这个
  // 位置写入最新快照，供 handleMainInputSubmit 等已经在 hook 内部创建好
  // 的处理器通过 lateStateRef 读取。取代原先的 mainInputSubmitStateRef /
  // releaseHighlightIdsRef 等各个独立 useLatestRef。
  inputController.lateStateRef.current = {
    reasoningLevel,
    updateHistoricalUserMessage,
    releaseHighlightIds,
    isUserMessageEffectivelyEmpty,
    buildAssistantGroupBoundaryMessageIdsAfterUserRemoval,
    assistantGroupBoundaryMessageIds,
    setAssistantGroupBoundaryMessageIds,
    persistConversation,
    deleteConversation,
    currentConversationId,
    setMessageModelMap,
    setMessageReasoningMap,
    activeBranchByUserMessageIdRef,
    setActiveBranchByUserMessageId,
    activeFile,
    activeViewState,
    agentService,
    app,
    chatMessages,
    cliChatMode,
    cliConversationId,
    commitSentSelectionHighlights,
    conversationModelId,
    conversationOverrides,
    cliConversationController,
    cliOperationCoordinator,
    cliRuntimeScope,
    currentConversationRunSummary,
    createOrTouchCliConversation,
    displayedChatMessages,
    handleUserMessageSubmit,
    generateConversationTitle,
    syncCliConversationTitle,
    messageModelMap,
    queuedMessageEditState,
    setQueuedMessageEditState,
    selectedAssistant,
    settings,
    t,
    cliYoloEnabled,
    setCliConversationId,
    consumeAcceptedCliDraft,
    conversationReasoningLevelRef,
    setReasoningLevel,
    chatMountedRef,
    handleManualContextCompaction,
    cliPreferenceSettingsRef,
    refreshCliSkills,
    abortConversationRun,
    setConversationModelId,
    conversationModelIdRef,
    getReasoningLevelForModelId,
    persistReasoningLevelForModel,
  }

  const buildMainInputContextBreakdownInputs = useCallback(() => {
    return buildContextBreakdownInputsRef.current(chatMessagesStateRef.current)
  }, [buildContextBreakdownInputsRef])

  const mainInputContextUsage = useMemo<ChatUserInputProps['contextUsage']>(
    () =>
      headerContextUsage
        ? {
            promptTokens: headerContextUsage.promptTokens,
            maxContextTokens: headerContextUsage.maxContextTokens,
            ...(headerContextUsage.cacheHitRate !== undefined
              ? { cacheHitRate: headerContextUsage.cacheHitRate }
              : {}),
            label: t('chat.contextUsage', '上下文窗口占用'),
            buildBreakdownInputs: buildMainInputContextBreakdownInputs,
          }
        : undefined,
    [headerContextUsage, buildMainInputContextBreakdownInputs, t],
  )
  const cliInputContextUsage = useMemo<
    ChatUserInputProps['contextUsage']
  >(() => {
    const usage = activeCliConversationSnapshot?.contextUsage
    if (!usage) return undefined
    return {
      promptTokens: usage.promptTokens,
      maxContextTokens: usage.maxContextTokens,
      ...(usage.cacheHitRate !== undefined
        ? { cacheHitRate: usage.cacheHitRate }
        : {}),
      label: t('chat.contextUsage', '上下文窗口占用'),
      ...(usage.categories && usage.categories.length > 0
        ? { categories: usage.categories }
        : {}),
    }
  }, [activeCliConversationSnapshot?.contextUsage, t])
  // `/` 菜单按运行时暴露的原生动作条目：claude-code 有插件管理 + MCP 状态，
  // codex 仅 MCP 状态（无插件机制），yolo 运行时没有对应 CLI 客户端。
  const nativeSlashCommands = useMemo<SlashCommand[]>(() => {
    if (activeRuntimeId === 'claude-code') {
      return [
        {
          id: 'open-plugin-manager',
          name: t('chat.slashCommands.openPluginManager.label', '插件管理'),
          description: t(
            'chat.slashCommands.openPluginManager.description',
            '管理已安装的 Claude Code 插件，或从 Marketplace 安装新插件。',
          ),
        },
        {
          id: 'open-mcp-servers',
          name: t('chat.slashCommands.openMcpServers.label', 'MCP 服务器'),
          description: t(
            'chat.slashCommands.openMcpServers.description',
            '查看当前会话加载的 MCP 服务器状态。',
          ),
        },
      ]
    }
    if (activeRuntimeId === 'codex') {
      return [
        {
          id: 'open-mcp-servers',
          name: t('chat.slashCommands.openMcpServers.label', 'MCP 服务器'),
          description: t(
            'chat.slashCommands.openMcpServers.description',
            '查看当前会话加载的 MCP 服务器状态。',
          ),
        },
      ]
    }
    return []
  }, [activeRuntimeId, t])
  const mainInputSelectedSkills =
    inputMessage.selectedSkills ?? EMPTY_SELECTED_SKILLS

  const showEmptyState =
    groupedChatMessages.length === 0 &&
    !isCurrentConversationRunActive &&
    !isLoadingConversation
  const workspaceTitleParts = t(
    'chat.emptyState.workspaceTitle',
    '今天想在 {vaultName} 中做点什么？',
  ).split('{vaultName}')
  const workspaceEmptyStateTitle = !isSidebarPlacement ? (
    <>
      {workspaceTitleParts[0]}
      <span className="yolo-chat-empty-state-vault-name">
        {app.vault.getName()}
      </span>
      {workspaceTitleParts.slice(1).join('{vaultName}')}
    </>
  ) : undefined
  const isCliRuntimeActive = activeRuntimeId !== 'yolo'
  const activeSurfaceEmpty = isCliRuntimeActive
    ? (activeCliConversationSnapshot?.messages.length ?? 0) === 0 &&
      !isCliRunActive
    : showEmptyState
  const mainInputFooter = (
    <div className="yolo-chat-input-wrapper">
      <div ref={setInputOverlayElement} className="yolo-chat-input-overlay">
        {!isCliRuntimeActive && queuedUserMessages.length > 0 ? (
          <div className="yolo-chat-queued-messages">
            <div className="yolo-chat-queued-messages__hint">
              {t('chat.queueMessage.hint', '等待 Agent 完成当前步骤...')}
            </div>
            {queuedUserMessages.map((queued) => {
              const preview = queued.content
                ? editorStateToPlainText(queued.content).trim()
                : ''
              return (
                <div
                  key={queued.id}
                  className="yolo-chat-queued-messages__item"
                  title={preview}
                >
                  <span className="yolo-chat-queued-messages__preview">
                    {preview || ' '}
                  </span>
                  <span className="yolo-chat-queued-messages__actions">
                    <button
                      type="button"
                      className="yolo-chat-queued-messages__action"
                      aria-label={t('common.edit', '编辑')}
                      title={t('common.edit', '编辑')}
                      disabled={queuedMessageEditState !== null}
                      onClick={() => {
                        const removed = agentService.removePendingUserMessage(
                          currentConversationId,
                          queued.id,
                        )
                        if (!removed) return

                        const preservedReasoningLevel = reasoningLevel
                        const editingReasoningLevel =
                          normalizeReasoningLevel(removed.reasoningLevel) ??
                          reasoningLevel
                        setQueuedMessageEditState({
                          preservedInputMessage: getLatestInputMessage(),
                          preservedReasoningLevel,
                        })
                        setReasoningLevel(editingReasoningLevel)
                        replaceInputMessage({
                          ...removed,
                          timeContext: undefined,
                        })
                        requestAnimationFrame(() => {
                          chatUserInputRefs.current.get(removed.id)?.focus()
                        })
                      }}
                    >
                      <Pencil size={13} strokeWidth={2.5} />
                    </button>
                    <button
                      type="button"
                      className="yolo-chat-queued-messages__action is-delete"
                      aria-label={t('common.delete', '删除')}
                      title={t('common.delete', '删除')}
                      onClick={() => {
                        const removed = agentService.removePendingUserMessage(
                          currentConversationId,
                          queued.id,
                        )
                        if (!removed) return
                        releaseHighlightIds(
                          collectSelectionHighlightIds(removed.mentionables),
                        )
                        setMessageReasoningMap((prev) => {
                          if (!prev.has(removed.id)) return prev
                          const next = new Map(prev)
                          next.delete(removed.id)
                          return next
                        })
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </span>
                </div>
              )
            })}
          </div>
        ) : null}
        {!isCliRuntimeActive ? (
          <TodoListPanel
            key={currentConversationId}
            messages={displayedChatMessages}
            queuedMessageCount={queuedUserMessages.length}
          />
        ) : null}
      </div>
      {(settings.chatOptions.mentionDisplayMode ?? 'inline') === 'badge' &&
      displayMentionablesForInput.length > 0 ? (
        <div className="yolo-chat-user-input-files">
          {displayMentionablesForInput.map((mentionable) => {
            const mentionableKey = getMentionableKey(
              serializeMentionable(mentionable),
            )
            return (
              <MentionableBadge
                key={mentionableKey}
                mentionable={mentionable}
                onDelete={() => handleMainInputMentionableDelete(mentionable)}
                onClick={() => {}}
              />
            )
          })}
        </div>
      ) : null}
      <ChatUserInput
        key={inputMessage.id}
        ref={handleMainInputRef}
        initialSerializedEditorState={null}
        getInitialSerializedEditorState={getLatestInputContent}
        replacementVersion={inputReplacementVersion}
        onChange={handleMainInputChange}
        onSubmit={handleMainInputSubmit}
        onFocus={handleMainInputFocus}
        mentionables={inputMessage.mentionables}
        setMentionables={handleMainInputMentionablesChange}
        selectedSkills={mainInputSelectedSkills}
        setSelectedSkills={handleMainInputRuntimeSkillsChange}
        enableSkills
        skipImageModelCapabilityCheck={isCliRuntimeActive}
        skillEntries={isCliRuntimeActive ? cliSkillEntries : undefined}
        modelId={conversationModelId}
        onModelChange={handleMainInputModelChange}
        showModelControl={!isCliRuntimeActive}
        allowModelMentions={!isCliRuntimeActive}
        reasoningLevel={reasoningLevel}
        onReasoningChange={handleMainInputReasoningChange}
        showReasoningSelect={!isCliRuntimeActive}
        runtimeControls={
          isCliRuntimeActive ? (
            <CliRuntimeControls
              configuration={
                activeCliConversationSnapshot?.configuration ?? null
              }
              cachedModels={cliModelCatalog.get(activeRuntimeId)}
              runtimeId={activeRuntimeId}
              disabled={
                cliSubmissionPending || isCliRunActive || cliTransitioning
              }
              onModelChange={handleCliModelChange}
              onReasoningEffortChange={handleCliReasoningEffortChange}
            />
          ) : undefined
        }
        autoFocus
        addedBlockKey={addedBlockKey}
        hideBadgeMentionables
        displayMentionables={displayMentionablesForInput}
        onDeleteFromAll={handleMainInputMentionableDelete}
        currentAssistantId={
          isCliRuntimeActive ? undefined : conversationAssistantId
        }
        onSelectAssistantForConversation={
          isCliRuntimeActive ? undefined : handleConversationAssistantSelect
        }
        currentChatMode={isCliRuntimeActive ? cliChatMode : chatMode}
        onSelectChatModeForConversation={
          isCliRuntimeActive ? handleCliModeSelectChange : handleChatModeChange
        }
        chatMode={isCliRuntimeActive ? cliChatMode : chatMode}
        onChatModeChange={
          isCliRuntimeActive ? handleCliModeSelectChange : handleChatModeChange
        }
        chatModeOptions={
          activeRuntimeId === 'claude-code'
            ? CLAUDE_CODE_CHAT_MODES
            : activeRuntimeId === 'codex'
              ? CODEX_CHAT_MODES
              : CHAT_MODES
        }
        yoloEnabled={isCliRuntimeActive ? cliYoloEnabled : yoloEnabled}
        onYoloChange={
          isCliRuntimeActive ? handleCliYoloChange : handleYoloChange
        }
        onEditorKeyDown={handleClaudePlanShortcut}
        allowAgentModeOption
        enableResize
        onRunSlashCommand={handleMainInputRunSlashCommand}
        nativeSlashCommands={nativeSlashCommands}
        isGenerating={
          isCliRuntimeActive
            ? cliSubmissionPending || isCliRunActive || cliTransitioning
            : currentConversationRunSummary.isAbortable
        }
        canQueueWhileGenerating={
          isCliRuntimeActive ? false : currentConversationRunSummary.isQueueable
        }
        onAbort={handleMainInputAbort}
        contextUsage={
          isCliRuntimeActive ? cliInputContextUsage : mainInputContextUsage
        }
        showQuickAccess={activeSurfaceEmpty && !isSidebarPlacement}
        quickAccessSkillEntries={
          isCliRuntimeActive ? [] : quickAccessSkillEntries
        }
        quickAccessSnippetEntries={quickAccessSnippetEntries}
      />
    </div>
  )

  return (
    <div
      ref={handleContainerRef}
      className={`${containerClassName}${
        activeSurfaceEmpty ? ' yolo-chat-container--empty-state' : ''
      }`}
      style={containerStyle}
    >
      {header}
      {activeView === 'composer' ? (
        <div className="yolo-chat-composer-wrapper">
          <Composer onNavigateChat={() => onChangeView?.('chat')} />
        </div>
      ) : isCliRuntimeActive &&
        cliConversationController &&
        activeCliConversationSnapshot &&
        cliRuntimeScope ? (
        <CliChatSurface
          key={activeCliConversationSnapshot.surfaceId}
          snapshot={activeCliConversationSnapshot}
          presentedDraft={cliOperationSnapshot?.presentedDraft ?? null}
          showEmptyState={activeSurfaceEmpty}
          actions={cliChatRuntimeActions ?? cliRuntimeScope.chatRuntimeActions}
          footerContent={mainInputFooter}
          emptyStateWorkspaceTitle={workspaceEmptyStateTitle}
          onRewriteUserMessage={handleCliUserMessageRewrite}
          onPresentedDraftHandled={consumePresentedCliDraft}
          cachedModels={cliModelCatalog.get(activeRuntimeId) ?? []}
          assistantQuotes={inputMessage.mentionables.filter(
            (mentionable): mentionable is MentionableAssistantQuote =>
              mentionable.type === 'assistant-quote',
          )}
          onQuoteAssistantSelection={handleQuoteAssistantSelection}
          onDeleteAssistantQuote={handleDeleteAssistantQuote}
        />
      ) : (
        <YoloChatSurface
          chatMode={chatMode}
          yoloEnabled={yoloEnabled}
          showEmptyState={showEmptyState}
          currentConversationId={currentConversationId}
          editingAssistantMessageId={editingAssistantMessageId}
          setEditingAssistantMessageId={setEditingAssistantMessageId}
          emptyStateWorkspaceTitle={workspaceEmptyStateTitle}
          bottomSpacerHeight={inputOverlayHeight}
          footerContent={mainInputFooter}
          runtimeActions={runtimeActions}
          autoScrollToBottomRef={autoScrollToBottomRef}
          forceScrollToBottomRef={forceScrollToBottomRef}
          chatMessages={chatMessages}
          chatMessagesStateRef={chatMessagesStateRef}
          chatTimelineReadModel={chatTimelineReadModel}
          activeBranchByUserMessageId={activeBranchByUserMessageId}
          activeBranchByUserMessageIdRef={activeBranchByUserMessageIdRef}
          setActiveBranchByUserMessageId={setActiveBranchByUserMessageId}
          effectiveCompactionState={effectiveCompactionState}
          pendingCompactionAnchorMessageId={pendingCompactionAnchorMessageId}
          queryProgress={queryProgress}
          currentConversationRunSummary={currentConversationRunSummary}
          isCurrentConversationRunActive={isCurrentConversationRunActive}
          isApplying={applyMutation.isPending}
          activeApplyRequestKey={activeApplyRequestKey}
          undoingEditSummaryTarget={undoingEditSummaryTarget}
          messageModelMap={messageModelMap}
          setMessageModelMap={setMessageModelMap}
          messageReasoningMap={messageReasoningMap}
          setMessageReasoningMap={setMessageReasoningMap}
          setChatMessages={setChatMessages}
          conversationModelId={conversationModelId}
          setConversationModelId={setConversationModelId}
          conversationModelIdRef={conversationModelIdRef}
          conversationAssistantId={conversationAssistantId}
          reasoningLevel={reasoningLevel}
          setReasoningLevel={setReasoningLevel}
          conversationReasoningLevelRef={conversationReasoningLevelRef}
          selectedAssistantTimeContextEnabled={
            selectedAssistantTimeContextEnabled
          }
          getReasoningLevelForModelId={getReasoningLevelForModelId}
          persistReasoningLevelForModel={persistReasoningLevelForModel}
          normalizeReasoningLevel={normalizeReasoningLevel}
          setInputMessage={setInputMessage}
          focusedMessageId={focusedMessageId}
          setFocusedMessageId={setFocusedMessageId}
          inputMessageId={inputMessage.id}
          activeAssistantQuotes={activeAssistantQuotes}
          chatUserInputRefs={chatUserInputRefs}
          registerChatUserInputRef={registerChatUserInputRef}
          handleQuoteAssistantSelection={handleQuoteAssistantSelection}
          handleDeleteAssistantQuote={handleDeleteAssistantQuote}
          releaseHighlightIds={releaseHighlightIds}
          persistConversation={persistConversation}
          updateHistoricalUserMessage={updateHistoricalUserMessage}
          finalizeHistoricalUserMessageEdit={finalizeHistoricalUserMessageEdit}
          dismissHistoricalUserMessage={dismissHistoricalUserMessage}
          handleAssistantMessageEditSave={handleAssistantMessageEditSave}
          handleAssistantMessageEditCancel={handleAssistantMessageEditCancel}
          handleAssistantMessageGroupDelete={handleAssistantMessageGroupDelete}
          handleHistoricalUserMessageDelete={handleHistoricalUserMessageDelete}
          handleAssistantMessageGroupBranch={handleAssistantMessageGroupBranch}
          handleChatModeChange={handleChatModeChange}
          handleUserMessageSubmit={handleUserMessageSubmit}
          handleRecoverPendingToolCall={handleRecoverPendingToolCall}
          handleRecoverAnswerUserQuestion={handleRecoverAnswerUserQuestion}
          handleAssistantMessageGroupRetry={handleAssistantMessageGroupRetry}
          handleAssistantErrorContinue={handleAssistantErrorContinue}
          handleApply={handleApply}
          handleUndoEditSummary={handleUndoEditSummary}
          handleOpenEditSummaryFile={handleOpenEditSummaryFile}
          handleToolMessageUpdate={handleToolMessageUpdate}
          handleToolCallResponseUpdate={handleToolCallResponseUpdate}
          handleContinueResponse={handleContinueResponse}
        />
      )}
    </div>
  )
})

Chat.displayName = 'Chat'

export default Chat
