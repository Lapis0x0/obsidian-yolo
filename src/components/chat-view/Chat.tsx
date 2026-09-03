import { EditorView } from '@codemirror/view'
import { Pencil, Trash2 } from 'lucide-react'
import { MarkdownView, Notice, TFile, TFolder } from 'obsidian'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
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
import {
  type ChatRuntimeId,
  type CliRuntimeScope,
  type CliSessionRef,
  RUNTIME_CAPABILITIES,
  buildCliEnvironmentContext,
  createYoloChatRuntimeActions,
  isCliRuntime,
  isCliRuntimeAvailable,
} from '../../core/cli-runtime'
import { resolveLocalizedText } from '../../core/modules/moduleI18n'
import type { ChatLeafPlacement } from '../../features/chat/chatLeafSessionManager'
import { useChatHighlightSession } from '../../features/editor/selection-highlight/useChatHighlightSession'
import {
  getConversationDisplayTitle,
  useChatHistory,
} from '../../hooks/useChatHistory'
import { useChatManager } from '../../hooks/useJsonManagers'
import { useLiteSkillEntries } from '../../hooks/useLiteSkillEntries'
import type { ChatMessage, ChatUserMessage } from '../../types/chat'
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
import { ObsidianIcon } from '../common/ObsidianIcon'

// removed Prompt Templates feature

import { AssistantRenderStreamProvider } from './assistant-render-stream-context'
import {
  CHAT_MODES,
  CLAUDE_CODE_CHAT_MODES,
  CODEX_CHAT_MODES,
  type ChatMode,
  type ModuleChatModeOption,
  chatModeForSave,
  isModuleChatMode,
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
import type {
  ChatSessionCliContext,
  ChatSessionControllerDeps,
} from './ChatSessionController'
import { ChatSessionController } from './ChatSessionController'
import CliChatSurface from './CliChatSurface'
import { useActiveViewState } from './hooks/useActiveViewState'
import {
  useMobileChatViewContentClass,
  useMobileKeyboardViewportHeight,
} from './hooks/useMobileViewport'
import { useSnippetEntries } from './hooks/useSnippetEntries'
import { getInputOverlayReserveHeight } from './inputOverlayReserve'
import type { QueryProgressState } from './QueryProgress'
import SparklePanel, { type SparkleView } from './sparkle/SparklePanel'
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
  /**
   * PDF multi-quote annotation (docs/plans/2026-08-16-pdf-annotation-quotes.md).
   * Inserts `selectedBlock` as a numbered "批注N" mentionable and returns the
   * assigned number — chat is the only side allowed to assign it (architecture
   * decision A). Used by `ChatView.addPdfQuoteToChat` for the "existing leaf"
   * path; the "new leaf" path instead seeds it via `PendingChatOpenPayload`
   * and reads the number back through `ChatView.consumeLastPdfQuoteAnnotationNumber`.
   */
  addPdfQuoteToChat: (selectedBlock: MentionableBlockData) => number
  /**
   * The single deps channel the PDF-side bubble editor uses to patch or
   * remove its mentionable's comment (architecture decision B). `patch: null`
   * removes the mentionable.
   */
  updatePdfQuoteMention: (
    highlightId: string,
    patch: { comment: string } | null,
  ) => void
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
  /**
   * Renames the currently active conversation. No-ops when there is no
   * active persisted conversation to rename (e.g. a brand-new, not-yet-saved
   * chat) — the pane-title inline editor (ChatView) only enters edit mode
   * when a persisted conversation is active, so this guard is defense in
   * depth rather than the primary gate.
   */
  renameCurrentConversation: (title: string) => Promise<void>
  /**
   * issue #567 Step 2. Exports the currently active conversation to the
   * vault, mirroring the in-content export button's behavior — gated on the
   * active runtime's `supportsVaultExport` capability. `ChatView`'s view
   * header action also toggles its own visibility from the same capability
   * (see `onRuntimeSnapshotChange`), so this check is defense in depth.
   */
  exportCurrentConversation: () => void
  /**
   * issue #567 Step 2. Opens the history dropdown (`ChatListDropdown`)
   * anchored at its usual History button. No-ops if the dropdown isn't
   * currently mounted (e.g. composer view is active).
   */
  openChatHistory: () => void
  /**
   * issue #567 Step 2. Snapshot of the active conversation's menu-relevant
   * state, read by `ChatView.onPaneMenu` to decide which pane-menu items are
   * enabled/visible. Derived from state Chat.tsx already tracks — not a new
   * state source.
   */
  getCurrentConversationMenuState: () => ConversationMenuState
  /**
   * issue #567 Step 2. Toggles the active conversation's pinned state.
   * No-ops when there is no active persisted conversation.
   */
  toggleCurrentConversationPinned: () => Promise<void>
  /**
   * issue #567 Step 2. Deletes the active conversation, including CLI
   * overlay cleanup and post-delete conversation switching — the same
   * shared implementation `ChatHeader`'s history dropdown uses. No-ops when
   * there is no active persisted conversation.
   */
  deleteCurrentConversation: () => Promise<void>
}

