import { EditorView } from '@codemirror/view'
import { Download, History, Pencil, Plus, Trash2 } from 'lucide-react'
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
  type YoloConversationRef,
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
  AssistantToolMessageGroup,
  ChatConversationCompactionState,
  ChatMessage,
  ChatSubagentResultMessage,
  ChatTerminalCommandResultMessage,
  ChatUserMessage,
} from '../../types/chat'
import { getLatestChatConversationCompaction } from '../../types/chat'
import type {
  ChatTimelineAssistantGroupItem,
  ChatTimelineItem,
} from '../../types/chat-timeline'
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
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import {
  buildForegroundAgentVisualTurnPlan,
  getForegroundAgentFooterForGroup,
} from '../../utils/chat/foregroundAgentVisualTurns'
import {
  getMentionableKey,
  serializeMentionable,
} from '../../utils/chat/mentionable'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import {
  collectRemovedSelectionHighlightIds,
  collectSelectionHighlightIds,
  createSelectionBlockMentionable,
} from '../../utils/chat/selection-mentionables'
import { buildChatTimelineItems } from '../../utils/chat/timeline'
import {
  buildSubagentResultMap,
  buildTerminalCommandResultMap,
  collectToolCallIdsFromGroupedMessages,
  reuseShallowEqualMap,
} from '../../utils/chat/tool-result-index'
import { formatTokenCount } from '../../utils/llm/formatTokenCount'
import { resolveEffectiveMaxContextTokens } from '../../utils/llm/model-capability-registry'
import { stampUserMessageTimeContext } from '../../utils/prompt/timeContext'

// removed Prompt Templates feature

import { AssistantSelector } from './AssistantSelector'
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
import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'
import { ChatRuntimeActionsProvider } from './chat-runtime-actions-context'
import { getChatSurfacePreset } from './chat-surface-presets'
import { ChatListDropdown } from './ChatListDropdown'
import {
  buildAssistantErrorContinuation,
  getDisplayedAssistantToolMessages,
  getSourceUserMessageIdForGroup,
} from './chatRetry'
import CliChatSurface from './CliChatSurface'
import Composer from './Composer'
import type {
  ConversationAssistantGroupProps,
  ConversationTimelineRendererContract,
} from './conversation-surface-contract'
import { useActiveViewState } from './hooks/useActiveViewState'
import {
  useMobileChatViewContentClass,
  useMobileKeyboardViewportHeight,
} from './hooks/useMobileViewport'
import { useSnippetEntries } from './hooks/useSnippetEntries'
import { getInputOverlayReserveHeight } from './inputOverlayReserve'
import { syncRenderedLatexSelection } from './latex-copy'
import MessageNavigator from './MessageNavigator'
import type { MessageNavigatorAnchor } from './MessageNavigator'
import {
  getNavigatorAssistantText,
  getPromptContentText,
  normalizeNavigatorPreview,
} from './messageNavigatorUtils'
import QueryProgress from './QueryProgress'
import type { QueryProgressState } from './QueryProgress'
import { RuntimeSelector } from './RuntimeSelector'
import { TodoListPanel } from './TodoListPanel'
import { useAutoScroll } from './useAutoScroll'
import { useChatDomainActions } from './useChatDomainActions'
import { useChatHistoryWindow } from './useChatHistoryWindow'
import { useChatInputController } from './useChatInputController'
import { useChatRuntimePreferences } from './useChatRuntimePreferences'
import { useChatRuntimeSnapshot } from './useChatRuntimeSnapshot'
import { useChatStreamManager } from './useChatStreamManager'
import {
  findAssistantGroupIdForRunAnchor,
  useChatTimelineReadModel,
  useStableChatTimelineItems,
} from './useChatTimelineReadModel'
import { useCliRuntimeOrchestration } from './useCliRuntimeOrchestration'
import { useHistoricalUserMessageDismiss } from './useHistoricalUserMessageDismiss'
import UserMessageItem from './UserMessageItem'
import { useYoloChatSession } from './useYoloChatSession'
import ViewToggle from './ViewToggle'
import { YoloChatSurface } from './YoloChatSurface'

const WORKSPACE_WIDE_HEADER_MIN_WIDTH = 1200
const MESSAGE_NAVIGATOR_MIN_ANCHORS = 3
const MESSAGE_NAVIGATOR_USER_PREVIEW_MAX_LENGTH = 90
const MESSAGE_NAVIGATOR_ASSISTANT_PREVIEW_MAX_LENGTH = 180
const EMPTY_SELECTED_SKILLS: NonNullable<ChatUserInputProps['selectedSkills']> =
  []

function useLatestRef<T>(value: T) {
  const ref = useRef(value)
  ref.current = value
  return ref
}

const renderVersionObjectIds = new WeakMap<object, number>()
let nextRenderVersionObjectId = 1

function getRenderVersionObjectId(value: object | null | undefined): number {
  if (!value) {
    return 0
  }
  const existing = renderVersionObjectIds.get(value)
  if (existing !== undefined) {
    return existing
  }
  const id = nextRenderVersionObjectId
  nextRenderVersionObjectId += 1
  renderVersionObjectIds.set(value, id)
  return id
}