/** See `ChatRef.getCurrentConversationMenuState`. */
export type ConversationMenuState = {
  conversationId: string
  persisted: boolean
  pinned: boolean
  canExport: boolean
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
  /** Persisted (never runtime-downgraded) chat mode — see `chatModeForSave`. */
  persistedChatMode: ChatMode
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
  const quickAccessSnippetEntries = useSnippetEntries()
  const { t, language } = useLanguage()

  // Module chat modes (Phase D): subscribed here so the mode selector, empty
  // state, and assistant/YOLO visibility all react live to a module being
  // enabled/disabled — same registry `useSyncExternalStore` pattern as
  // `useChatStreamManager`/`useYoloChatSession`.
  const moduleChatModeRegistry = plugin.getModuleChatModeRegistry()
  const moduleChatModeSnapshot = useSyncExternalStore(
    moduleChatModeRegistry.subscribe,
    moduleChatModeRegistry.getSnapshot,
  )
  const moduleModeOptions = useMemo<ModuleChatModeOption[]>(
    () =>
      moduleChatModeSnapshot
        .filter((entry) => entry.availability.status === 'available')
        .map((entry) => ({
          value: entry.fullModeId as ModuleChatModeOption['value'],
          label: resolveLocalizedText(entry.mode.label, language),
          description: entry.mode.description
            ? resolveLocalizedText(entry.mode.description, language)
            : undefined,
          icon: entry.mode.icon,
        })),
    [moduleChatModeSnapshot, language],
  )

  const {
    createOrUpdateConversation,
    createOrUpdateConversationImmediately,
    updateConversationActiveBranches,
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
  // seed 早于 useChatInputController：activeRuntimeId 直接消费本 state。会话
  // 身份的唯一 owner 是下方构造的 ChatSessionController；这里只是它构造
  // 前（早于 preferencesController 就绪）需要的一次性初始值，构造完成后
  // `currentConversationId` 这个标识符改为从 controller 快照读取——写一次、
  // 不再更新的种子 useState 没有 setter。
  const [initialConversationId] = useState<string>(
    () =>
      seededRuntimeSnapshot?.currentConversationId ??
      props.initialConversationId ??
      uuidv4(),
  )
  // ChatSessionController 要等 preferencesController（下方 useChatRuntimePreferences
  // 的产出）就绪才能构造,但 useChatRuntimePreferences 本身在每次渲染都要读取
  // 「当前」会话 id（推进 ConversationPreferencesController 内部的会话游标）。
  // 用同一个 ref 承接：首次渲染 controller 尚未构造,退回 initialConversationId；
  // 此后每次渲染 controller 已经从上一轮渲染起持续存在,直接读它的最新快照。
  const sessionControllerRef = useRef<ChatSessionController | null>(null)
  const currentConversationId =
    sessionControllerRef.current?.getSnapshot().currentConversationId ??
    initialConversationId

  // normalizeReasoningLevel / initialReasoningLevel / getReasoningLevelForModelId
  // 只依赖全局 settings（与 conversationAssistantId 等会话级偏好无关），提到
  // useChatRuntimePreferences 调用之前计算好传入——这是消灭原环 1 里
  // 「useChatRuntimePreferences 需要反过来经 lateStateRef 读取这两个值」的
  // 关键：现在两者在调用时已经现成可用,不再需要延迟绑定。
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

    conversationModelId,
    conversationAssistantId,
    reasoningLevel,
    chatMode,
    persistedChatMode,
    yoloEnabled,
    conversationOverrides,
    setConversationModelId,
    setConversationAssistantId,
    setReasoningLevel,
    setChatMode,
    setConversationOverrides,
    conversationModelIdRef,
    conversationReasoningLevelRef,
    conversationAssistantIdRef,
    conversationOverridesRef,
    switchConversation,

    persistReasoningLevelForModel,
    persistChatRuntimePreference,
    applyAssistantDefaultModel,
    handleConversationAssistantSelect,
    handleChatModeChange,
    handleYoloChange,
    onAssistantDefaultModelApplied,

    cliRuntimeSwitchLateStateRef,
    preferencesController,
  } = useChatRuntimePreferences({
    app,
    t,
    settings,
    setSettings,
    cliRuntimeScope,
    cliRuntimeAvailable,
    chatMountedRef,
    seededActiveRuntimeId: seededRuntimeSnapshot?.activeRuntimeId,
    hasInitialConversationId: props.initialConversationId !== undefined,
    currentConversationId,
    seededPreferences: seededRuntimeSnapshot
      ? {
          conversationModelId: seededRuntimeSnapshot.conversationModelId,
          conversationAssistantId:
            seededRuntimeSnapshot.conversationAssistantId,
          reasoningLevel: seededRuntimeSnapshot.reasoningLevel,
          chatMode: seededRuntimeSnapshot.chatMode,
          persistedChatMode: seededRuntimeSnapshot.persistedChatMode,
          yoloEnabled: seededRuntimeSnapshot.yoloEnabled,
          conversationOverrides: seededRuntimeSnapshot.conversationOverrides,
        }
      : undefined,
    initialReasoningLevel,
    getReasoningLevelForModelId,
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
  // Recreated whenever `effectiveSettings` changes — ChatSessionController
  // reads it through this ref (never a captured reference) so a settings
  // change doesn't leave the controller calling a stale instance.
  const requestContextBuilderRef = useLatestRef(requestContextBuilder)

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

  // 消息态八件套（会话身份 + chatMessages/compactionState/
  // pendingCompactionAnchorMessageId/messageModelMap/messageReasoningMap/
  // assistantGroupBoundaryMessageIds/activeBranchByUserMessageId）的唯一
  // owner——见架构治理第三步分期 C1。deps 经 getter 闭包注入,与
  // preferencesController 同款;构造一次,随 ChatView 实例存活。
  // useChatHistory() 的四个持久化函数经 chatManager（settings 变化时
  // 重建,见 useJsonManagers.ts）间接依赖 settings,并非跨渲染稳定引用——
  // 必须经 useLatestRef 转发,不能被 sessionControllerDepsRef 的一次性
  // ??= 直接捕获(否则 settings 变更后 controller 会一直调用第一次渲染
  // 时那个已过期的闭包)。
  const createOrUpdateConversationRef = useLatestRef(createOrUpdateConversation)
  const createOrUpdateConversationImmediatelyRef = useLatestRef(
    createOrUpdateConversationImmediately,
  )
  const updateConversationTitleRef = useLatestRef(updateConversationTitle)
  const generateConversationTitleRef = useLatestRef(generateConversationTitle)
  // C2 additions (提交/中止/压缩/重试收归 controller): two of the new deps
  // can only be assembled once hooks called *after* this point are ready
  // (useChatStreamManager's mutation/abort/compact, and the CLI orchestration
  // bag) — same "assign later, read through a getter" technique as
  // `cliRuntimeSwitchLateStateRef` in useChatRuntimePreferences.ts. Declared
  // here (before the controller is constructed) so `sessionControllerDeps`'s
  // one-time `??=` object can close over stable ref identities.
  const sessionRunLateDepsRef = useRef<{
    submitChatMutation: ReturnType<
      typeof useChatStreamManager
    >['submitChatMutation']
    abortConversationRun: ReturnType<
      typeof useChatStreamManager
    >['abortConversationRun']
    compactConversation: ReturnType<
      typeof useChatStreamManager
    >['compactConversation']
    forceScrollToBottom: () => void
  } | null>(null)
  const getSessionRunLateDeps = useCallback(() => {
    const late = sessionRunLateDepsRef.current
    if (!late) {
      throw new Error(
        '[YOLO] Chat: sessionController run deps accessed before useChatStreamManager hydrated sessionRunLateDepsRef',
      )
    }
    return late
  }, [])
  const cliSubmitContextRef = useRef<ChatSessionCliContext | null>(null)
  const sessionControllerDepsRef = useRef<ChatSessionControllerDeps>()
  const sessionControllerDeps = (sessionControllerDepsRef.current ??= {
    getAgentService: () => plugin.getAgentService(),
    createOrUpdateConversation: (...args) =>
      createOrUpdateConversationRef.current(...args),
    createOrUpdateConversationImmediately: (...args) =>
      createOrUpdateConversationImmediatelyRef.current(...args),
    updateConversationTitle: (id, title) =>
      updateConversationTitleRef.current(id, title),
    chatModeForSave,
    getRequestContextBuilder: () => requestContextBuilderRef.current,
    runConversation: (params, options) =>
      getSessionRunLateDeps().submitChatMutation.mutate(params, options),
    abortConversationRun: (conversationId) =>
      getSessionRunLateDeps().abortConversationRun(conversationId),
    compactConversation: (messages) =>
      getSessionRunLateDeps().compactConversation(messages),
    generateConversationTitle: (...args) =>
      generateConversationTitleRef.current(...args),
    forceScrollToBottom: (options) => {
      if (options?.deferToNextFrame) {
        requestAnimationFrame(() =>
          getSessionRunLateDeps().forceScrollToBottom(),
        )
        return
      }
      getSessionRunLateDeps().forceScrollToBottom()
    },
    setQueryProgress: (action) => setQueryProgress(action),
    runtimeNavigationGenerationRef,
    getCliSubmitContext: () => cliSubmitContextRef.current,
  })
  const sessionController = (sessionControllerRef.current ??=
    new ChatSessionController(
      initialConversationId,
      {
        chatMessages: [],
        compactionState: [],
        pendingCompactionAnchorMessageId: null,
        messageModelMap: new Map(),
        messageReasoningMap: new Map(),
        assistantGroupBoundaryMessageIds: [],
        activeBranchByUserMessageId: new Map(),
      },
      preferencesController,
      sessionControllerDeps,
    ))
  useEffect(() => {
    // StrictMode（dev 构建）会把本 effect 重放为 setup→cleanup→setup：
    // cleanup 的 dispose() 掉线后由 setup 幂等重建 AgentService 订阅。
    sessionController.resumeAgentSubscription()
    return () => sessionController.dispose()
  }, [sessionController])

  const {
    chatMessages,
    compactionState,
    pendingCompactionAnchorMessageId,
    messageModelMap,
    messageReasoningMap,
    assistantGroupBoundaryMessageIds,
    activeBranchByUserMessageId,
  } = useSyncExternalStore(
    sessionController.subscribe,
    sessionController.getSnapshot,
  )
  const chatMessagesStateRef = sessionController.chatMessagesStateRef
  const activeBranchByUserMessageIdRef =
    sessionController.activeBranchByUserMessageIdRef
  const setChatMessages = sessionController.setChatMessages
  const setCompactionState = sessionController.setCompactionState
  const setPendingCompactionAnchorMessageId =
    sessionController.setPendingCompactionAnchorMessageId
  const setMessageModelMap = sessionController.setMessageModelMap
  const setMessageReasoningMap = sessionController.setMessageReasoningMap
  const setAssistantGroupBoundaryMessageIds =
    sessionController.setAssistantGroupBoundaryMessageIds
  const setActiveBranchByUserMessageId =
    sessionController.setActiveBranchByUserMessageId
  const setCurrentConversationId = sessionController.setCurrentConversationId

  const inputController = useChatInputController({
    seededInputMessage: seededRuntimeSnapshot?.inputMessage,
    seededInputDraftRevision: seededRuntimeSnapshot?.inputDraftRevision,
    initialReasoningLevel,
    selectedBlock: props.selectedBlock,
    activeRuntimeId,
    buildNewInputMessage: getNewInputMessage,
    chatMessagesStateRef,
    setChatMessages,
    preferencesController,
    sessionController,
    currentConversationId,
    assistantGroupBoundaryMessageIds,
    queuedMessageEditState,
    setQueuedMessageEditState,
    getReasoningLevelForModelId,
    persistReasoningLevelForModel,
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
    handleQuotePdfSelection,
    updatePdfQuoteMention,
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
  // Sparkle's main/settings split lives here because the gear that toggles it
  // sits in the chat header, and the header and the panel are siblings.
  const [sparkleView, setSparkleView] = useState<SparkleView>('main')
  useEffect(() => {
    // Leaving Sparkle drops you back on its content, not on its settings.
    if (activeView !== 'composer') setSparkleView('main')
  }, [activeView])
  const handleSparkleBack = useCallback(() => setSparkleView('main'), [])

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

  // Quick-access skill entries for the composer's `/` menu — scoped to the
  // active module chat mode's own skills (in addition to the always-included
  // user/global bucket) so a module's skills are only offered while its mode
  // is selected. Declared after `chatMode` so the scope can read it; hook
  // ordering across renders stays stable since this always runs.
  const quickAccessSkillEntries = useLiteSkillEntries(app, {
    settings,
    scope: isModuleChatMode(chatMode)
      ? { moduleChatModeId: chatMode }
      : undefined,
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

  const chatTimelineReadModel = useChatTimelineReadModel({
    messages: chatMessages,
    assistantGroupBoundaryMessageIds,
  })
  const groupedChatMessages = chatTimelineReadModel.groupedChatMessages

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

  // `chatMessagesStateRef` is now a live facade over the controller's own
  // snapshot (see ChatSessionController) — no forwarding effect needed.

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
    hermesProfileId,
    setHermesProfileId,
    switchHermesProfile,
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

  // handleRuntimeChange（useChatRuntimePreferences）依赖 CLI 编排 hook 就绪
  // 之后才产生的值——偏好七件套已经由 ConversationPreferencesController
  // 直接持有,不再需要经 late ref 注入;只有 CLI 编排相关的量仍需要在此写入。
  cliRuntimeSwitchLateStateRef.current = {
    cliPreferenceSettingsRef,
    cliModelCatalog,
    setCliConversationController,
    setCliConversationId,
    setCliChatMode,
    setCliYoloEnabled,
    setHermesProfileId,
    transitionCliSession,
    activeHistoryConversationId,
  }

  // ChatSessionController's `submit`/`abortRun` CLI branches read this bag
  // through `getCliSubmitContext()` — CLI orchestration state itself stays
  // owned by useCliRuntimeOrchestration's React state until C3 (see the
  // plan's C2 boundary rules); `null` whenever the active runtime is 'yolo'
  // or that hook hasn't produced a ready controller/coordinator/scope yet,
  // mirroring the pre-C2 `if (!controller || !coordinator || !scope) return`
  // guard in `handleMainInputSubmit`.
  cliSubmitContextRef.current =
    activeRuntimeId !== 'yolo' &&
    cliConversationController &&
    cliOperationCoordinator &&
    cliRuntimeScope
      ? {
          runtimeId: activeRuntimeId,
          controller: cliConversationController,
          coordinator: cliOperationCoordinator,
          scope: cliRuntimeScope,
          settings,
          chatMode: cliChatMode,
          yoloEnabled: cliYoloEnabled,
          cliConversationId,
          getDraftRevision: () => inputDraftRevisionRef.current,
          buildEnvironmentContext: () =>
            buildCliEnvironmentContext({
              app,
              settings,
              currentFile: activeFile,
              currentFileViewState: activeViewState,
            }),
          createOrTouchCliConversation,
          generateConversationTitle,
          syncCliConversationTitle,
          setCliConversationId,
          consumeAcceptedCliDraft,
          isMounted: () => chatMountedRef.current,
        }
      : null

  // applyAssistantDefaultModel 触达输入层（写回草稿 reasoningLevel）的一次
  // 性事件——由 controller 在 assistant 切换/chatMode 级联触发默认模型应用
  // 时发出，这里连接到 setInputMessage。取代原
  // ChatRuntimePreferencesLateState.setInputMessage 反向依赖。
  useEffect(
    () =>
      onAssistantDefaultModelApplied((level: ReasoningLevel) => {
        setInputMessage((prev) => ({
          ...prev,
          reasoningLevel: level,
        }))
      }),
    [onAssistantDefaultModelApplied, setInputMessage],
  )

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
  // Hydrate the C2 run-deps late ref every render — see its declaration for
  // why this can't be captured once at construction time.
  sessionRunLateDepsRef.current = {
    submitChatMutation,
    abortConversationRun,
    compactConversation,
    forceScrollToBottom: triggerForceScrollToBottom,
  }

  const {
    runSummariesByConversationId,
    queuedUserMessages,
    serializeMessageModelMap,
    normalizeAssistantGroupBoundaryMessageIds,
    persistConversationImmediately,
    persistActiveBranchSelection,
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
    sessionController,
    initialConversationId: props.initialConversationId,
    onConversationContextChange: props.onConversationContextChange,
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
    hermesProfileId,
    setHermesProfileId,
    transitionCliSession,
    createFreshCliConversation,
  })

  const {
    handleRecoverPendingToolCall,
    handleUserMessageSubmit,
    applyMutation,
    handleApply,
    handleUndoEditSummary,
    handleOpenEditSummaryFile,
    handleToolMessageUpdate,
    handleToolCallResponseUpdate,
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
    assistantGroupBoundaryMessageIds,
    activeBranchByUserMessageIdRef,
    messageModelMap,
    reasoningLevel,
    conversationReasoningLevelRef,
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
    generateConversationTitle,
    submitChatMutation,
    abortConversationRun,
    requestContextBuilder,
    chatManager,
    normalizeReasoningLevel,
  })

  // issue #567 Step 2：history 弹层的「打开」能力提升给 ChatRef.openChatHistory
  // 调用——见 ChatListDropdown 的 openHandleRef 文档注释，避免受控 prop / ref
  // 转发的更大改动。
  const historyDropdownOpenRef = useRef<(() => void) | null>(null)

  // issue #567 Step 2：删除会话的清理（CLI overlay 移除）+ 后续会话切换逻辑，
  // 从 ChatHeader 内联的 onDelete 下沉到这里，供 ChatHeader（任意历史条目）
  // 与 ChatRef.deleteCurrentConversation（当前会话，⋯ 窗格菜单走这条）共用。
  const deleteConversationWithCleanup = useCallback(
    async (conversationId: string) => {
      const conversation = await getConversationById(conversationId)
      await deleteConversation(conversationId)
      if (conversation?.cliSession && cliRuntimeScope) {
        await cliRuntimeScope.sessionService.removeOverlay(
          conversation.cliSession,
        )
      }
      if (conversationId !== activeHistoryConversationId) {
        return
      }
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
    },
    [
      getConversationById,
      deleteConversation,
      cliRuntimeScope,
      activeHistoryConversationId,
      activeRuntimeId,
      chatList,
      handleNewChat,
      handleLoadConversation,
    ],
  )

  // retry/continue/recover 收编进 ChatSessionController（架构治理第三步
  // 分期 C3）——这里只做 Notice 翻译的薄包装，参考 handleMainInputSubmit
  // 在 useChatInputController.ts 里的既有模式。
  const handleAssistantMessageGroupRetry = useCallback(
    (messageIds: string[]) => {
      const result = sessionController.retryAssistantMessageGroup(messageIds)
      if (result.kind === 'failed') {
        new Notice(
          t('chat.regenerateFailed', 'Failed to regenerate this reply'),
        )
      }
    },
    [sessionController, t],
  )

  const handleAssistantErrorContinue = useCallback(
    (assistantMessageId: string) => {
      const result =
        sessionController.continueAssistantError(assistantMessageId)
      if (result.kind === 'failed') {
        new Notice(
          t('chat.regenerateFailed', 'Failed to regenerate this reply'),
        )
      }
      // 'pending'（重入保护）与 'started' 均不提示,与迁移前行为一致。
    },
    [sessionController, t],
  )

  const handleContinueResponse = useCallback(() => {
    sessionController.continueResponse()
  }, [sessionController])

  const handleRecoverAnswerUserQuestion = useCallback(
    ({
      resolvedMessages,
    }: {
      resolvedMessages: ChatMessage[]
      toolCallId: string
    }) => {
      sessionController.recoverAnswerUserQuestion(resolvedMessages)
    },
    [sessionController],
  )

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
    persistedChatMode,
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
    addPdfQuoteToChat: (selectedBlock: MentionableBlockData) =>
      handleQuotePdfSelection(selectedBlock),
    updatePdfQuoteMention: (
      highlightId: string,
      patch: { comment: string } | null,
    ) => {
      updatePdfQuoteMention(highlightId, patch)
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
    renameCurrentConversation: async (title: string) => {
      const trimmedTitle = title.trim()
      if (
        !trimmedTitle ||
        !activeHistoryConversationId ||
        !currentConversationPersisted
      ) {
        return
      }
      await updateConversationTitle(activeHistoryConversationId, trimmedTitle)
      syncCliConversationTitle(activeHistoryConversationId, trimmedTitle)
    },
    exportCurrentConversation: () => {
      if (!RUNTIME_CAPABILITIES[activeRuntimeId].supportsVaultExport) return
      handleExportChatToVault(currentConversationId)
    },
    openChatHistory: () => {
      historyDropdownOpenRef.current?.()
    },
    getCurrentConversationMenuState: () => ({
      conversationId: activeHistoryConversationId,
      persisted: currentConversationPersisted,
      pinned:
        chatList.find((chat) => chat.id === activeHistoryConversationId)
          ?.isPinned ?? false,
      canExport: RUNTIME_CAPABILITIES[activeRuntimeId].supportsVaultExport,
    }),
    toggleCurrentConversationPinned: async () => {
      if (!activeHistoryConversationId || !currentConversationPersisted) {
        return
      }
      await toggleConversationPinned(activeHistoryConversationId)
    },
    deleteCurrentConversation: async () => {
      if (!activeHistoryConversationId || !currentConversationPersisted) {
        return
      }
      await deleteConversationWithCleanup(activeHistoryConversationId)
    },
  }))

  const header = (
    <ChatHeader
      isSidebarPlacement={isSidebarPlacement}
      activeView={activeView}
      onChangeView={onChangeView}
      sparkleView={sparkleView}
      onChangeSparkleView={setSparkleView}
      activeRuntimeId={activeRuntimeId}
      handleRuntimeChange={handleRuntimeChange}
      lastCliRuntimeIdRef={lastCliRuntimeIdRef}
      cliRuntimeAvailable={cliRuntimeAvailable}
      cliRuntimeScope={cliRuntimeScope}
      chatMode={chatMode}
      containerRef={containerRef}
      isWorkspaceWideHeader={isWorkspaceWideHeader}
      setIsWorkspaceWideHeader={setIsWorkspaceWideHeader}
      setWorkspaceWideHeaderHeight={setWorkspaceWideHeaderHeight}
      conversationAssistantId={conversationAssistantId}
      handleConversationAssistantSelect={handleConversationAssistantSelect}
      hermesProfileId={hermesProfileId}
      handleHermesProfileSelect={switchHermesProfile}
      handleNewChat={handleNewChat}
      handleExportChatToVault={handleExportChatToVault}
      currentConversationId={currentConversationId}
      chatList={chatList}
      activeHistoryConversationId={activeHistoryConversationId}
      runSummariesByConversationId={runSummariesByConversationId}
      handleLoadConversation={handleLoadConversation}
      getConversationById={getConversationById}
      deleteConversationWithCleanup={deleteConversationWithCleanup}
      updateConversationTitle={updateConversationTitle}
      syncCliConversationTitle={syncCliConversationTitle}
      toggleConversationPinned={toggleConversationPinned}
      generateConversationTitle={generateConversationTitle}
      historyOpenHandleRef={historyDropdownOpenRef}
    />
  )

  const buildContextBreakdownInputsRef = useLatestRef(
    buildContextBreakdownInputs,
  )

  // 输入控制器的「延迟依赖」——现只剩真正晚于 useChatInputController 产生的
  // 值：CLI 编排（useCliRuntimeOrchestration）、选区高亮会话
  // （useChatHighlightSession）、运行态摘要（useChatStreamManager）。提交/
  // 中止/压缩/编辑历史消息/mentionable 持久化等已收归
  // `sessionController`（架构治理第三步分期 C2），不再经此对象读写——见
  // `ChatInputLateState` 的类型文档。
  inputController.lateStateRef.current = {
    releaseHighlightIds,
    commitSentSelectionHighlights,
    cliChatMode,
    cliConversationController,
    cliOperationCoordinator,
    cliRuntimeScope,
    cliYoloEnabled,
    cliPreferenceSettingsRef,
    refreshCliSkills,
    currentConversationRunSummary,
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
  // `/` 菜单按运行时 capability 组装原生动作条目：supportsContextCompaction
  // 贡献压缩上下文，hasPluginManagement 贡献插件管理，hasNativeMcpPanel
  // 贡献 MCP 状态；hermes 仅支持压缩上下文（`/compress`），无插件管理与 MCP 状态。
  const nativeSlashCommands = useMemo<SlashCommand[]>(() => {
    const capabilities = RUNTIME_CAPABILITIES[activeRuntimeId]
    const commands: SlashCommand[] = []
    if (capabilities.supportsContextCompaction) {
      commands.push({
        id: 'compact-context',
        name: t('chat.slashCommands.compact.label', '压缩上下文'),
        description: t(
          'chat.slashCommands.compact.description',
          '手动压缩较早对话历史，并在新的上下文窗口中继续当前任务。',
        ),
      })
    }
    if (capabilities.hasPluginManagement) {
      commands.push({
        id: 'open-plugin-manager',
        name: t('chat.slashCommands.openPluginManager.label', '插件管理'),
        description: t(
          'chat.slashCommands.openPluginManager.description',
          '管理已安装的 Claude Code 插件，或从 Marketplace 安装新插件。',
        ),
      })
    }
    if (capabilities.hasNativeMcpPanel) {
      commands.push({
        id: 'open-mcp-servers',
        name: t('chat.slashCommands.openMcpServers.label', 'MCP 服务器'),
        description: t(
          'chat.slashCommands.openMcpServers.description',
          '查看当前会话加载的 MCP 服务器状态。',
        ),
      })
    }
    return commands
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
  const currentModuleModeOption = isModuleChatMode(chatMode)
    ? moduleModeOptions.find((option) => option.value === chatMode)
    : undefined
  const emptyStateModuleContent = currentModuleModeOption
    ? {
        title: currentModuleModeOption.label,
        description: currentModuleModeOption.description ?? '',
        icon: (
          <ObsidianIcon
            name={currentModuleModeOption.icon}
            className="yolo-chat-empty-state-module-icon"
          />
        ),
      }
    : undefined
  const isCliRuntimeActive = isCliRuntime(activeRuntimeId)
  // Main-input display/config differences are looked up from the static
  // capability table (see B1/B2 in the step-2 runtime-contract plan) rather
  // than branched inline; only "which data source" ternaries stay here.
  const mainInputCapabilities = RUNTIME_CAPABILITIES[activeRuntimeId]
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
        skipImageModelCapabilityCheck={
          mainInputCapabilities.skipsImageModelCapabilityCheck
        }
        skillEntries={isCliRuntimeActive ? cliSkillEntries : undefined}
        modelId={conversationModelId}
        onModelChange={handleMainInputModelChange}
        showModelControl={mainInputCapabilities.supportsModelControl}
        allowModelMentions={mainInputCapabilities.supportsModelControl}
        reasoningLevel={reasoningLevel}
        onReasoningChange={handleMainInputReasoningChange}
        showReasoningSelect={mainInputCapabilities.supportsReasoningSelect}
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
          isCliRuntimeActive || isModuleChatMode(chatMode)
            ? undefined
            : conversationAssistantId
        }
        onSelectAssistantForConversation={
          isCliRuntimeActive || isModuleChatMode(chatMode)
            ? undefined
            : handleConversationAssistantSelect
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
          isCliRuntimeActive
            ? mainInputCapabilities.supportsPlanMode
              ? CLAUDE_CODE_CHAT_MODES
              : CODEX_CHAT_MODES
            : moduleModeOptions.length > 0
              ? [
                  ...CHAT_MODES,
                  ...moduleModeOptions.map((option) => option.value),
                ]
              : CHAT_MODES
        }
        moduleModeOptions={moduleModeOptions}
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
          mainInputCapabilities.supportsQueueWhileGenerating
            ? currentConversationRunSummary.isQueueable
            : false
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
    // 生成中的 assistant 正文/思考走展示流而不是会话快照，入口在这里注入，
    // 让 markdown 渲染链底部的叶子不必依赖 plugin context。
    <AssistantRenderStreamProvider access={agentService}>
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
            <SparklePanel
              view={sparkleView}
              onBack={handleSparkleBack}
              onNavigateChat={() => onChangeView?.('chat')}
            />
          </div>
        ) : isCliRuntimeActive &&
          cliConversationController &&
          activeCliConversationSnapshot &&
          cliRuntimeScope ? (
          <CliChatSurface
            key={activeCliConversationSnapshot.surfaceId}
            snapshot={activeCliConversationSnapshot}
            cliRuntimeScope={cliRuntimeScope}
            presentedDraft={cliOperationSnapshot?.presentedDraft ?? null}
            showEmptyState={activeSurfaceEmpty}
            actions={
              cliChatRuntimeActions ?? cliRuntimeScope.chatRuntimeActions
            }
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
            emptyStateModuleContent={emptyStateModuleContent}
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
            persistActiveBranchSelection={persistActiveBranchSelection}
            updateHistoricalUserMessage={updateHistoricalUserMessage}
            finalizeHistoricalUserMessageEdit={
              finalizeHistoricalUserMessageEdit
            }
            dismissHistoricalUserMessage={dismissHistoricalUserMessage}
            handleAssistantMessageEditSave={handleAssistantMessageEditSave}
            handleAssistantMessageEditCancel={handleAssistantMessageEditCancel}
            handleAssistantMessageGroupDelete={
              handleAssistantMessageGroupDelete
            }
            handleHistoricalUserMessageDelete={
              handleHistoricalUserMessageDelete
            }
            handleAssistantMessageGroupBranch={
              handleAssistantMessageGroupBranch
            }
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
    </AssistantRenderStreamProvider>
  )
})

Chat.displayName = 'Chat'

export default Chat