const shouldShowContinueResponse = (
  messages: ChatMessage[],
  isPending: boolean,
): boolean => {
  if (isPending) {
    return false
  }

  const lastMessage = messages.at(-1)
  if (lastMessage?.role !== 'tool') {
    return false
  }

  return lastMessage.toolCalls.every((toolCall) =>
    [
      ToolCallResponseStatus.Aborted,
      ToolCallResponseStatus.Rejected,
      ToolCallResponseStatus.Error,
      ToolCallResponseStatus.Success,
    ].includes(toolCall.response.status),
  )
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

const extractSelectedModelIds = (mentionables: Mentionable[]): string[] => {
  const seen = new Set<string>()
  const modelIds: string[] = []
  for (const mentionable of mentionables) {
    if (mentionable.type !== 'model' || seen.has(mentionable.modelId)) {
      continue
    }
    seen.add(mentionable.modelId)
    modelIds.push(mentionable.modelId)
  }
  return modelIds
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
  const headerRef = useRef<HTMLDivElement | null>(null)
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
  const [
    enteringCompactionDividerAnchorMessageId,
    setEnteringCompactionDividerAnchorMessageId,
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
  const currentConversationRef = useMemo<YoloConversationRef>(
    () => ({ runtimeId: 'yolo', conversationId: currentConversationId }),
    [currentConversationId],
  )
  const cancelRuntimeRun = useCallback(
    (conversationId: string) => {
      void runtimeActions.cancelRun({ runtimeId: 'yolo', conversationId })
    },
    [runtimeActions],
  )
  const resolveRuntimeActionConversation = useCallback(
    (conversationId: string): YoloConversationRef => ({
      runtimeId: 'yolo',
      conversationId,
    }),
    [],
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
  const messageReasoningMapRef = useLatestRef(messageReasoningMap)
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

  useEffect(() => {
    if (isSidebarPlacement) {
      setIsWorkspaceWideHeader(false)
      return
    }

    const element = containerRef.current
    if (!element) return

    const updateIsWideHeader = (width: number) => {
      setIsWorkspaceWideHeader(width >= WORKSPACE_WIDE_HEADER_MIN_WIDTH)
    }

    updateIsWideHeader(element.getBoundingClientRect().width)

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      updateIsWideHeader(entry.contentRect.width)
    })

    resizeObserver.observe(element)

    return () => {
      resizeObserver.disconnect()
    }
  }, [isSidebarPlacement])

  useEffect(() => {
    if (isSidebarPlacement || !isWorkspaceWideHeader) {
      setWorkspaceWideHeaderHeight(0)
      return
    }

    const element = headerRef.current
    if (!element) return

    const updateHeaderHeight = (height: number) => {
      setWorkspaceWideHeaderHeight(Math.ceil(height))
    }

    updateHeaderHeight(element.getBoundingClientRect().height)

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      updateHeaderHeight(entry.contentRect.height)
    })

    resizeObserver.observe(element)

    return () => {
      resizeObserver.disconnect()
    }
  }, [isSidebarPlacement, isWorkspaceWideHeader])

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
  const messageModelMapRef = useLatestRef(messageModelMap)
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
  const continuableErrorMessageIds = useMemo(() => {
    const ids = new Set<string>()
    for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
      const message = chatMessages[index]
      if (message.role === 'user') {
        break
      }
      if (
        message.role === 'assistant' &&
        buildAssistantErrorContinuation({
          sourceMessages: chatMessages,
          groupedChatMessages,
          assistantMessageId: message.id,
          activeBranchByUserMessageId,
        })
      ) {
        ids.add(message.id)
      }
    }
    return ids
  }, [activeBranchByUserMessageId, chatMessages, groupedChatMessages])
  const {
    windowedGroupedChatMessages,
    hasEarlierMessages,
    hasNewerMessages,
    loadEarlier,
    loadNewer,
    resetToLatest,
    jumpToUserMessage,
    windowNavigationKey,
    windowNavigationTargetMessageId,
  } = useChatHistoryWindow({
    conversationId: currentConversationId,
    groupedChatMessages,
  })
  const messageNavigatorUserPreviewCacheRef = useRef(
    new WeakMap<ChatUserMessage, { emptyLabel: string; preview: string }>(),
  )
  const messageNavigatorAssistantPreviewCacheRef = useRef(
    new WeakMap<
      AssistantToolMessageGroup,
      { activeBranchKey: string | null; preview: string }
    >(),
  )
  const messageNavigatorAnchorCacheRef = useRef<
    Map<string, MessageNavigatorAnchor>
  >(new Map())
  const messageNavigatorAnchors = useMemo<MessageNavigatorAnchor[]>(() => {
    const emptyLabel = t('chat.messageNavigator.emptyMessage', '空消息')
    const assistantTextByUserMessageId = new Map<string, string[]>()
    let precedingUserMessageId: string | null = null

    groupedChatMessages.forEach((messageOrGroup) => {
      if (!Array.isArray(messageOrGroup)) {
        precedingUserMessageId = messageOrGroup.id
        return
      }

      const sourceUserMessageId =
        getSourceUserMessageIdForGroup(messageOrGroup) ?? precedingUserMessageId
      if (!sourceUserMessageId) {
        return
      }

      const activeBranchKey =
        activeBranchByUserMessageId.get(sourceUserMessageId) ?? null
      const cachedPreview =
        messageNavigatorAssistantPreviewCacheRef.current.get(messageOrGroup)
      const assistantPreview =
        cachedPreview?.activeBranchKey === activeBranchKey
          ? cachedPreview.preview
          : normalizeNavigatorPreview(
              getNavigatorAssistantText(
                getDisplayedAssistantToolMessages(
                  messageOrGroup,
                  activeBranchKey,
                ),
              ),
              MESSAGE_NAVIGATOR_ASSISTANT_PREVIEW_MAX_LENGTH,
            )
      if (cachedPreview?.activeBranchKey !== activeBranchKey) {
        messageNavigatorAssistantPreviewCacheRef.current.set(messageOrGroup, {
          activeBranchKey,
          preview: assistantPreview,
        })
      }
      if (!assistantPreview) {
        return
      }

      const existingText = assistantTextByUserMessageId.get(sourceUserMessageId)
      if (existingText) {
        existingText.push(assistantPreview)
      } else {
        assistantTextByUserMessageId.set(sourceUserMessageId, [
          assistantPreview,
        ])
      }
    })

    let userMessageIndex = 0
    const nextAnchorCache = new Map<string, MessageNavigatorAnchor>()
    const anchors = groupedChatMessages.flatMap((messageOrGroup) => {
      if (Array.isArray(messageOrGroup)) {
        return []
      }

      userMessageIndex += 1
      const cachedUserPreview =
        messageNavigatorUserPreviewCacheRef.current.get(messageOrGroup)
      const userPreview =
        cachedUserPreview?.emptyLabel === emptyLabel
          ? cachedUserPreview.preview
          : normalizeNavigatorPreview(
              (messageOrGroup.content
                ? editorStateToPlainText(messageOrGroup.content)
                : '') || getPromptContentText(messageOrGroup.promptContent),
              MESSAGE_NAVIGATOR_USER_PREVIEW_MAX_LENGTH,
              emptyLabel,
            )
      if (cachedUserPreview?.emptyLabel !== emptyLabel) {
        messageNavigatorUserPreviewCacheRef.current.set(messageOrGroup, {
          emptyLabel,
          preview: userPreview,
        })
      }

      const assistantPreview = normalizeNavigatorPreview(
        assistantTextByUserMessageId.get(messageOrGroup.id)?.join(' ') ?? '',
        MESSAGE_NAVIGATOR_ASSISTANT_PREVIEW_MAX_LENGTH,
      )
      const previousAnchor = messageNavigatorAnchorCacheRef.current.get(
        messageOrGroup.id,
      )
      const anchor =
        previousAnchor?.index === userMessageIndex &&
        previousAnchor.userPreview === userPreview &&
        previousAnchor.assistantPreview === assistantPreview
          ? previousAnchor
          : {
              id: messageOrGroup.id,
              index: userMessageIndex,
              userPreview,
              assistantPreview,
            }
      nextAnchorCache.set(anchor.id, anchor)
      return [anchor]
    })
    messageNavigatorAnchorCacheRef.current = nextAnchorCache
    return anchors
  }, [activeBranchByUserMessageId, groupedChatMessages, t])

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
  const latestCompactionState = useMemo(
    () => getLatestChatConversationCompaction(effectiveCompactionState),
    [effectiveCompactionState],
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

  const compactionDividerAnchorMessageIds = useMemo(
    () => effectiveCompactionState.map((entry) => entry.anchorMessageId),
    [effectiveCompactionState],
  )
  const compactionDividerAnchorMessageId =
    latestCompactionState?.anchorMessageId ?? null
  const previousPendingCompactionAnchorMessageIdRef = useRef<string | null>(
    null,
  )

  useEffect(() => {
    const previousPendingAnchorMessageId =
      previousPendingCompactionAnchorMessageIdRef.current
    previousPendingCompactionAnchorMessageIdRef.current =
      pendingCompactionAnchorMessageId

    if (
      previousPendingAnchorMessageId === null ||
      pendingCompactionAnchorMessageId !== null ||
      !compactionDividerAnchorMessageId
    ) {
      return
    }

    setEnteringCompactionDividerAnchorMessageId(
      compactionDividerAnchorMessageId,
    )
    const timer = window.setTimeout(() => {
      setEnteringCompactionDividerAnchorMessageId((current) =>
        current === compactionDividerAnchorMessageId ? null : current,
      )
    }, 240)

    return () => {
      window.clearTimeout(timer)
    }
  }, [compactionDividerAnchorMessageId, pendingCompactionAnchorMessageId])

  const compactionDividerTitle = t(
    'chat.compaction.dividerTitle',
    '从这里继续当前任务',
  )
  const compactionPendingTitle = t(
    'chat.compaction.pendingTitle',
    '正在压缩上下文',
  )
  const compactionDividerDescription = (() => {
    const compactedMessageCount = latestCompactionState?.compactedMessageCount
    const estimatedTokensSaved = latestCompactionState?.estimatedTokensSaved
    if (
      typeof compactedMessageCount === 'number' &&
      compactedMessageCount > 0 &&
      typeof estimatedTokensSaved === 'number' &&
      estimatedTokensSaved > 0
    ) {
      return t(
        'chat.compaction.dividerDescriptionWithSavings',
        '{messageCount} 条消息已压缩，节省约 {tokens} tokens',
      )
        .replace('{messageCount}', String(compactedMessageCount))
        .replace('{tokens}', formatTokenCount(estimatedTokensSaved))
    }
    if (typeof latestCompactionState?.estimatedNextContextTokens === 'number') {
      return t(
        'chat.compaction.dividerDescriptionWithEstimate',
        '以上对话已压缩为摘要，下一轮总上下文约为 {count} tokens',
      ).replace(
        '{count}',
        formatTokenCount(latestCompactionState.estimatedNextContextTokens),
      )
    }
    return t(
      'chat.compaction.dividerDescription',
      '以上对话已压缩为摘要，以下回复基于摘要继续',
    )
  })()
  const compactionPendingDescription = t(
    'chat.compaction.pendingStatus',
    '正在整理上下文，稍后将从新的上下文继续。',
  )

  const displayMentionablesForInput = inputMessage.mentionables

  const currentFileOverride = resolveAssistantIncludeCurrentFileContent(
    selectedAssistant,
    settings,
  )
    ? activeFile
    : null

  const chatMessagesRef = useRef<HTMLDivElement>(null)
  const [chatMessagesElement, setChatMessagesElement] =
    useState<HTMLElement | null>(null)
  const [chatBottomSentinelElement, setChatBottomSentinelElement] =
    useState<HTMLElement | null>(null)
  // Callback-ref + state for the overlay element. A plain useRef with a
  // mount-once effect would lose its observation when the chat view unmounts
  // (e.g. switching to the composer view and back), since the new overlay
  // element never re-binds. Driving the measurement effect off element state
  // ensures attach/detach cleanly drive observer setup/teardown.
  const [inputOverlayElement, setInputOverlayElement] =
    useState<HTMLDivElement | null>(null)
  const [inputOverlayHeight, setInputOverlayHeight] = useState(0)
  const [navigatorViewport, setNavigatorViewport] = useState<{
    activeMessageId: string | null
    visibleMessageIds: string[]
  }>({ activeMessageId: null, visibleMessageIds: [] })
  const latexSelectionSyncFrameRef = useRef<number | null>(null)
  const chatSurfacePreset = getChatSurfacePreset('chat')
  const hasStreamingMessages = useMemo(
    () =>
      chatMessages.some(
        (message) =>
          message.role === 'assistant' &&
          message.metadata?.generationState === 'streaming',
      ),
    [chatMessages],
  )

  const {
    autoScrollToBottom,
    forceScrollToBottom,
    stopAutoFollow,
    isAutoFollowEnabled,
  } = useAutoScroll({
    scrollContainerRef: chatMessagesRef,
    scrollContainerElement: chatMessagesElement,
    bottomSentinelElement: chatBottomSentinelElement,
    followKey: currentConversationId,
    canFollowLiveEdge: !hasNewerMessages,
  })
  useLayoutEffect(() => {
    autoScrollToBottom()
  }, [autoScrollToBottom, chatMessages])
  const handleForceScrollToBottom = useCallback(() => {
    resetToLatest()
    requestAnimationFrame(() => {
      forceScrollToBottom()
    })
  }, [forceScrollToBottom, resetToLatest])
  const handleNavigateToUserMessage = useCallback(
    (messageId: string) => {
      setNavigatorViewport((currentViewport) => ({
        ...currentViewport,
        activeMessageId: messageId,
      }))
      stopAutoFollow()
      jumpToUserMessage(messageId)
    },
    [jumpToUserMessage, stopAutoFollow],
  )

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
    autoScrollToBottom,
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
    forceScrollToBottom,
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

  const {
    onControlPopoverOpenChange: onHistoricalUserMessageControlPopoverOpenChange,
  } = useHistoricalUserMessageDismiss({
    activeMessageId:
      focusedMessageId && focusedMessageId !== inputMessage.id
        ? focusedMessageId
        : null,
    containerRef: chatMessagesRef,
    onDismiss: dismissHistoricalUserMessage,
  })

  const shouldHidePendingAssistantPlaceholders = useMemo(() => {
    if (!isCurrentConversationRunActive) {
      return false
    }

    let lastUserIndex = -1
    for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
      if (chatMessages[index].role === 'user') {
        lastUserIndex = index
        break
      }
    }

    if (lastUserIndex === -1) {
      return false
    }

    return chatMessages
      .slice(lastUserIndex + 1)
      .some((message) => message.role === 'tool')
  }, [chatMessages, isCurrentConversationRunActive])
  const activeStreamingMessageId = useMemo(() => {
    for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
      const message = chatMessages[index]
      if (
        message.role === 'assistant' &&
        message.metadata?.generationState === 'streaming'
      ) {
        return message.id
      }
    }

    return null
  }, [chatMessages])
  const showContinueResponseButton = useMemo(() => {
    return shouldShowContinueResponse(
      chatMessages,
      isCurrentConversationRunActive,
    )
  }, [chatMessages, isCurrentConversationRunActive])
  const chatTimelineItems: ChatTimelineItem[] = useMemo(
    () =>
      buildChatTimelineItems({
        groupedChatMessages: windowedGroupedChatMessages,
        revisionsById: chatTimelineReadModel.revisionsById,
        assistantGroupBoundaryMessageIds,
        compactionDividerAnchorMessageIds,
        latestCompaction: latestCompactionState,
        pendingCompactionAnchorMessageId,
        queryProgress,
        showContinueResponseButton,
        activeEditableMessageId:
          focusedMessageId && focusedMessageId !== inputMessage.id
            ? focusedMessageId
            : null,
        activeEditingAssistantMessageId: editingAssistantMessageId,
        activeStreamingMessageId,
      }),
    [
      editingAssistantMessageId,
      activeStreamingMessageId,
      assistantGroupBoundaryMessageIds,
      chatTimelineReadModel.revisionsById,
      compactionDividerAnchorMessageIds,
      focusedMessageId,
      inputMessage.id,
      latestCompactionState,
      pendingCompactionAnchorMessageId,
      queryProgress,
      showContinueResponseButton,
      windowedGroupedChatMessages,
    ],
  )
  const stableChatTimelineItems = useStableChatTimelineItems(chatTimelineItems)

  const windowedToolCallIds = useMemo(
    () => collectToolCallIdsFromGroupedMessages(windowedGroupedChatMessages),
    [windowedGroupedChatMessages],
  )
  const terminalCommandResultsByToolCallIdRef = useRef<ReadonlyMap<
    string,
    ChatTerminalCommandResultMessage
  > | null>(null)
  const subagentResultsByToolCallIdRef = useRef<ReadonlyMap<
    string,
    ChatSubagentResultMessage
  > | null>(null)
  const terminalCommandResultsByToolCallId = useMemo(() => {
    const next = buildTerminalCommandResultMap(
      chatMessages,
      windowedToolCallIds,
    )
    const stable = terminalCommandResultsByToolCallIdRef.current
      ? reuseShallowEqualMap(
          terminalCommandResultsByToolCallIdRef.current,
          next,
        )
      : next
    terminalCommandResultsByToolCallIdRef.current = stable
    return stable
  }, [chatMessages, windowedToolCallIds])
  const subagentResultsByToolCallId = useMemo(() => {
    const next = buildSubagentResultMap(chatMessages, windowedToolCallIds)
    const stable = subagentResultsByToolCallIdRef.current
      ? reuseShallowEqualMap(subagentResultsByToolCallIdRef.current, next)
      : next
    subagentResultsByToolCallIdRef.current = stable
    return stable
  }, [chatMessages, windowedToolCallIds])
  useEffect(() => {
    const chatMessagesElement = chatMessagesRef.current
    if (!chatMessagesElement) {
      return
    }

    let didSelectionTouchChat = false

    const syncLatexSelectionInView = () => {
      latexSelectionSyncFrameRef.current = null

      const selection = (
        chatMessagesElement.ownerDocument.defaultView ?? window
      ).getSelection()
      const selectionRoot =
        selection?.rangeCount && !selection.isCollapsed
          ? selection.getRangeAt(0).commonAncestorContainer
          : null
      const selectionTouchesChat = selectionRoot
        ? chatMessagesElement.contains(selectionRoot)
        : false

      if (!selectionTouchesChat && !didSelectionTouchChat) {
        return
      }

      didSelectionTouchChat = selectionTouchesChat

      chatMessagesElement
        .querySelectorAll<HTMLElement>('.yolo-markdown-rendered')
        .forEach((containerEl) => {
          syncRenderedLatexSelection(containerEl)
        })
    }

    const scheduleLatexSelectionSync = () => {
      if (latexSelectionSyncFrameRef.current !== null) {
        return
      }

      latexSelectionSyncFrameRef.current = requestAnimationFrame(() => {
        syncLatexSelectionInView()
      })
    }

    const doc = chatMessagesElement.ownerDocument
    doc.addEventListener('selectionchange', scheduleLatexSelectionSync)
    doc.addEventListener('mouseup', scheduleLatexSelectionSync)
    doc.addEventListener('keyup', scheduleLatexSelectionSync)

    return () => {
      doc.removeEventListener('selectionchange', scheduleLatexSelectionSync)
      doc.removeEventListener('mouseup', scheduleLatexSelectionSync)
      doc.removeEventListener('keyup', scheduleLatexSelectionSync)
      if (latexSelectionSyncFrameRef.current !== null) {
        cancelAnimationFrame(latexSelectionSyncFrameRef.current)
        latexSelectionSyncFrameRef.current = null
      }
    }
  }, [])

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
    <div
      ref={headerRef}
      className={`yolo-chat-header${
        isSidebarPlacement ? '' : ' yolo-chat-header--workspace'
      }`}
    >
      <div className="yolo-chat-header-left">
        {onChangeView ? (
          <ViewToggle
            activeView={activeView}
            onChangeView={onChangeView}
            activeChatSurface={activeRuntimeId === 'yolo' ? 'chat' : 'cli'}
            onChangeChatSurface={(surface) => {
              handleRuntimeChange(
                surface === 'chat' ? 'yolo' : lastCliRuntimeIdRef.current,
              )
            }}
            showCliMode={cliRuntimeAvailable && cliRuntimeScope !== undefined}
            showComposer={isSidebarPlacement}
          />
        ) : (
          <h1 className="yolo-chat-header-title">
            {t('sidebar.tabs.chat', 'Chat')}
          </h1>
        )}
        {activeView === 'chat' && activeRuntimeId !== 'yolo' ? (
          <RuntimeSelector
            currentRuntimeId={activeRuntimeId}
            onRuntimeChange={handleRuntimeChange}
          />
        ) : null}
      </div>
      {activeView === 'chat' && (
        <div className="yolo-chat-header-right">
          {activeRuntimeId === 'yolo' ? (
            <AssistantSelector
              currentAssistantId={conversationAssistantId}
              triggerClassName={
                !isSidebarPlacement && isWorkspaceWideHeader
                  ? 'yolo-assistant-selector-button--workspace-floating'
                  : undefined
              }
              contentClassName={
                !isSidebarPlacement && isWorkspaceWideHeader
                  ? 'yolo-assistant-selector-content--workspace-floating'
                  : undefined
              }
              onAssistantChange={(assistant) => {
                handleConversationAssistantSelect(assistant.id)
              }}
            />
          ) : null}
          <div className="yolo-chat-header-buttons">
            <button
              type="button"
              onClick={() => handleNewChat()}
              className="clickable-icon"
              aria-label="New Chat"
            >
              <Plus size={18} />
            </button>
            {activeRuntimeId === 'yolo' ? (
              <button
                type="button"
                onClick={() => handleExportChatToVault(currentConversationId)}
                className="clickable-icon"
                aria-label={t(
                  'sidebar.chatList.exportConversation',
                  'Export conversation to vault',
                )}
              >
                <Download size={18} />
              </button>
            ) : null}
            <ChatListDropdown
              chatList={chatList}
              currentConversationId={activeHistoryConversationId}
              runSummariesByConversationId={runSummariesByConversationId}
              onSelect={(conversationId) => {
                if (conversationId === activeHistoryConversationId) return
                void handleLoadConversation(conversationId)
              }}
              onDelete={(conversationId) => {
                void (async () => {
                  const conversation = await getConversationById(conversationId)
                  await deleteConversation(conversationId)
                  if (conversation?.cliSession && cliRuntimeScope) {
                    await cliRuntimeScope.sessionService.removeOverlay(
                      conversation.cliSession,
                    )
                  }
                  if (conversationId === activeHistoryConversationId) {
                    if (activeRuntimeId !== 'yolo') {
                      handleNewChat()
                      return
                    }
                    const nextConversation = chatList.find(
                      (chat) => chat.id !== conversationId,
                    )
                    if (nextConversation) {
                      void handleLoadConversation(nextConversation.id)
                    } else {
                      handleNewChat()
                    }
                  }
                })()
              }}
              onUpdateTitle={async (conversationId, newTitle) => {
                await updateConversationTitle(conversationId, newTitle)
                syncCliConversationTitle(conversationId, newTitle)
              }}
              onTogglePinned={(conversationId) => {
                void toggleConversationPinned(conversationId)
              }}
              onRetryTitle={async (conversationId) => {
                const conversation = await getConversationById(conversationId)
                if (!conversation) {
                  console.error(
                    'Failed to retry conversation title generation: conversation not found',
                    {
                      conversationId,
                    },
                  )
                  return
                }
                const title = await generateConversationTitle(
                  conversationId,
                  conversation.messages,
                  {
                    force: true,
                  },
                )
                if (title) syncCliConversationTitle(conversationId, title)
              }}
              onExportConversation={handleExportChatToVault}
            >
              <History size={18} />
            </ChatListDropdown>
          </div>
        </div>
      )}
    </div>
  )

  const conversationModelIdValueRef = useLatestRef(conversationModelId)
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
  const mainInputSelectedSkills =
    inputMessage.selectedSkills ?? EMPTY_SELECTED_SKILLS

  const handleAssistantGroupEditStart = useCallback((messageId: string) => {
    setEditingAssistantMessageId(messageId)
  }, [])

  const handleAssistantGroupActiveBranchChange = useCallback(
    (sourceUserMessageId: string, branchKey: string | null) => {
      const next = new Map(activeBranchByUserMessageIdRef.current)
      if (!branchKey) {
        next.delete(sourceUserMessageId)
      } else {
        next.set(sourceUserMessageId, branchKey)
      }
      activeBranchByUserMessageIdRef.current = next
      setActiveBranchByUserMessageId(next)
      void persistConversation(chatMessagesStateRef.current)
    },
    [persistConversation],
  )

  const timelineHandlersRef = useLatestRef({
    finalizeHistoricalUserMessageEdit,
    handleApply,
    handleAssistantGroupActiveBranchChange,
    handleAssistantGroupEditStart,
    handleAssistantErrorContinue,
    handleAssistantMessageEditCancel,
    handleAssistantMessageEditSave,
    handleAssistantMessageGroupBranch,
    handleAssistantMessageGroupDelete,
    handleAssistantMessageGroupRetry,
    handleChatModeChange,
    handleContinueResponse,
    handleHistoricalUserMessageDelete,
    handleOpenEditSummaryFile,
    handleDeleteAssistantQuote,
    handleQuoteAssistantSelection,
    handleRecoverAnswerUserQuestion,
    handleRecoverPendingToolCall,
    handleToolCallResponseUpdate,
    handleToolMessageUpdate,
    handleUndoEditSummary,
    handleUserMessageSubmit,
    updateHistoricalUserMessage,
  })

  const runSummaryAssistantGroupId = useMemo(
    () =>
      findAssistantGroupIdForRunAnchor({
        groupedChatMessages,
        anchorMessageId: currentConversationRunSummary.anchorMessageId,
      }),
    [currentConversationRunSummary.anchorMessageId, groupedChatMessages],
  )

  // 后台任务结果在渲染上会接回对应 tool card，且 subagent/terminal result
  // standalone group 会被 timeline 过滤掉；因此必须在过滤前的 grouped
  // messages 上决定“视觉回合”的 footer 归属。
  const foregroundAgentVisualTurnPlan = useMemo(
    () => buildForegroundAgentVisualTurnPlan(groupedChatMessages),
    [groupedChatMessages],
  )

  const buildYoloAssistantGroupProps = useCallback(
    (
      messageOrGroup: AssistantToolMessageGroup,
      timelineItem: ChatTimelineAssistantGroupItem,
    ): ConversationAssistantGroupProps => {
      const sourceUserMessageId = getSourceUserMessageIdForGroup(messageOrGroup)
      const foregroundAgentFooter = getForegroundAgentFooterForGroup(
        foregroundAgentVisualTurnPlan,
        messageOrGroup,
      )
      const containsCompactionAnchor =
        compactionDividerAnchorMessageId !== null &&
        messageOrGroup.some(
          (message) => message.id === compactionDividerAnchorMessageId,
        )
      const shouldSuppressCompactionAnchorFooter =
        containsCompactionAnchor &&
        Boolean(latestCompactionState?.triggerToolCallId)

      return {
        conversationId: currentConversationId,
        conversationRunSummary:
          timelineItem.groupId === runSummaryAssistantGroupId
            ? currentConversationRunSummary
            : undefined,
        activeBranchKey: activeBranchByUserMessageId.get(
          sourceUserMessageId ?? '',
        ),
        sourceUserMessageId,
        continuableErrorMessageIds,
        suppressFooter:
          shouldSuppressCompactionAnchorFooter ||
          foregroundAgentFooter?.suppress === true,
        inlineInfoMessages:
          foregroundAgentFooter?.inlineInfoMessages ?? messageOrGroup,
        isApplying: applyMutation.isPending,
        activeApplyRequestKey,
        onApply: (...args) => timelineHandlersRef.current.handleApply(...args),
        onToolMessageUpdate: (...args) =>
          timelineHandlersRef.current.handleToolMessageUpdate(...args),
        onToolCallResponseUpdate: (...args) =>
          timelineHandlersRef.current.handleToolCallResponseUpdate(...args),
        terminalCommandResultsByToolCallId,
        subagentResultsByToolCallId,
        onRecoverToolCall: (...args) =>
          timelineHandlersRef.current.handleRecoverPendingToolCall(...args),
        onRecoverAnswerUserQuestion: (...args) =>
          timelineHandlersRef.current.handleRecoverAnswerUserQuestion(...args),
        editingAssistantMessageId,
        onEditStart: (...args) =>
          timelineHandlersRef.current.handleAssistantGroupEditStart(...args),
        onEditCancel: (...args) =>
          timelineHandlersRef.current.handleAssistantMessageEditCancel(...args),
        onEditSave: (...args) =>
          timelineHandlersRef.current.handleAssistantMessageEditSave(...args),
        onDeleteGroup: (...args) =>
          timelineHandlersRef.current.handleAssistantMessageGroupDelete(
            ...args,
          ),
        onRetryGroup: (...args) =>
          timelineHandlersRef.current.handleAssistantMessageGroupRetry(...args),
        onContinueError: (...args) =>
          timelineHandlersRef.current.handleAssistantErrorContinue(...args),
        onBranchGroup: (...args) =>
          timelineHandlersRef.current.handleAssistantMessageGroupBranch(
            ...args,
          ),
        onActiveBranchChange: (...args) =>
          timelineHandlersRef.current.handleAssistantGroupActiveBranchChange(
            ...args,
          ),
        onQuoteAssistantSelection: (...args) =>
          timelineHandlersRef.current.handleQuoteAssistantSelection(...args),
        assistantQuotes: activeAssistantQuotes,
        onDeleteAssistantQuote: (...args) =>
          timelineHandlersRef.current.handleDeleteAssistantQuote(...args),
        onOpenEditSummaryFile: (...args) =>
          timelineHandlersRef.current.handleOpenEditSummaryFile(...args),
        onUndoEditSummary: (...args) =>
          timelineHandlersRef.current.handleUndoEditSummary(...args),
        undoingEditSummaryTarget,
        pendingCompactionAnchorMessageId,
        hidePendingAssistantPlaceholders:
          shouldHidePendingAssistantPlaceholders,
      }
    },
    [
      activeApplyRequestKey,
      activeAssistantQuotes,
      activeBranchByUserMessageId,
      applyMutation.isPending,
      compactionDividerAnchorMessageId,
      continuableErrorMessageIds,
      currentConversationId,
      currentConversationRunSummary,
      editingAssistantMessageId,
      foregroundAgentVisualTurnPlan,
      latestCompactionState?.triggerToolCallId,
      pendingCompactionAnchorMessageId,
      runSummaryAssistantGroupId,
      shouldHidePendingAssistantPlaceholders,
      subagentResultsByToolCallId,
      terminalCommandResultsByToolCallId,
      undoingEditSummaryTarget,
    ],
  )

  const renderYoloUserMessage = useCallback(
    (message: ChatUserMessage) => {
      const messageReasoningLevel =
        messageReasoningMap.get(message.id) ??
        normalizeReasoningLevel(message.reasoningLevel) ??
        reasoningLevel

      return (
        <UserMessageItem
          message={message}
          isFocused={focusedMessageId === message.id}
          isActionDisabled={isCurrentConversationRunActive}
          onDelete={() => {
            timelineHandlersRef.current.handleHistoricalUserMessageDelete(
              message.id,
            )
          }}
          displayMentionables={message.mentionables}
          chatUserInputRef={(ref) => registerChatUserInputRef(message.id, ref)}
          onControlPopoverOpenChange={(isOpen) => {
            onHistoricalUserMessageControlPopoverOpenChange(isOpen)
          }}
          onInputChange={(content) => {
            timelineHandlersRef.current.updateHistoricalUserMessage(
              message.id,
              (message) => ({
                ...message,
                content,
                promptContent: null,
              }),
            )
          }}
          onSubmit={(content) => {
            if (
              editorStateToPlainText(content).trim() === '' &&
              message.mentionables.length === 0 &&
              (message.selectedSkills?.length ?? 0) === 0
            ) {
              timelineHandlersRef.current.finalizeHistoricalUserMessageEdit(
                message.id,
              )
              chatUserInputRefs.current.get(inputMessage.id)?.focus()
              return
            }
            const latestGroupedChatMessages = groupedChatMessagesRef.current
            const latestGroupedMessageIndex =
              latestGroupedChatMessages.findIndex(
                (candidate) =>
                  !Array.isArray(candidate) && candidate.id === message.id,
              )
            if (latestGroupedMessageIndex < 0) {
              return
            }
            const currentConversationModelId =
              conversationModelIdValueRef.current
            const modelForThisMessage =
              messageModelMapRef.current.get(message.id) ??
              currentConversationModelId
            const reasoningForThisMessage =
              messageReasoningMapRef.current.get(message.id) ??
              messageReasoningLevel
            const nextMessageModelMap = new Map(messageModelMapRef.current)
            nextMessageModelMap.set(message.id, modelForThisMessage)
            // 历史编辑后重新提交是一个新的用户回合 → 打上新的当前时间。
            const editedUserMessage: ChatUserMessage =
              stampUserMessageTimeContext(
                {
                  role: 'user',
                  content,
                  promptContent: null,
                  id: message.id,
                  reasoningLevel: reasoningForThisMessage,
                  mentionables: message.mentionables,
                  selectedSkills: message.selectedSkills ?? [],
                  selectedModelIds: extractSelectedModelIds(
                    message.mentionables,
                  ),
                },
                selectedAssistantTimeContextEnabled,
              )
            const inputChatMessages = [
              ...latestGroupedChatMessages
                .slice(0, latestGroupedMessageIndex)
                .flatMap((candidate): ChatMessage[] =>
                  !Array.isArray(candidate) ? [candidate] : candidate,
                ),
              editedUserMessage,
            ]
            const requestChatMessages = [
              ...latestGroupedChatMessages
                .slice(0, latestGroupedMessageIndex)
                .flatMap((candidate): ChatMessage[] =>
                  !Array.isArray(candidate)
                    ? [candidate]
                    : getDisplayedAssistantToolMessages(
                        candidate,
                        activeBranchByUserMessageIdRef.current.get(
                          getSourceUserMessageIdForGroup(candidate) ?? '',
                        ),
                      ),
                ),
              editedUserMessage,
            ]
            void timelineHandlersRef.current.handleUserMessageSubmit({
              inputChatMessages,
              requestChatMessages,
              persistedMessageModelMap: nextMessageModelMap,
            })
            chatUserInputRefs.current.get(inputMessage.id)?.focus()
            setMessageModelMap(nextMessageModelMap)
            setMessageReasoningMap((prev) => {
              const next = new Map(prev)
              next.set(message.id, reasoningForThisMessage)
              return next
            })
          }}
          onFocus={() => {
            setFocusedMessageId(message.id)
          }}
          onMentionablesChange={(mentionables) => {
            const currentMessage = chatMessagesStateRef.current.find(
              (candidate): candidate is ChatUserMessage =>
                candidate.role === 'user' && candidate.id === message.id,
            )
            if (currentMessage) {
              releaseHighlightIds(
                collectRemovedSelectionHighlightIds(
                  currentMessage.mentionables,
                  mentionables,
                ),
              )
            }
            timelineHandlersRef.current.updateHistoricalUserMessage(
              message.id,
              (message) => {
                const prevKeys = message.mentionables.map((m) =>
                  getMentionableKey(serializeMentionable(m)),
                )
                const nextKeys = mentionables.map((m) =>
                  getMentionableKey(serializeMentionable(m)),
                )
                const nextKeySet = new Set(nextKeys)
                const isSameMentionables =
                  prevKeys.length === nextKeys.length &&
                  prevKeys.every((key) => nextKeySet.has(key))

                return {
                  ...message,
                  mentionables,
                  promptContent: isSameMentionables
                    ? message.promptContent
                    : null,
                }
              },
            )
          }}
          onSelectedSkillsChange={(selectedSkills) => {
            timelineHandlersRef.current.updateHistoricalUserMessage(
              message.id,
              (message) => ({
                ...message,
                selectedSkills,
                promptContent: null,
                snapshotRef: undefined,
              }),
            )
          }}
          modelId={messageModelMap.get(message.id) ?? conversationModelId}
          onModelChange={(id) => {
            setMessageModelMap((prev) => {
              const next = new Map(prev)
              next.set(message.id, id)
              return next
            })
            setConversationModelId(id)
            conversationModelIdRef.current.set(currentConversationId, id)
            const nextReasoningLevel = getReasoningLevelForModelId(id)
            setReasoningLevel(nextReasoningLevel)
            conversationReasoningLevelRef.current.set(
              currentConversationId,
              nextReasoningLevel,
            )
            setInputMessage((prev) => ({
              ...prev,
              reasoningLevel: nextReasoningLevel,
            }))
          }}
          reasoningLevel={messageReasoningLevel}
          onReasoningChange={(level) => {
            setMessageReasoningMap((prev) => {
              const next = new Map(prev)
              next.set(message.id, level)
              return next
            })
            setChatMessages((prevChatHistory) =>
              prevChatHistory.map((msg) =>
                msg.role === 'user' && msg.id === message.id
                  ? {
                      ...msg,
                      reasoningLevel: level,
                    }
                  : msg,
              ),
            )
            setReasoningLevel(level)
            conversationReasoningLevelRef.current.set(
              currentConversationId,
              level,
            )
            void persistReasoningLevelForModel(
              conversationModelIdValueRef.current,
              level,
            )
          }}
          currentAssistantId={conversationAssistantId}
          currentChatMode={chatMode}
          onSelectChatModeForConversation={(...args) =>
            timelineHandlersRef.current.handleChatModeChange(...args)
          }
          showReasoningSelect={
            chatSurfacePreset.userMessage.showReasoningSelect
          }
          allowAgentModeOption={
            chatSurfacePreset.userMessage.allowAgentModeOption
          }
        />
      )
    },
    [
      chatSurfacePreset,
      chatMode,
      conversationAssistantId,
      conversationModelId,
      currentConversationId,
      focusedMessageId,
      getReasoningLevelForModelId,
      inputMessage.id,
      isCurrentConversationRunActive,
      messageModelMap,
      messageReasoningMap,
      onHistoricalUserMessageControlPopoverOpenChange,
      persistReasoningLevelForModel,
      reasoningLevel,
      registerChatUserInputRef,
      releaseHighlightIds,
      selectedAssistantTimeContextEnabled,
    ],
  )

  const renderYoloQueryProgress = useCallback(
    () => <QueryProgress state={queryProgress} />,
    [queryProgress],
  )

  const renderYoloContinueResponse = useCallback(
    () => (
      <div className="yolo-continue-response-button-container">
        <button
          type="button"
          className="yolo-continue-response-button"
          onClick={handleContinueResponse}
        >
          <div>Continue response</div>
        </button>
      </div>
    ),
    [handleContinueResponse],
  )

  const yoloTimelineRendererContract =
    useMemo<ConversationTimelineRendererContract>(
      () => ({
        messagesById: chatTimelineReadModel.messagesById,
        preset: chatSurfacePreset,
        compaction: {
          pendingTitle: compactionPendingTitle,
          pendingDescription: compactionPendingDescription,
          dividerTitle: compactionDividerTitle,
          dividerDescription: compactionDividerDescription,
          isDividerEntering: (item) =>
            item.renderKey ===
            `${enteringCompactionDividerAnchorMessageId}-compact-divider`,
        },
        renderUserMessage: renderYoloUserMessage,
        getAssistantGroupProps: buildYoloAssistantGroupProps,
        wrapAssistantGroup: (content) => (
          <ChatRuntimeActionsProvider
            actions={runtimeActions}
            conversation={currentConversationRef}
            resolveConversationScope={resolveRuntimeActionConversation}
          >
            {content}
          </ChatRuntimeActionsProvider>
        ),
        renderQueryProgress: renderYoloQueryProgress,
        renderContinueResponse: renderYoloContinueResponse,
        bottomAnchorClassName: 'yolo-chat-bottom-anchor',
      }),
      [
        chatSurfacePreset,
        chatTimelineReadModel.messagesById,
        compactionDividerDescription,
        compactionDividerTitle,
        compactionPendingDescription,
        compactionPendingTitle,
        currentConversationRef,
        enteringCompactionDividerAnchorMessageId,
        buildYoloAssistantGroupProps,
        renderYoloContinueResponse,
        renderYoloQueryProgress,
        renderYoloUserMessage,
        resolveRuntimeActionConversation,
        runtimeActions,
      ],
    )

  const chatTimelineRenderVersion = useCallback(
    (timelineItem: ChatTimelineItem): string => {
      if (timelineItem.kind === 'compaction-pending') {
        return [
          timelineItem.renderKey,
          compactionPendingTitle,
          compactionPendingDescription,
        ].join('|')
      }

      if (timelineItem.kind === 'compaction-divider') {
        return [
          timelineItem.renderKey,
          compactionDividerTitle,
          compactionDividerDescription,
          timelineItem.renderKey ===
            `${enteringCompactionDividerAnchorMessageId}-compact-divider`,
        ].join('|')
      }

      if (timelineItem.kind === 'assistant-group') {
        const messages = timelineItem.messageIds
          .map((messageId) => chatTimelineReadModel.messagesById.get(messageId))
          .filter(
            (message): message is AssistantToolMessageGroup[number] =>
              message !== undefined && message.role !== 'user',
          )
        const sourceUserMessageId = getSourceUserMessageIdForGroup(messages)
        const foregroundAgentFooter = getForegroundAgentFooterForGroup(
          foregroundAgentVisualTurnPlan,
          messages,
        )
        const containsCompactionAnchor =
          compactionDividerAnchorMessageId !== null &&
          timelineItem.messageIds.includes(compactionDividerAnchorMessageId)
        const shouldSuppressCompactionAnchorFooter =
          containsCompactionAnchor &&
          Boolean(latestCompactionState?.triggerToolCallId)
        const isRunSummaryGroup =
          timelineItem.groupId === runSummaryAssistantGroupId
        const isEditingGroup =
          editingAssistantMessageId !== null &&
          timelineItem.messageIds.includes(editingAssistantMessageId)

        return [
          'assistant',
          timelineItem.revision,
          currentConversationId,
          activeBranchByUserMessageId.get(sourceUserMessageId ?? '') ?? '',
          foregroundAgentFooter?.suppress === true,
          getRenderVersionObjectId(foregroundAgentFooter?.inlineInfoMessages),
          shouldSuppressCompactionAnchorFooter,
          chatSurfacePreset.assistantActions.showInlineInfo,
          chatSurfacePreset.assistantActions.showRetryAction,
          chatSurfacePreset.assistantActions.showInsertAction,
          chatSurfacePreset.assistantActions.showCopyAction,
          chatSurfacePreset.assistantActions.showBranchAction,
          chatSurfacePreset.assistantActions.showEditAction,
          chatSurfacePreset.assistantActions.showDeleteAction,
          chatSurfacePreset.assistantActions.showQuoteAction,
          activeAssistantQuotes
            .filter((quote) =>
              timelineItem.messageIds.includes(quote.messageId),
            )
            .map(
              (quote) =>
                `${quote.id ?? ''}:${quote.selector?.start ?? ''}:${quote.selector?.end ?? ''}:${quote.comment ?? ''}`,
            )
            .join(','),
          applyMutation.isPending,
          activeApplyRequestKey ?? '',
          getRenderVersionObjectId(terminalCommandResultsByToolCallId),
          getRenderVersionObjectId(subagentResultsByToolCallId),
          isEditingGroup ? editingAssistantMessageId : '',
          pendingCompactionAnchorMessageId ?? '',
          shouldHidePendingAssistantPlaceholders,
          undoingEditSummaryTarget ?? '',
          isRunSummaryGroup,
          isRunSummaryGroup ? currentConversationRunSummary.status : '',
          isRunSummaryGroup ? currentConversationRunSummary.isRunning : '',
          isRunSummaryGroup
            ? currentConversationRunSummary.isWaitingApproval
            : '',
          isRunSummaryGroup
            ? currentConversationRunSummary.isWaitingUserInput
            : '',
          isRunSummaryGroup ? currentConversationRunSummary.isAbortable : '',
        ].join('|')
      }

      if (timelineItem.kind === 'user-message') {
        const message = chatTimelineReadModel.messagesById.get(
          timelineItem.messageId,
        )
        const reasoning =
          message?.role === 'user'
            ? (messageReasoningMap.get(message.id) ??
              normalizeReasoningLevel(message.reasoningLevel) ??
              reasoningLevel)
            : reasoningLevel

        return [
          'user',
          timelineItem.revision,
          focusedMessageId === timelineItem.messageId,
          isCurrentConversationRunActive,
          messageModelMap.get(timelineItem.messageId) ?? conversationModelId,
          reasoning,
          conversationAssistantId,
          selectedAssistantTimeContextEnabled,
          chatMode,
          chatSurfacePreset.userMessage.showReasoningSelect,
          chatSurfacePreset.userMessage.allowAgentModeOption,
        ].join('|')
      }

      if (timelineItem.kind === 'query-progress') {
        return `query|${getRenderVersionObjectId(queryProgress ?? null)}`
      }

      if (timelineItem.kind === 'continue-response') {
        return `continue|${isCurrentConversationRunActive}`
      }

      return timelineItem.renderKey
    },
    [
      activeAssistantQuotes,
      activeApplyRequestKey,
      activeBranchByUserMessageId,
      applyMutation.isPending,
      chatMode,
      chatSurfacePreset,
      chatTimelineReadModel.messagesById,
      compactionDividerAnchorMessageId,
      compactionDividerDescription,
      compactionDividerTitle,
      compactionPendingDescription,
      compactionPendingTitle,
      conversationAssistantId,
      conversationModelId,
      currentConversationId,
      currentConversationRunSummary,
      editingAssistantMessageId,
      enteringCompactionDividerAnchorMessageId,
      focusedMessageId,
      foregroundAgentVisualTurnPlan,
      isCurrentConversationRunActive,
      runSummaryAssistantGroupId,
      latestCompactionState?.triggerToolCallId,
      messageModelMap,
      messageReasoningMap,
      pendingCompactionAnchorMessageId,
      queryProgress,
      reasoningLevel,
      selectedAssistantTimeContextEnabled,
      shouldHidePendingAssistantPlaceholders,
      subagentResultsByToolCallId,
      terminalCommandResultsByToolCallId,
      undoingEditSummaryTarget,
    ],
  )

  const getMessageNavigatorItemLabel = useCallback(
    (index: number, label: string) =>
      t(
        'chat.messageNavigator.itemAriaLabel',
        '跳转到第 {index} 条消息：{label}',
      )
        .replace('{index}', String(index))
        .replace('{label}', label),
    [t],
  )
  const messageNavigatorContent =
    messageNavigatorAnchors.length >= MESSAGE_NAVIGATOR_MIN_ANCHORS ? (
      <MessageNavigator
        anchors={messageNavigatorAnchors}
        activeMessageId={navigatorViewport.activeMessageId}
        visibleMessageIds={navigatorViewport.visibleMessageIds}
        itemLabel={getMessageNavigatorItemLabel}
        onSelect={handleNavigateToUserMessage}
      />
    ) : undefined
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
          groupedChatMessagesLength={groupedChatMessages.length}
          isAutoFollowEnabled={isAutoFollowEnabled}
          currentConversationId={currentConversationId}
          chatTimelineItems={stableChatTimelineItems}
          timelineRenderVersion={chatTimelineRenderVersion}
          chatMessagesRef={chatMessagesRef}
          onScrollContainerChange={setChatMessagesElement}
          onBottomSentinelChange={setChatBottomSentinelElement}
          timelineRendererContract={yoloTimelineRendererContract}
          editingAssistantMessageId={editingAssistantMessageId}
          hasEarlierMessages={hasEarlierMessages}
          hasNewerMessages={hasNewerMessages}
          onLoadEarlier={loadEarlier}
          onLoadNewer={loadNewer}
          onForceScrollToBottom={handleForceScrollToBottom}
          hasStreamingMessages={hasStreamingMessages}
          scrollToBottomLabel={t('chat.scrollToBottom', '回到底部')}
          scrollToBottomWhileStreamingLabel={t(
            'chat.scrollToBottomWhileStreaming',
            '回到底部继续跟随',
          )}
          emptyStateAskTitle={t('chat.emptyState.askTitle', '先想清楚，再落笔')}
          emptyStateAgentTitle={t('chat.emptyState.agentTitle', '让 AI 去执行')}
          emptyStateAgentFullTitle={t(
            'chat.emptyState.agentFullTitle',
            '让 AI 自主执行 · YOLO 模式',
          )}
          emptyStateWorkspaceTitle={workspaceEmptyStateTitle}
          emptyStateAskDescription={t(
            'chat.emptyState.askDescription',
            '适合提问、润色与改写，专注表达本身',
          )}
          emptyStateAgentDescription={t(
            'chat.emptyState.agentDescription',
            '启用工具链，处理搜索、读写与多步骤任务',
          )}
          emptyStateAgentFullDescription={t(
            'chat.emptyState.agentFullDescription',
            '自动放行工具调用，处理搜索、读写与多步骤任务',
          )}
          onUserMessageViewportChange={setNavigatorViewport}
          windowNavigationKey={windowNavigationKey || undefined}
          windowNavigationTargetMessageId={windowNavigationTargetMessageId}
          messageNavigatorContent={messageNavigatorContent}
          bottomSpacerHeight={inputOverlayHeight}
          footerContent={mainInputFooter}
        />
      )}
    </div>
  )
})

Chat.displayName = 'Chat'

export default Chat
