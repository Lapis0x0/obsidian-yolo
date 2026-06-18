import { EditorView } from '@codemirror/view'
import { useMutation } from '@tanstack/react-query'
import cx from 'clsx'
import { Download, History, Plus } from 'lucide-react'
import { MarkdownView, Notice, TFile, TFolder, normalizePath } from 'obsidian'
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
import { useMcp } from '../../contexts/mcp-context'
import { usePlugin } from '../../contexts/plugin-context'
import { useSettings } from '../../contexts/settings-context'
import {
  resolveAssistantIncludeCurrentFileContent,
  resolveAssistantTimeContextEnabled,
} from '../../core/agent/assistant-capabilities'
import { getLatestAssistantContextUsage } from '../../core/agent/compaction'
import { DEFAULT_ASSISTANT_ID } from '../../core/agent/default-assistant'
import type { AgentConversationRunSummary } from '../../core/agent/service'
import { materializeTextEditPlan } from '../../core/edits/textEditEngine'
import { parseTextEditPlan } from '../../core/edits/textEditPlan'
import { captureLLMDebugOperation } from '../../core/llm/debugCapture'
import { getLocalFileToolServerName } from '../../core/mcp/localFileTools'
import { parseToolName } from '../../core/mcp/tool-name-utils'
import { readEditReviewSnapshot } from '../../database/json/chat/editReviewSnapshotStore'
import type { ChatLeafPlacement } from '../../features/chat/chatLeafSessionManager'
import { selectionHighlightController } from '../../features/editor/selection-highlight/selectionHighlightController'
import { useChatHighlightSession } from '../../features/editor/selection-highlight/useChatHighlightSession'
import {
  getConversationDisplayTitle,
  useChatHistory,
} from '../../hooks/useChatHistory'
import { useChatManager } from '../../hooks/useJsonManagers'
import type { ApplyViewState } from '../../types/apply-view.types'
import type {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
  ChatConversationCompactionState,
  ChatMessage,
  ChatSubagentResultMessage,
  ChatTerminalCommandResultMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'
import { getLatestChatConversationCompaction } from '../../types/chat'
import type { ChatTimelineItem } from '../../types/chat-timeline'
import type { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import type {
  Mentionable,
  MentionableAssistantQuote,
  MentionableBlock,
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
  type ToolCallRequest,
  type ToolCallResponse,
  ToolCallResponseStatus,
  getToolCallArgumentsObject,
} from '../../types/tool-call.types'
import {
  type GroupEditSummary,
  deriveToolEditUndoStatus,
  updateToolMessageEditSummary,
} from '../../utils/chat/editSummary'
import { exportChatConversationToVault } from '../../utils/chat/exportConversation'
import {
  buildForegroundAgentVisualTurnPlan,
  getForegroundAgentFooterForGroup,
} from '../../utils/chat/foregroundAgentVisualTurns'
import {
  getBlockContentHash,
  getBlockMentionableCountInfo,
  getMentionableKey,
  serializeMentionable,
} from '../../utils/chat/mentionable'
import { groupAssistantAndToolMessages } from '../../utils/chat/message-groups'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { buildChatTimelineItems } from '../../utils/chat/timeline'
import { formatTokenCount } from '../../utils/llm/formatTokenCount'
import { resolveEffectiveMaxContextTokens } from '../../utils/llm/model-capability-registry'
import { readTFileContent } from '../../utils/obsidian'
import { stampUserMessageTimeContext } from '../../utils/prompt/timeContext'
import DotLoader from '../common/DotLoader'
import { AgentModeWarningModal } from '../modals/AgentModeWarningModal'

// removed Prompt Templates feature

import { AssistantSelector } from './AssistantSelector'
import AssistantToolMessageGroupItem from './AssistantToolMessageGroupItem'
import {
  type ChatMode,
  isAgentChatMode,
  normalizeChatMode,
} from './chat-input/ChatModeSelect'
import ChatUserInput from './chat-input/ChatUserInput'
import type { ChatUserInputRef } from './chat-input/ChatUserInput'
import MentionableBadge from './chat-input/MentionableBadge'
import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'
import { getChatSurfacePreset } from './chat-surface-presets'
import { ChatConversationPane } from './ChatConversationPane'
import { ChatListDropdown } from './ChatListDropdown'
import {
  buildRetrySubmissionMessages,
  getDisplayedAssistantToolMessages,
  getSourceUserMessageIdForGroup,
} from './chatRetry'
import Composer from './Composer'
import { useActiveViewState } from './hooks/useActiveViewState'
import { syncRenderedLatexSelection } from './latex-copy'
import MessageNavigator from './MessageNavigator'
import type { MessageNavigatorAnchor } from './MessageNavigator'
import QueryProgress from './QueryProgress'
import type { QueryProgressState } from './QueryProgress'
import { TodoListPanel } from './TodoListPanel'
import { useAutoScroll } from './useAutoScroll'
import { useChatHistoryWindow } from './useChatHistoryWindow'
import { useChatStreamManager } from './useChatStreamManager'
import UserMessageItem from './UserMessageItem'
import ViewToggle from './ViewToggle'

const WORKSPACE_WIDE_HEADER_MIN_WIDTH = 1200
const MESSAGE_NAVIGATOR_MIN_ANCHORS = 7
const MESSAGE_NAVIGATOR_LABEL_MAX_LENGTH = 90

const getPromptContentText = (
  promptContent: ChatUserMessage['promptContent'],
): string => {
  if (!promptContent) {
    return ''
  }
  if (typeof promptContent === 'string') {
    return promptContent
  }
  return promptContent
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join(' ')
}

const normalizeNavigatorLabel = (text: string, fallback: string): string => {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return fallback
  }
  if (normalized.length <= MESSAGE_NAVIGATOR_LABEL_MAX_LENGTH) {
    return normalized
  }
  return `${normalized.slice(0, MESSAGE_NAVIGATOR_LABEL_MAX_LENGTH - 1)}…`
}

const isDelegateSubagentToolName = (name: string): boolean => {
  try {
    const parsed = parseToolName(name)
    return (
      parsed.serverName === getLocalFileToolServerName() &&
      parsed.toolName === 'delegate_subagent'
    )
  } catch {
    return name === 'delegate_subagent'
  }
}

const ensureDirectoryPathExists = async (
  app: ReturnType<typeof useApp>,
  path: string,
): Promise<void> => {
  const segments = normalizePath(path)
    .split('/')
    .filter((segment) => segment.length > 0)

  let currentPath = ''
  for (const segment of segments) {
    currentPath = currentPath.length > 0 ? `${currentPath}/${segment}` : segment
    const existing = app.vault.getAbstractFileByPath(currentPath)
    if (!existing) {
      await app.vault.createFolder(currentPath)
      continue
    }
    if (!(existing instanceof TFolder)) {
      throw new Error(`Path exists and is not a folder: ${currentPath}`)
    }
  }
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

const normalizeHydratedConversationMessages = (
  messages: ChatMessage[],
): { messages: ChatMessage[]; changed: boolean } => {
  let changed = false

  const nextMessages = messages.map((message) => {
    if (
      message.role === 'assistant' &&
      message.metadata?.generationState === 'streaming'
    ) {
      changed = true
      return {
        ...message,
        metadata: {
          ...message.metadata,
          generationState: 'aborted' as const,
        },
      }
    }

    if (message.role !== 'tool') {
      return message
    }

    let toolCallUpdated = false
    const nextToolCalls = message.toolCalls.map((toolCall) => {
      if (toolCall.response.status !== ToolCallResponseStatus.Running) {
        return toolCall
      }

      toolCallUpdated = true
      changed = true
      return {
        ...toolCall,
        response: { status: ToolCallResponseStatus.Aborted as const },
      }
    })

    if (!toolCallUpdated && message.metadata?.branchRunStatus !== 'running') {
      return message
    }

    if (message.metadata?.branchRunStatus === 'running') {
      changed = true
    }

    return {
      ...message,
      toolCalls: nextToolCalls,
      metadata:
        message.metadata?.branchRunStatus === 'running'
          ? {
              ...message.metadata,
              branchRunStatus: 'aborted' as const,
            }
          : message.metadata,
    }
  })

  return {
    messages: nextMessages,
    changed,
  }
}

const updateToolCallResponseInMessages = ({
  messages,
  toolMessageId,
  toolCallId,
  response,
}: {
  messages: ChatMessage[]
  toolMessageId: string
  toolCallId: string
  response: ToolCallResponse
}) =>
  messages.map((message) => {
    if (message.role !== 'tool' || message.id !== toolMessageId) {
      return message
    }

    return {
      ...message,
      toolCalls: message.toolCalls.map((toolCall) =>
        toolCall.request.id === toolCallId
          ? { ...toolCall, response }
          : toolCall,
      ),
    }
  })

const findDebugTraceIdForToolCall = (
  messages: ChatMessage[],
  toolCallId: string,
): string | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') {
      continue
    }
    const matches = message.toolCallRequests?.some(
      (toolCall) => toolCall.id === toolCallId,
    )
    if (matches) {
      return message.metadata?.llmDebugTraceId
    }
  }

  return undefined
}

const offsetToSelectionPosition = (content: string, offset: number) => {
  const clampedOffset = Math.max(0, Math.min(offset, content.length))
  const before = content.slice(0, clampedOffset)
  const lines = before.split('\n')

  return {
    line: Math.max(0, lines.length - 1),
    ch: lines.at(-1)?.length ?? 0,
  }
}

const getInlineSelectionRange = (
  originalContent: string,
  operationResults: ReturnType<
    typeof materializeTextEditPlan
  >['operationResults'],
): ApplyViewState['selectionRange'] | undefined => {
  const changedRanges = operationResults
    .map((result) => (result.changed ? result.matchedRange : undefined))
    .filter((range): range is NonNullable<typeof range> => Boolean(range))

  if (changedRanges.length === 0) {
    return undefined
  }

  const start = Math.min(...changedRanges.map((range) => range.start))
  const end = Math.max(...changedRanges.map((range) => range.end))

  return {
    from: offsetToSelectionPosition(originalContent, start),
    to: offsetToSelectionPosition(originalContent, end),
  }
}

const waitForEditorContentSync = async (
  view: EditorView,
  expectedContent: string,
  timeoutMs = 400,
): Promise<boolean> => {
  if (view.state.doc.toString() === expectedContent) {
    return true
  }

  const startedAt = Date.now()

  return await new Promise((resolve) => {
    const check = () => {
      if (!view.dom.isConnected) {
        resolve(false)
        return
      }

      if (view.state.doc.toString() === expectedContent) {
        resolve(true)
        return
      }

      if (Date.now() - startedAt >= timeoutMs) {
        resolve(false)
        return
      }

      window.setTimeout(check, 16)
    }

    window.setTimeout(check, 16)
  })
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

const getLatestUserSelectedModelIds = (
  messages: ChatMessage[],
): string[] | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user') {
      continue
    }
    return message.selectedModelIds?.length
      ? message.selectedModelIds
      : undefined
  }

  return undefined
}

const serializeActiveBranchByUserMessageId = (
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

const createSelectionBlockMentionable = (
  selectedBlock: MentionableBlockData,
): MentionableBlock => {
  const { count, unit } = getBlockMentionableCountInfo(selectedBlock.content)
  const source = normalizeSelectionSource(selectedBlock.source)
  return {
    type: 'block',
    ...selectedBlock,
    source,
    contentHash:
      selectedBlock.contentHash ?? getBlockContentHash(selectedBlock.content),
    contentCount: selectedBlock.contentCount ?? count,
    contentUnit: selectedBlock.contentUnit ?? unit,
  }
}

const createAssistantQuoteMentionable = ({
  conversationId,
  messageId,
  content,
}: {
  conversationId: string
  messageId: string
  content: string
}): MentionableAssistantQuote => {
  const trimmedContent = content.trim()
  const { count, unit } = getBlockMentionableCountInfo(trimmedContent)
  return {
    type: 'assistant-quote',
    conversationId,
    messageId,
    content: trimmedContent,
    contentHash: getBlockContentHash(trimmedContent),
    contentCount: count,
    contentUnit: unit,
  }
}

const normalizeSelectionSource = (
  source: MentionableBlockData['source'],
): 'selection-sync' | 'selection-pinned' => {
  return source === 'selection-pinned' ? 'selection-pinned' : 'selection-sync'
}

const isSyncSelectionSource = (source: MentionableBlock['source']): boolean => {
  return source === 'selection' || source === 'selection-sync'
}

const isSyncSelectionMentionable = (mentionable: Mentionable): boolean => {
  if (mentionable.type === 'block') {
    return isSyncSelectionSource(mentionable.source)
  }
  return (
    mentionable.type === 'web-selection' &&
    mentionable.source === 'web-selection-sync'
  )
}

const isSelectionBlockMentionable = (
  mentionable: Mentionable,
): mentionable is MentionableBlock => {
  return (
    mentionable.type === 'block' &&
    (mentionable.source === 'selection' ||
      mentionable.source === 'selection-sync' ||
      mentionable.source === 'selection-pinned')
  )
}

const collectSelectionHighlightIds = (
  mentionables: Mentionable[],
): string[] => {
  const ids = new Set<string>()
  for (const mentionable of mentionables) {
    if (!isSelectionBlockMentionable(mentionable)) continue
    if (mentionable.highlightId) ids.add(mentionable.highlightId)
  }
  return Array.from(ids)
}

const collectSelectionHighlightIdsFromMessages = (
  messages: ChatMessage[],
): string[] => {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const id of collectSelectionHighlightIds(message.mentionables)) {
      ids.add(id)
    }
  }
  return Array.from(ids)
}

const collectRemovedSelectionHighlightIds = (
  previousMentionables: Mentionable[],
  nextMentionables: Mentionable[],
): string[] => {
  const nextIds = new Set(collectSelectionHighlightIds(nextMentionables))
  return collectSelectionHighlightIds(previousMentionables).filter(
    (id) => !nextIds.has(id),
  )
}

const collectSelectionHighlightIdsByMentionableKey = (
  mentionables: Mentionable[],
  mentionableKey: string,
): string[] => {
  return collectSelectionHighlightIds(
    mentionables.filter(
      (mentionable) =>
        getMentionableKey(serializeMentionable(mentionable)) === mentionableKey,
    ),
  )
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
}

/**
 * 一份足以让 Chat 在 host DOM 被替换后无缝重建的 React state 快照。
 * 只接「会被用户实际改动 / 影响 UI 当前态」的字段——不要把整个 Chat state
 * 都塞进来（消息列表会从 DB 自动恢复，无需快照）。
 */
export type ChatRuntimeSnapshot = {
  currentConversationId: string
  inputMessage: ChatUserMessage
  conversationModelId: string
  conversationAssistantId: string
  chatMode: ChatMode
  reasoningLevel: ReasoningLevel
  conversationOverrides: ConversationOverrideSettings | null
}

export type ChatProps = {
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
    currentConversationTitle?: string
    currentModelId?: string
    currentOverrides?: ConversationOverrideSettings
  }) => void
}

const Chat = forwardRef<ChatRef, ChatProps>((props, ref) => {
  const app = useApp()
  const plugin = usePlugin()
  const agentService = plugin.getAgentService()
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const { getMcpManager } = useMcp()

  const {
    createOrUpdateConversation,
    createOrUpdateConversationImmediately,
    deleteConversation,
    getConversationById,
    updateConversationTitle,
    toggleConversationPinned,
    generateConversationTitle,
    chatList,
  } = useChatHistory()
  const chatManager = useChatManager()
  const seededRuntimeSnapshot = props.seededRuntimeSnapshot
  const [conversationAssistantId, setConversationAssistantId] =
    useState<string>(
      seededRuntimeSnapshot?.conversationAssistantId ??
        settings.currentAssistantId ??
        DEFAULT_ASSISTANT_ID,
    )
  const conversationAssistantIdRef = useRef<Map<string, string>>(new Map())
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
  const headerRef = useRef<HTMLDivElement | null>(null)
  const [isWorkspaceWideHeader, setIsWorkspaceWideHeader] = useState(false)
  const [workspaceWideHeaderHeight, setWorkspaceWideHeaderHeight] = useState(0)

  const [inputMessage, setInputMessage] = useState<ChatUserMessage>(() => {
    if (seededRuntimeSnapshot) {
      return seededRuntimeSnapshot.inputMessage
    }
    const newMessage = getNewInputMessage(initialReasoningLevel)
    if (props.selectedBlock) {
      newMessage.mentionables = [
        ...newMessage.mentionables,
        createSelectionBlockMentionable(props.selectedBlock),
      ]
    }
    return newMessage
  })
  const inputMessageRef = useRef(inputMessage)
  // 主输入框「是否为空」——发送按钮根据它切换淡化态/激活态。判断口径与
  // 下方 onSubmit 里的早返回一致：纯文本 trim 后为空、且无 mentionable、
  // 也无 skill。content 是 SerializedEditorState，每次 keystroke 引用都会变，
  // 所以 useMemo 这里足够。
  const isInputEmpty = useMemo(() => {
    const text = inputMessage.content
      ? editorStateToPlainText(inputMessage.content).trim()
      : ''
    return (
      text === '' &&
      inputMessage.mentionables.length === 0 &&
      (inputMessage.selectedSkills?.length ?? 0) === 0
    )
  }, [
    inputMessage.content,
    inputMessage.mentionables,
    inputMessage.selectedSkills,
  ])
  const chatMessagesStateRef = useRef<ChatMessage[]>([])
  const activeBranchByUserMessageIdRef = useRef<Map<string, string>>(new Map())
  const [addedBlockKey, setAddedBlockKey] = useState<string | null>(null)
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
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null)
  const suppressNextHistoricalUserMessageOutsidePointerRef = useRef<
    string | null
  >(null)
  const [currentConversationId, setCurrentConversationId] = useState<string>(
    () => seededRuntimeSnapshot?.currentConversationId ?? uuidv4(),
  )
  const untitledFallback = t('chat.untitledConversation', 'New chat')
  const currentConversationTitle = useMemo(() => {
    const rawTitle = currentConversationId
      ? chatList.find(
          (conversation) => conversation.id === currentConversationId,
        )?.title
      : undefined
    return getConversationDisplayTitle(rawTitle, untitledFallback)
  }, [chatList, currentConversationId, untitledFallback])
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>(
    seededRuntimeSnapshot?.reasoningLevel ?? initialReasoningLevel,
  )
  const conversationReasoningLevelRef = useRef<Map<string, ReasoningLevel>>(
    new Map(),
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

  const addMentionableToFocusedMessage = useCallback(
    (mentionable: Mentionable) => {
      setAddedBlockKey(null)

      if (focusedMessageId === inputMessage.id) {
        setInputMessage((prevInputMessage) => {
          const mentionableKey = getMentionableKey(
            serializeMentionable(mentionable),
          )
          if (
            prevInputMessage.mentionables.some(
              (m) =>
                getMentionableKey(serializeMentionable(m)) === mentionableKey,
            )
          ) {
            return prevInputMessage
          }
          return {
            ...prevInputMessage,
            mentionables: [...prevInputMessage.mentionables, mentionable],
            promptContent: null,
          }
        })
        return
      }

      setChatMessages((prevChatHistory) =>
        prevChatHistory.map((message) => {
          if (message.id !== focusedMessageId || message.role !== 'user') {
            return message
          }

          const mentionableKey = getMentionableKey(
            serializeMentionable(mentionable),
          )
          if (
            message.mentionables.some(
              (m) =>
                getMentionableKey(serializeMentionable(m)) === mentionableKey,
            )
          ) {
            return message
          }

          return {
            ...message,
            mentionables: [...message.mentionables, mentionable],
            promptContent: null,
          }
        }),
      )
    },
    [focusedMessageId, inputMessage.id],
  )

  const handleQuoteAssistantSelection = useCallback(
    ({
      conversationId,
      messageId,
      content,
    }: {
      messageId: string
      conversationId: string
      content: string
    }) => {
      const targetMessageId = focusedMessageId || inputMessage.id
      addMentionableToFocusedMessage(
        createAssistantQuoteMentionable({
          conversationId,
          messageId,
          content,
        }),
      )
      window.requestAnimationFrame(() => {
        chatUserInputRefs.current.get(targetMessageId)?.focus()
      })
    },
    [addMentionableToFocusedMessage, focusedMessageId, inputMessage.id],
  )

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
  }`
  const fontScale = settings.chatOptions.chatFontScale
  const containerStyle = {
    ...(!isSidebarPlacement && isWorkspaceWideHeader
      ? {
          '--yolo-chat-workspace-header-height': `${workspaceWideHeaderHeight}px`,
        }
      : {}),
    ...(fontScale != null ? { zoom: fontScale } : {}),
  } as CSSProperties

  // Per-conversation override settings (temperature, top_p, context, stream)
  const conversationOverridesRef = useRef<
    Map<string, ConversationOverrideSettings | null>
  >(new Map())
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

  const selectedAssistant = useMemo(() => {
    return (
      settings.assistants.find(
        (assistant) => assistant.id === conversationAssistantId,
      ) ?? null
    )
  }, [conversationAssistantId, settings.assistants])

  // Per-conversation model id (do NOT write back to global settings)
  const conversationModelIdRef = useRef<Map<string, string>>(new Map())
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

  const persistReasoningLevelForModel = useCallback(
    async (modelId: string, level: ReasoningLevel) => {
      if (!modelId) return
      const currentMap = settings.chatOptions.reasoningLevelByModelId ?? {}
      if (currentMap[modelId] === level) return
      try {
        await setSettings({
          ...settings,
          chatOptions: {
            ...settings.chatOptions,
            reasoningLevelByModelId: {
              ...currentMap,
              [modelId]: level,
            },
          },
        })
      } catch (error: unknown) {
        console.error('Failed to persist reasoning level preference', error)
      }
    },
    [setSettings, settings],
  )

  const persistPreferredChatMode = useCallback(
    async (mode: ChatMode) => {
      if (settings.chatOptions.chatMode === mode) {
        return
      }

      try {
        await setSettings({
          ...settings,
          chatOptions: {
            ...settings.chatOptions,
            chatMode: mode,
          },
        })
      } catch (error: unknown) {
        console.error('Failed to persist preferred chat mode', error)
      }
    },
    [setSettings, settings],
  )

  const persistPreferredAssistantId = useCallback(
    async (assistantId: string) => {
      if (settings.currentAssistantId === assistantId) {
        return
      }

      try {
        await setSettings({
          ...settings,
          currentAssistantId: assistantId,
        })
      } catch (error: unknown) {
        console.error('Failed to persist preferred assistant', error)
      }
    },
    [setSettings, settings],
  )

  const applyAssistantDefaultModel = useCallback(
    (assistantModelId?: string | null) => {
      if (!assistantModelId) {
        return
      }
      const matchedModel = settings.chatModels.find(
        (model) => model.id === assistantModelId,
      )
      if (!matchedModel) {
        return
      }
      setConversationModelId(assistantModelId)
      conversationModelIdRef.current.set(
        currentConversationId,
        assistantModelId,
      )
      const nextReasoningLevel = getReasoningLevelForModelId(assistantModelId)
      setReasoningLevel(nextReasoningLevel)
      conversationReasoningLevelRef.current.set(
        currentConversationId,
        nextReasoningLevel,
      )
      setInputMessage((prev) => ({
        ...prev,
        reasoningLevel: nextReasoningLevel,
      }))
    },
    [currentConversationId, getReasoningLevelForModelId, settings.chatModels],
  )

  const handleConversationAssistantSelect = useCallback(
    (assistantId: string) => {
      setConversationAssistantId(assistantId)
      conversationAssistantIdRef.current.set(currentConversationId, assistantId)
      void persistPreferredAssistantId(assistantId)
      const assistant = settings.assistants.find(
        (item) => item.id === assistantId,
      )
      if (assistant?.modelId) {
        applyAssistantDefaultModel(assistant.modelId)
      }
    },
    [
      applyAssistantDefaultModel,
      currentConversationId,
      persistPreferredAssistantId,
      settings.assistants,
    ],
  )

  useEffect(() => {
    if (
      settings.assistants.some(
        (assistant) => assistant.id === conversationAssistantId,
      )
    ) {
      return
    }
    const fallbackAssistantId =
      settings.currentAssistantId ??
      settings.assistants[0]?.id ??
      DEFAULT_ASSISTANT_ID
    setConversationAssistantId(fallbackAssistantId)
    conversationAssistantIdRef.current.set(
      currentConversationId,
      fallbackAssistantId,
    )
  }, [
    conversationAssistantId,
    currentConversationId,
    settings.assistants,
    settings.currentAssistantId,
  ])

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
  const submitMutationPendingRef = useRef(false)

  const groupedChatMessages: (ChatUserMessage | AssistantToolMessageGroup)[] =
    useMemo(() => {
      return groupAssistantAndToolMessages(
        chatMessages,
        assistantGroupBoundaryMessageIds,
      )
    }, [assistantGroupBoundaryMessageIds, chatMessages])
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
  const messageNavigatorAnchors = useMemo<MessageNavigatorAnchor[]>(() => {
    const emptyLabel = t('chat.messageNavigator.emptyMessage', '空消息')
    let userMessageIndex = 0
    return groupedChatMessages.flatMap((messageOrGroup) => {
      if (Array.isArray(messageOrGroup)) {
        return []
      }

      userMessageIndex += 1
      const editorText = messageOrGroup.content
        ? editorStateToPlainText(messageOrGroup.content)
        : ''
      const promptText = getPromptContentText(messageOrGroup.promptContent)
      return [
        {
          id: messageOrGroup.id,
          index: userMessageIndex,
          label: normalizeNavigatorLabel(editorText || promptText, emptyLabel),
        },
      ]
    })
  }, [groupedChatMessages, t])

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

  const firstUserMessageId = useMemo(() => {
    return chatMessages.find((message) => message.role === 'user')?.id
  }, [chatMessages])

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
    inputMessageRef.current = inputMessage
  }, [inputMessage])

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

  const { commitSentSelectionHighlights, releaseHighlightIds } =
    useChatHighlightSession({
      conversationId: currentConversationId,
      containerRef,
      inputMentionables: inputMessage.mentionables,
      focusedHistoricalMentionables,
    })

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

  const chatUserInputRefs = useRef<Map<string, ChatUserInputRef>>(new Map())
  const chatMessagesRef = useRef<HTMLDivElement>(null)
  const bottomAnchorRef = useRef<HTMLDivElement>(null)
  // Callback-ref + state for the overlay element. A plain useRef with a
  // mount-once effect would lose its observation when the chat view unmounts
  // (e.g. switching to the composer view and back), since the new overlay
  // element never re-binds. Driving the measurement effect off element state
  // ensures attach/detach cleanly drive observer setup/teardown.
  const [inputOverlayElement, setInputOverlayElement] =
    useState<HTMLDivElement | null>(null)
  const [inputOverlayHeight, setInputOverlayHeight] = useState(0)
  const [timelineIsVirtualized, setTimelineIsVirtualized] = useState(false)
  const [activeNavigatorMessageId, setActiveNavigatorMessageId] = useState<
    string | null
  >(null)
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
    notifyContentFlushed,
    forceScrollToBottom,
    stopAutoFollow,
    isAutoFollowEnabled,
    followOutput,
    onAtBottomStateChange,
  } = useAutoScroll({
    scrollContainerRef: chatMessagesRef,
    bottomAnchorRef,
    isStreaming: hasStreamingMessages,
    contentFollowMode: timelineIsVirtualized ? 'explicit' : 'observer',
  })
  const handleForceScrollToBottom = useCallback(() => {
    resetToLatest()
    requestAnimationFrame(() => {
      forceScrollToBottom()
    })
  }, [forceScrollToBottom, resetToLatest])
  const handleNavigateToUserMessage = useCallback(
    (messageId: string) => {
      setActiveNavigatorMessageId(messageId)
      stopAutoFollow()
      jumpToUserMessage(messageId)
    },
    [jumpToUserMessage, stopAutoFollow],
  )

  // Measure the overlay above the input box so the timeline can reserve
  // equivalent scrollable space at its bottom — keeps the last assistant
  // message's metadata bar reachable instead of hidden behind the overlay.
  // The overlay element is always rendered; height collapses to 0 when no
  // todo/queued content is present. The gap between overlay bottom and the
  // input top (CSS `bottom: calc(100% + var(--size-2-1))`) is included.
  useLayoutEffect(() => {
    if (!inputOverlayElement) {
      // Element detached (e.g. switched to composer view). Reset budget so
      // the timeline doesn't keep reserving phantom space.
      setInputOverlayHeight(0)
      return
    }

    let animationFrameId: number | null = null

    const computeOverlayBudget = (): number => {
      // offsetHeight already snaps to the integer pixel; 0 when empty.
      const height = inputOverlayElement.offsetHeight
      if (height <= 0) {
        return 0
      }
      const gap = parseFloat(
        getComputedStyle(inputOverlayElement).getPropertyValue('--size-2-1'),
      )
      const gapPx = Number.isFinite(gap) && gap > 0 ? gap : 4
      return Math.ceil(height + gapPx)
    }

    const publishHeight = () => {
      const nextHeight = computeOverlayBudget()
      setInputOverlayHeight((previous) =>
        previous === nextHeight ? previous : nextHeight,
      )
    }

    publishHeight()

    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(() => {
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId)
      }
      animationFrameId = requestAnimationFrame(() => {
        animationFrameId = null
        publishHeight()
      })
    })
    observer.observe(inputOverlayElement)

    return () => {
      observer.disconnect()
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId)
      }
    }
  }, [inputOverlayElement])

  // When the overlay height changes (todo expand/collapse, queued bubbles
  // appear/disappear), the scroll geometry shifts. If we are in auto-follow,
  // re-anchor to the new bottom so the metadata bar stays visible above the
  // overlay; otherwise leave the user's reading position alone.
  useEffect(() => {
    if (!isAutoFollowEnabled) {
      return
    }
    notifyContentFlushed()
  }, [inputOverlayHeight, isAutoFollowEnabled, notifyContentFlushed])

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
    conversationOverrides: conversationOverrides ?? undefined,
    modelId: conversationModelId,
    chatMode,
    currentFileOverride,
    currentFileViewState: activeViewState,
    assistantIdOverride: conversationAssistantId,
    compaction: effectiveCompactionState,
  })
  const [runSummariesByConversationId, setRunSummariesByConversationId] =
    useState<Map<string, AgentConversationRunSummary>>(new Map())
  const [queuedUserMessages, setQueuedUserMessages] = useState<
    ChatUserMessage[]
  >(() => agentService.peekPendingUserMessages(currentConversationId))
  const isCurrentConversationRunActive = currentConversationRunSummary.isActive
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

  const terminalCommandResultsByToolCallId = useMemo(() => {
    const map = new Map<string, ChatTerminalCommandResultMessage>()
    for (const message of chatMessages) {
      if (
        message.role !== 'terminal_command_result' ||
        !message.delegateToolCallId
      ) {
        continue
      }
      map.set(message.delegateToolCallId, message)
    }
    return map
  }, [chatMessages])
  const subagentResultsByToolCallId = useMemo(() => {
    const map = new Map<string, ChatSubagentResultMessage>()
    for (const message of chatMessages) {
      if (message.role !== 'subagent_result' || !message.delegateToolCallId) {
        continue
      }
      map.set(message.delegateToolCallId, message)
    }
    return map
  }, [chatMessages])
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
        setInputMessage((prev) => ({
          ...prev,
          content: latest.content,
          promptContent: latest.promptContent,
          snapshotRef: latest.snapshotRef,
          mentionables: latest.mentionables,
          selectedSkills: latest.selectedSkills,
          selectedModelIds: latest.selectedModelIds,
          reasoningLevel: latest.reasoningLevel ?? prev.reasoningLevel,
          // 该消息从未真正发送出去 → 清掉入队时打的旧时间,下次提交会重新打戳。
          timeContext: undefined,
        }))
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
  }, [agentService, currentConversationId, releaseHighlightIds, t])

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
      conversationModelId,
      conversationOverrides,
      createOrUpdateConversation,
      currentConversationId,
      effectiveCompactionState,
      reasoningLevel,
      normalizeAssistantGroupBoundaryMessageIds,
      assistantGroupBoundaryMessageIds,
      serializeMessageModelMap,
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
      conversationModelId,
      conversationOverrides,
      createOrUpdateConversationImmediately,
      currentConversationId,
      effectiveCompactionState,
      reasoningLevel,
      normalizeAssistantGroupBoundaryMessageIds,
      assistantGroupBoundaryMessageIds,
      serializeMessageModelMap,
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
        prev === messageId ? inputMessage.id : prev,
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
      inputMessage.id,
      persistConversation,
      releaseHighlightIds,
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
    [normalizeAssistantGroupBoundaryMessageIds],
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
    [isUserMessageEffectivelyEmpty, removeHistoricalUserMessage],
  )

  const handleManualContextCompaction = useCallback(async () => {
    if (currentConversationRunSummary.isWaitingApproval) {
      new Notice(
        t(
          'chat.compaction.waitingApproval',
          '请先处理当前待确认的工具调用，再压缩上下文。',
        ),
      )
      return
    }

    if (currentConversationRunSummary.isActive) {
      new Notice(
        t('chat.compaction.runActive', '请等待当前回复完成后再压缩上下文。'),
      )
      return
    }

    if (chatMessages.length === 0) {
      new Notice(t('chat.compaction.empty', '当前还没有可压缩的对话内容。'))
      return
    }

    try {
      setPendingCompactionAnchorMessageId(chatMessages.at(-1)?.id ?? null)
      const nextCompactionState = await compactConversation(chatMessages)
      setPendingCompactionAnchorMessageId(null)

      if (!nextCompactionState) {
        new Notice(t('chat.compaction.empty', '当前还没有可压缩的对话内容。'))
        return
      }

      const nextCompactionHistory = [
        ...effectiveCompactionState,
        nextCompactionState,
      ]

      plugin
        .getAgentService()
        .replaceConversationMessages(
          currentConversationId,
          chatMessages,
          nextCompactionHistory,
        )

      const effectiveOverrides = {
        ...(conversationOverrides ?? {}),
        chatMode,
      }
      await createOrUpdateConversationImmediately(
        currentConversationId,
        chatMessages,
        effectiveOverrides,
        conversationModelId,
        serializeMessageModelMap(chatMessages),
        serializeActiveBranchByUserMessageId(
          chatMessages,
          activeBranchByUserMessageIdRef.current,
        ),
        conversationReasoningLevelRef.current.get(currentConversationId) ??
          reasoningLevel,
        nextCompactionHistory,
        normalizeAssistantGroupBoundaryMessageIds(
          chatMessages,
          assistantGroupBoundaryMessageIds,
        ),
      )
      new Notice(
        t(
          'chat.compaction.success',
          '已压缩较早上下文，后续回复将基于摘要继续。',
        ),
      )
    } catch (error) {
      setPendingCompactionAnchorMessageId(null)
      new Notice(t('chat.compaction.failed', '上下文压缩失败，请稍后重试。'))
      console.error('Failed to compact conversation context', error)
    }
  }, [
    chatMessages,
    chatMode,
    compactConversation,
    conversationModelId,
    conversationOverrides,
    createOrUpdateConversationImmediately,
    currentConversationId,
    currentConversationRunSummary.isActive,
    currentConversationRunSummary.isWaitingApproval,
    effectiveCompactionState,
    plugin,
    reasoningLevel,
    assistantGroupBoundaryMessageIds,
    normalizeAssistantGroupBoundaryMessageIds,
    serializeMessageModelMap,
    t,
  ])

  const registerChatUserInputRef = (
    id: string,
    ref: ChatUserInputRef | null,
  ) => {
    if (ref) {
      chatUserInputRefs.current.set(id, ref)
    } else {
      chatUserInputRefs.current.delete(id)
    }
  }

  useEffect(() => {
    if (!focusedMessageId || focusedMessageId === inputMessage.id) {
      suppressNextHistoricalUserMessageOutsidePointerRef.current = null
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }

      if (target.closest('.yolo-popover-surface')) {
        return
      }

      const activeMessageElement = chatMessagesRef.current?.querySelector(
        `[data-user-message-id="${focusedMessageId}"]`,
      )
      if (activeMessageElement?.contains(target)) {
        return
      }

      if (
        suppressNextHistoricalUserMessageOutsidePointerRef.current ===
        focusedMessageId
      ) {
        suppressNextHistoricalUserMessageOutsidePointerRef.current = null
        return
      }

      finalizeHistoricalUserMessageEdit(focusedMessageId)
      setFocusedMessageId(inputMessage.id)
    }

    const doc = chatMessagesRef.current?.ownerDocument ?? document
    doc.addEventListener('pointerdown', handlePointerDown, true)
    return () => {
      doc.removeEventListener('pointerdown', handlePointerDown, true)
    }
  }, [finalizeHistoricalUserMessageEdit, focusedMessageId, inputMessage.id])

  const handleLoadConversation = useCallback(
    async (conversationId: string) => {
      try {
        const conversation = await getConversationById(conversationId)
        if (!conversation) {
          throw new Error('Conversation not found')
        }
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
        if (conversation.overrides) {
          conversationOverridesRef.current.set(
            conversationId,
            conversation.overrides,
          )
        }
        const modelFromRef =
          conversation.conversationModelId ??
          conversationModelIdRef.current.get(conversationId) ??
          loadedAssistantModelId ??
          settings.chatModelId
        setConversationModelId(modelFromRef)
        conversationModelIdRef.current.set(conversationId, modelFromRef)
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
        const preservedInput = inputMessageRef.current
        const newInputMessage = getNewInputMessage(resolvedReasoningLevel)
        newInputMessage.content = preservedInput.content
        newInputMessage.mentionables = [...preservedInput.mentionables]
        setInputMessage(newInputMessage)
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
      }
    },
    [
      getConversationById,
      createOrUpdateConversationImmediately,
      plugin,
      settings.chatModelId,
      settings.currentAssistantId,
      settings.chatOptions.chatMode,
      settings.assistants,
      getReasoningLevelForModelId,
      normalizeAssistantGroupBoundaryMessageIds,
      normalizeReasoningLevel,
    ],
  )

  // Load an initial conversation passed in via props (e.g., from Quick Ask)
  useEffect(() => {
    if (!props.initialConversationId) return
    void handleLoadConversation(props.initialConversationId)
  }, [handleLoadConversation, props.initialConversationId])

  useEffect(() => {
    props.onConversationContextChange?.({
      currentConversationId,
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
    conversationModelId,
    conversationOverrides,
    currentConversationId,
    props.onConversationContextChange,
  ])

  // 把当前可重建态实时上报给 ChatView，供 host DOM 被替换（pop-out / dock back）
  // 时无缝重建 React tree。仅副作用：上报快照；不要在这里改 state。
  const onRuntimeSnapshotChange = props.onRuntimeSnapshotChange
  useEffect(() => {
    if (!onRuntimeSnapshotChange) return
    onRuntimeSnapshotChange({
      currentConversationId,
      inputMessage,
      conversationModelId,
      conversationAssistantId,
      chatMode,
      reasoningLevel,
      conversationOverrides,
    })
  }, [
    onRuntimeSnapshotChange,
    currentConversationId,
    inputMessage,
    conversationModelId,
    conversationAssistantId,
    chatMode,
    reasoningLevel,
    conversationOverrides,
  ])

  const handleExportChatToVault = useCallback(
    (conversationId: string) => {
      void (async () => {
        try {
          const { path } = await exportChatConversationToVault({
            app,
            chatManager,
            conversationId,
            settings,
          })
          new Notice(
            t('sidebar.chat.exportSuccess', 'Exported chat to {path}').replace(
              '{path}',
              path,
            ),
          )
        } catch (error) {
          console.error('Failed to export conversation', error)
          new Notice(
            t('sidebar.chat.exportError', 'Could not export conversation'),
          )
        }
      })()
    },
    [app, chatManager, settings, t],
  )

  const handleNewChat = (selectedBlock?: MentionableBlockData) => {
    const newId = uuidv4()
    setCurrentConversationId(newId)
    conversationAssistantIdRef.current.set(newId, conversationAssistantId)
    setConversationAssistantId(conversationAssistantId)
    setConversationOverrides(null)
    const defaultChatMode = chatMode
    setChatMode(defaultChatMode)
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
    const newInputMessage = getNewInputMessage(defaultReasoningLevel)
    newInputMessage.content = inputMessage.content
    newInputMessage.mentionables = [...inputMessage.mentionables]
    if (selectedBlock) {
      const mentionableBlock = createSelectionBlockMentionable(selectedBlock)
      newInputMessage.mentionables = [
        ...newInputMessage.mentionables,
        mentionableBlock,
      ]
    }
    setAddedBlockKey(null)
    setInputMessage(newInputMessage)
    setFocusedMessageId(newInputMessage.id)
    setQueryProgress({
      type: 'idle',
    })
  }

  const handleAssistantMessageEditSave = useCallback(
    (messageId: string, content: string) => {
      setChatMessages((prevChatHistory) => {
        const nextMessages = prevChatHistory.map((message) =>
          message.role === 'assistant' && message.id === messageId
            ? {
                ...message,
                content,
              }
            : message,
        )
        void persistConversation(nextMessages)
        return nextMessages
      })
      setEditingAssistantMessageId(null)
    },
    [persistConversation],
  )

  const handleAssistantMessageEditCancel = useCallback(() => {
    setEditingAssistantMessageId(null)
  }, [])

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
        prev && removedIds.has(prev) ? inputMessage.id : prev,
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
      inputMessage.id,
      isCurrentConversationRunActive,
      normalizeAssistantGroupBoundaryMessageIds,
      persistConversation,
      releaseHighlightIds,
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

      const newInputMessage = getNewInputMessage(resolvedReasoningLevel)
      setInputMessage(newInputMessage)
      setFocusedMessageId(newInputMessage.id)
      setQueryProgress({ type: 'idle' })

      void (async () => {
        await createOrUpdateConversationImmediately(
          newConversationId,
          nextMessages,
          {
            ...(nextOverrides ?? {}),
            chatMode: nextChatMode,
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
      settings.chatModelId,
      t,
      updateConversationTitle,
    ],
  )

  const resolveReasoningLevelForMessages = useCallback(
    (messages: ChatMessage[]) => {
      const lastUserMessage = [...messages]
        .reverse()
        .find((message): message is ChatUserMessage => message.role === 'user')
      const storedLevel = normalizeReasoningLevel(
        lastUserMessage?.reasoningLevel,
      )
      return storedLevel ?? reasoningLevel
    },
    [normalizeReasoningLevel, reasoningLevel],
  )

  const handleRecoverPendingToolCall = useCallback(
    async ({
      conversationId,
      toolMessageId,
      request,
      allowForConversation = false,
    }: {
      conversationId: string
      toolMessageId: string
      request: ToolCallRequest
      allowForConversation?: boolean
    }): Promise<boolean> => {
      if (conversationId !== currentConversationId) {
        return false
      }

      const sourceMessages = chatMessagesStateRef.current
      const toolMessageIndex = sourceMessages.findIndex(
        (message) => message.role === 'tool' && message.id === toolMessageId,
      )
      if (toolMessageIndex === -1) {
        return false
      }

      const toolMessage = sourceMessages[toolMessageIndex]
      if (toolMessage.role !== 'tool') {
        return false
      }

      const targetToolCall = toolMessage.toolCalls.find(
        (toolCall) => toolCall.request.id === request.id,
      )
      if (
        !targetToolCall ||
        targetToolCall.response.status !==
          ToolCallResponseStatus.PendingApproval
      ) {
        return false
      }

      const applyMessages = (nextMessages: ChatMessage[]) => {
        setChatMessages(nextMessages)
        chatMessagesStateRef.current = nextMessages
        plugin
          .getAgentService()
          .replaceConversationMessages(
            conversationId,
            nextMessages,
            effectiveCompactionState,
            { persistState: true },
          )
      }

      const runningMessages = updateToolCallResponseInMessages({
        messages: sourceMessages,
        toolMessageId,
        toolCallId: request.id,
        response: { status: ToolCallResponseStatus.Running },
      })
      applyMessages(runningMessages)

      const foregroundToolAbortController = new AbortController()
      let unregisterForegroundToolAborter: (() => void) | null = null
      try {
        const mcpManager = await getMcpManager()
        const args = getToolCallArgumentsObject(request.arguments)
        unregisterForegroundToolAborter = plugin
          .getAgentService()
          .registerForegroundToolAborter({
            conversationId,
            toolCallId: request.id,
            abort: () => {
              foregroundToolAbortController.abort()
              mcpManager.abortToolCall(request.id)
            },
          })

        if (allowForConversation) {
          mcpManager.allowToolForConversation(
            request.name,
            conversationId,
            args,
          )
        }

        if (foregroundToolAbortController.signal.aborted) {
          return true
        }

        const result = await captureLLMDebugOperation({
          traceId: findDebugTraceIdForToolCall(runningMessages, request.id),
          transportMode: 'mcp',
          url: `mcp://${request.name}`,
          method: 'callTool',
          requestBody: {
            name: request.name,
            args,
            id: request.id,
            conversationId,
            roundId: toolMessageId,
            chatModelId:
              toolMessage.metadata?.branchModelId ?? conversationModelId,
          },
          responseContentType: 'application/json',
          run: () =>
            mcpManager.callTool({
              name: request.name,
              args,
              id: request.id,
              signal: foregroundToolAbortController.signal,
              conversationId,
              conversationMessages: runningMessages,
              roundId: toolMessageId,
              // Pass the model that produced this tool call (recorded as
              // branchModelId on the tool message when the LLM turn ran), not
              // the current conversation model. The user may have switched
              // models before approving it, so capability-gated resolution must
              // match the schema used when the call was emitted.
              chatModelId:
                toolMessage.metadata?.branchModelId ?? conversationModelId,
              workspaceScope: isAgentChatMode(chatMode)
                ? selectedAssistant?.workspaceScope
                : undefined,
              subagentParentContext: isDelegateSubagentToolName(request.name)
                ? plugin
                    .getAgentService()
                    .getPendingApprovalSubagentParentContext(conversationId)
                : undefined,
            }),
          getResponseBody: (response) => response,
        })

        if (foregroundToolAbortController.signal.aborted) {
          return true
        }

        const resolvedMessages = updateToolCallResponseInMessages({
          messages: chatMessagesStateRef.current,
          toolMessageId,
          toolCallId: request.id,
          response: result,
        })
        applyMessages(resolvedMessages)
        await persistConversationImmediately(resolvedMessages)

        const latestToolMessage = resolvedMessages.find(
          (message) => message.role === 'tool' && message.id === toolMessageId,
        )
        if (
          toolMessageIndex === resolvedMessages.length - 1 &&
          latestToolMessage?.role === 'tool' &&
          latestToolMessage.toolCalls.every((toolCall) =>
            [
              ToolCallResponseStatus.Success,
              ToolCallResponseStatus.Error,
            ].includes(toolCall.response.status),
          )
        ) {
          submitChatMutation.mutate({
            chatMessages: resolvedMessages,
            conversationId,
            reasoningLevel: resolveReasoningLevelForMessages(resolvedMessages),
            modelIds: getLatestUserSelectedModelIds(resolvedMessages),
          })
        }

        return true
      } catch (error) {
        if (foregroundToolAbortController.signal.aborted) {
          return true
        }

        const errorMessage =
          error instanceof Error ? error.message : 'Tool call failed'
        const failedMessages = updateToolCallResponseInMessages({
          messages: chatMessagesStateRef.current,
          toolMessageId,
          toolCallId: request.id,
          response: {
            status: ToolCallResponseStatus.Error,
            error: errorMessage,
          },
        })
        applyMessages(failedMessages)
        await persistConversationImmediately(failedMessages)
        console.error('[YOLO] Failed to recover pending tool call', {
          conversationId,
          toolCallId: request.id,
          error,
        })
        return true
      } finally {
        unregisterForegroundToolAborter?.()
      }
    },
    [
      currentConversationId,
      effectiveCompactionState,
      getMcpManager,
      persistConversationImmediately,
      plugin,
      resolveReasoningLevelForMessages,
      submitChatMutation,
    ],
  )

  /**
   * Recovery path for ask_user_question: the service has already committed
   * the user's answers to the persisted tool message but no live run remains
   * (the conversation finalized before the user answered). Mirror the tail
   * of handleRecoverPendingToolCall — persist immediately and kick off a
   * fresh submit so the agent loop resumes from the resolved messages.
   */
  const handleRecoverAnswerUserQuestion = useCallback(
    ({
      resolvedMessages,
      toolCallId: _toolCallId,
    }: {
      resolvedMessages: ChatMessage[]
      toolCallId: string
    }) => {
      const conversationId = currentConversationId
      setChatMessages(resolvedMessages)
      chatMessagesStateRef.current = resolvedMessages
      plugin
        .getAgentService()
        .replaceConversationMessages(
          conversationId,
          resolvedMessages,
          effectiveCompactionState,
          { persistState: true },
        )
      void persistConversationImmediately(resolvedMessages)
      submitChatMutation.mutate({
        chatMessages: resolvedMessages,
        conversationId,
        reasoningLevel: resolveReasoningLevelForMessages(resolvedMessages),
        modelIds: getLatestUserSelectedModelIds(resolvedMessages),
      })
    },
    [
      currentConversationId,
      effectiveCompactionState,
      persistConversationImmediately,
      plugin,
      resolveReasoningLevelForMessages,
      setChatMessages,
      submitChatMutation,
    ],
  )

  const buildInputMessageForSubmit = useCallback(
    (content: ChatUserMessage['content']): ChatUserMessage => {
      const mentionables = inputMessage.mentionables
      return {
        ...inputMessage,
        content,
        reasoningLevel,
        mentionables,
        selectedSkills: inputMessage.selectedSkills ?? [],
        selectedModelIds: extractSelectedModelIds(mentionables),
      }
    },
    [inputMessage, reasoningLevel],
  )

  const handleUserMessageSubmit = useCallback(
    async ({
      inputChatMessages,
      requestChatMessages,
      retryBranchTarget,
      persistedMessageModelMap,
    }: {
      inputChatMessages: ChatMessage[]
      requestChatMessages?: ChatMessage[]
      retryBranchTarget?: {
        branchId: string
        sourceUserMessageId: string
        branchModelId?: string
        branchLabel?: string
      }
      persistedMessageModelMap?: Map<string, string>
    }) => {
      abortConversationRun(currentConversationId)
      setQueryProgress({
        type: 'idle',
      })

      const compactionForSubmit = effectiveCompactionState

      // Update the chat history to show the new user message
      setChatMessages(inputChatMessages)
      requestAnimationFrame(() => {
        forceScrollToBottom()
      })

      const effectiveRequestChatMessages =
        requestChatMessages ?? inputChatMessages
      const lastMessage = effectiveRequestChatMessages.at(-1)
      if (lastMessage?.role !== 'user') {
        throw new Error('Last message is not a user message')
      }

      const compiledRequestMessages = await Promise.all(
        effectiveRequestChatMessages.map(async (message) => {
          if (message.role === 'user' && message.id === lastMessage.id) {
            const { promptContent } =
              await requestContextBuilder.compileUserMessagePrompt({
                message,
                onQueryProgressChange: setQueryProgress,
              })
            return {
              ...message,
              promptContent,
            }
          } else if (message.role === 'user' && !message.promptContent) {
            const { promptContent } =
              await requestContextBuilder.compileUserMessagePrompt({
                message,
              })
            return {
              ...message,
              promptContent,
            }
          }
          return message
        }),
      )

      const compiledUserMessagesById = new Map(
        compiledRequestMessages
          .filter(
            (message): message is ChatUserMessage => message.role === 'user',
          )
          .map((message) => [message.id, message]),
      )

      const compiledInputMessages = inputChatMessages.map((message) => {
        if (message.role !== 'user') {
          return message
        }

        const compiledUserMessage = compiledUserMessagesById.get(message.id)
        return compiledUserMessage
          ? {
              ...message,
              promptContent: compiledUserMessage.promptContent,
            }
          : message
      })

      const persistedMessages = compiledInputMessages.map((message) => {
        if (message.role !== 'user') {
          return message
        }
        if (!message.promptContent) {
          return message
        }
        return {
          ...message,
          promptContent: null,
        }
      })

      setChatMessages(persistedMessages)
      plugin
        .getAgentService()
        .replaceConversationMessages(
          currentConversationId,
          persistedMessages,
          compactionForSubmit,
        )
      setCompactionState(compactionForSubmit)
      void createOrUpdateConversation(
        currentConversationId,
        compiledInputMessages,
        {
          ...(conversationOverrides ?? {}),
          chatMode,
        },
        conversationModelId,
        serializeMessageModelMap(
          compiledInputMessages,
          persistedMessageModelMap ?? messageModelMap,
        ),
        serializeActiveBranchByUserMessageId(
          compiledInputMessages,
          activeBranchByUserMessageIdRef.current,
        ),
        conversationReasoningLevelRef.current.get(currentConversationId) ??
          reasoningLevel,
        compactionForSubmit,
        normalizeAssistantGroupBoundaryMessageIds(
          compiledInputMessages,
          assistantGroupBoundaryMessageIds,
        ),
      )
      void generateConversationTitle(
        currentConversationId,
        compiledInputMessages,
      )
      const requestReasoningLevel = resolveReasoningLevelForMessages(
        compiledRequestMessages,
      )
      const requestModelIds =
        lastMessage.selectedModelIds && lastMessage.selectedModelIds.length > 0
          ? lastMessage.selectedModelIds
          : undefined
      submitChatMutation.mutate({
        chatMessages: compiledInputMessages,
        requestMessages: compiledRequestMessages,
        conversationId: currentConversationId,
        reasoningLevel: requestReasoningLevel,
        modelIds: requestModelIds,
        branchTarget: retryBranchTarget,
        compactionOverride: compactionForSubmit,
      })
    },
    [
      submitChatMutation,
      currentConversationId,
      conversationModelId,
      conversationOverrides,
      requestContextBuilder,
      abortConversationRun,
      activeBranchByUserMessageIdRef,
      forceScrollToBottom,
      assistantGroupBoundaryMessageIds,
      createOrUpdateConversation,
      effectiveCompactionState,
      generateConversationTitle,
      chatMode,
      messageModelMap,
      normalizeAssistantGroupBoundaryMessageIds,
      reasoningLevel,
      resolveReasoningLevelForMessages,
      serializeMessageModelMap,
      plugin,
    ],
  )

  const handleAssistantMessageGroupRetry = useCallback(
    (messageIds: string[]) => {
      const retryPayload = buildRetrySubmissionMessages({
        sourceMessages: chatMessagesStateRef.current,
        groupedChatMessages,
        targetMessageIds: messageIds,
        activeBranchByUserMessageId,
      })

      if (!retryPayload) {
        new Notice(
          t('chat.regenerateFailed', 'Failed to regenerate this reply'),
        )
        return
      }

      const {
        sourceUserMessageId,
        inputChatMessages,
        requestChatMessages,
        branchTarget,
      } = retryPayload
      const nextAssistantGroupBoundaryMessageIds =
        normalizeAssistantGroupBoundaryMessageIds(
          inputChatMessages,
          assistantGroupBoundaryMessageIds,
        )

      setAssistantGroupBoundaryMessageIds(nextAssistantGroupBoundaryMessageIds)

      const nextActiveBranchByUserMessageId = new Map(
        activeBranchByUserMessageIdRef.current,
      )
      if (branchTarget) {
        nextActiveBranchByUserMessageId.set(
          sourceUserMessageId,
          branchTarget.branchId,
        )
      } else {
        nextActiveBranchByUserMessageId.delete(sourceUserMessageId)
      }
      activeBranchByUserMessageIdRef.current = nextActiveBranchByUserMessageId
      setActiveBranchByUserMessageId(nextActiveBranchByUserMessageId)

      void handleUserMessageSubmit({
        inputChatMessages,
        requestChatMessages,
        retryBranchTarget: branchTarget
          ? {
              ...branchTarget,
              sourceUserMessageId,
            }
          : undefined,
      })
    },
    [
      activeBranchByUserMessageId,
      assistantGroupBoundaryMessageIds,
      groupedChatMessages,
      handleUserMessageSubmit,
      normalizeAssistantGroupBoundaryMessageIds,
      t,
    ],
  )

  const applyMutation = useMutation({
    mutationFn: async ({
      blockToApply,
      targetFilePath,
      abortSignal,
    }: {
      blockToApply: string
      targetFilePath?: string
      abortSignal?: AbortSignal
    }) => {
      if (abortSignal?.aborted) {
        throw new DOMException('Apply aborted', 'AbortError')
      }

      const targetFile = targetFilePath
        ? app.vault.getFileByPath(targetFilePath)
        : app.workspace.getActiveFile()
      if (!targetFile) {
        throw new Error(
          'No file is currently open to apply changes. Please open a file and try again.',
        )
      }
      const targetFileContent = await readTFileContent(targetFile, app.vault)
      const plan = parseTextEditPlan(blockToApply, {
        requireDocumentType: true,
      })

      if (!plan) {
        throw new Error('当前内容不包含可应用的编辑计划。')
      }

      const materialized = materializeTextEditPlan({
        content: targetFileContent,
        plan,
      })

      if (materialized.errors.length > 0) {
        console.warn('[Chat Apply] Some planned edits failed during apply.', {
          filePath: targetFile.path,
          errors: materialized.errors,
        })
      }

      if (materialized.appliedCount === 0) {
        console.error('[Chat Apply] Edit plan did not produce changes.', {
          filePath: targetFile.path,
          operationCount: materialized.totalOperations,
          errors: materialized.errors,
        })
        throw new Error('当前编辑计划未匹配到可修改内容，请重新生成。')
      }

      const selectionRange = getInlineSelectionRange(
        targetFileContent,
        materialized.operationResults,
      )

      if (settings.chatOptions.chatApplyMode === 'direct-apply') {
        await app.vault.modify(targetFile, materialized.newContent)

        if (materialized.errors.length > 0) {
          const partialMessage = t(
            'quickAsk.editPartialSuccess',
            '已应用 {appliedCount}/{totalEdits} 个编辑，详情请查看控制台',
          )
            .replace('{appliedCount}', String(materialized.appliedCount))
            .replace('{totalEdits}', String(materialized.totalOperations))
          new Notice(partialMessage)
        }

        const updatedRanges = materialized.operationResults
          .map((result) => result.newRange)
          .filter((range): range is NonNullable<typeof range> => Boolean(range))
        const editorView = getEditorViewForFile(targetFile)
        if (editorView && updatedRanges.length > 0) {
          const isEditorSynced = await waitForEditorContentSync(
            editorView,
            materialized.newContent,
          )

          if (isEditorSynced) {
            selectionHighlightController.highlightRanges(
              editorView,
              updatedRanges.map((range) => ({
                from: range.start,
                to: range.end,
                visual: 'updated' as const,
              })),
              1050,
            )
          }
        }
        return
      }

      await plugin.openApplyReview({
        file: targetFile,
        originalContent: targetFileContent,
        newContent: materialized.newContent,
        reviewMode: selectionRange ? 'selection-focus' : 'full',
        selectionRange,
      } satisfies ApplyViewState)
    },
    onError: (error) => {
      if (
        (error instanceof Error && error.name === 'AbortError') ||
        (error instanceof Error && /abort/i.test(error.message))
      ) {
        return
      }
      if (error instanceof Error) {
        new Notice(error.message)
        console.error('Failed to apply changes', error)
        return
      }
      new Notice('Failed to apply changes')
      console.error('Failed to apply changes', error)
    },
    onSettled: () => {
      applyAbortControllerRef.current = null
      setActiveApplyRequestKey(null)
    },
  })

  const handleApply = useCallback(
    (
      blockToApply: string,
      applyRequestKey: string,
      targetFilePath?: string,
    ) => {
      if (applyMutation.isPending) {
        if (activeApplyRequestKey === applyRequestKey) {
          applyAbortControllerRef.current?.abort()
          applyAbortControllerRef.current = null
          setActiveApplyRequestKey(null)
        }
        return
      }

      const abortController = new AbortController()
      applyAbortControllerRef.current = abortController
      setActiveApplyRequestKey(applyRequestKey)
      applyMutation.mutate({
        blockToApply,
        targetFilePath,
        abortSignal: abortController.signal,
      })
    },
    [activeApplyRequestKey, applyMutation],
  )

  const handleUndoEditSummary = useCallback(
    async (summary: GroupEditSummary) => {
      if (!currentConversationId) {
        return
      }

      const summaryKey = summary.entries
        .map((entry) => entry.toolCallId)
        .join(':')
      const targetKey =
        summary.files.length === 1
          ? `${summaryKey}::${summary.files[0]?.path ?? 'all'}`
          : `${summaryKey}::all`
      setUndoingEditSummaryTarget(targetKey)

      try {
        const undoStateByPath = new Map<string, 'applied' | 'unavailable'>()

        for (const fileGroup of summary.files) {
          const [firstSnapshot, latestSnapshot] = await Promise.all([
            readEditReviewSnapshot({
              app,
              conversationId: currentConversationId,
              roundId: fileGroup.firstRoundId,
              filePath: fileGroup.path,
              settings,
            }),
            readEditReviewSnapshot({
              app,
              conversationId: currentConversationId,
              roundId: fileGroup.latestRoundId,
              filePath: fileGroup.path,
              settings,
            }),
          ])

          if (!firstSnapshot || !latestSnapshot) {
            undoStateByPath.set(fileGroup.path, 'unavailable')
            continue
          }

          const targetFile = app.vault.getAbstractFileByPath(fileGroup.path)
          const currentFile = targetFile instanceof TFile ? targetFile : null

          if (latestSnapshot.afterExists) {
            if (!currentFile) {
              undoStateByPath.set(fileGroup.path, 'unavailable')
              continue
            }

            const currentContent = await app.vault.read(currentFile)
            if (currentContent !== latestSnapshot.afterContent) {
              undoStateByPath.set(fileGroup.path, 'unavailable')
              continue
            }
          } else if (targetFile) {
            undoStateByPath.set(fileGroup.path, 'unavailable')
            continue
          }

          undoStateByPath.set(fileGroup.path, 'applied')

          if (!firstSnapshot.beforeExists) {
            if (currentFile) {
              await app.fileManager.trashFile(currentFile)
            }
            continue
          }

          if (currentFile) {
            const currentContent = await app.vault.read(currentFile)
            if (currentContent !== firstSnapshot.beforeContent) {
              await app.vault.modify(currentFile, firstSnapshot.beforeContent)
            }
            continue
          }

          const parentPath = fileGroup.path.split('/').slice(0, -1).join('/')
          if (parentPath.length > 0) {
            await ensureDirectoryPathExists(app, parentPath)
          }
          await app.vault.create(fileGroup.path, firstSnapshot.beforeContent)
        }

        const appliedCount = summary.files.filter(
          (file) => undoStateByPath.get(file.path) === 'applied',
        ).length
        const unavailableCount = summary.files.length - appliedCount

        const updatedMessages = chatMessages.map((message) => {
          if (message.role !== 'tool') {
            return message
          }

          let nextToolMessage = message
          summary.entries.forEach((entry) => {
            if (entry.toolMessageId !== message.id) {
              return
            }

            const nextFiles = entry.summary.files.map((file) => {
              const nextStatus =
                undoStateByPath.get(file.path) ?? file.undoStatus

              return {
                ...file,
                undoStatus: nextStatus,
              }
            })

            nextToolMessage = updateToolMessageEditSummary({
              toolMessage: nextToolMessage,
              toolCallId: entry.toolCallId,
              editSummary: {
                ...entry.summary,
                files: nextFiles,
                undoStatus: deriveToolEditUndoStatus(nextFiles),
              },
            })
          })

          return nextToolMessage
        })

        setChatMessages(updatedMessages)
        agentService.replaceConversationMessages(
          currentConversationId,
          updatedMessages,
        )
        await persistConversationImmediately(updatedMessages)

        if (appliedCount > 0 && unavailableCount === 0) {
          new Notice(
            t(
              'chat.editSummary.undoSuccess',
              '已撤销本轮 assistant 的文件修改。',
            ),
          )
        } else if (appliedCount > 0) {
          new Notice(
            t(
              'chat.editSummary.undoPartial',
              '部分文件已撤销，另一些文件因后续变更未覆盖。',
            ),
          )
        } else {
          new Notice(
            t(
              'chat.editSummary.undoUnavailable',
              '文件内容已变化，无法安全撤销本轮修改。',
            ),
          )
        }
      } catch (error) {
        new Notice(t('chat.editSummary.undoFailed', '撤销失败，请稍后重试。'))
        console.error('Failed to undo assistant edit summary', error)
      } finally {
        setUndoingEditSummaryTarget(null)
      }
    },
    [
      app,
      agentService,
      chatMessages,
      currentConversationId,
      persistConversationImmediately,
      settings,
      t,
    ],
  )

  const handleOpenEditSummaryFile = useCallback(
    async ({
      path,
      firstRoundId,
      latestRoundId,
    }: GroupEditSummary['files'][number]) => {
      const targetEntry = app.vault.getAbstractFileByPath(path)
      const targetFile = targetEntry instanceof TFile ? targetEntry : null

      if (!currentConversationId) {
        if (!targetFile) {
          new Notice(
            t('chat.editSummary.fileMissing', '文件不存在或已被移动。'),
          )
          return
        }
        const leaf = app.workspace.getLeaf(false)
        void leaf.openFile(targetFile)
        return
      }

      const [firstSnapshot, latestSnapshot] = await Promise.all([
        readEditReviewSnapshot({
          app,
          conversationId: currentConversationId,
          roundId: firstRoundId,
          filePath: path,
          settings,
        }),
        readEditReviewSnapshot({
          app,
          conversationId: currentConversationId,
          roundId: latestRoundId,
          filePath: path,
          settings,
        }),
      ])

      if (firstSnapshot && latestSnapshot) {
        if (!latestSnapshot.afterExists) {
          new Notice(
            t(
              'chat.editSummary.fileDeleted',
              '文件已被删除，可使用撤销进行恢复。',
            ),
          )
          return
        }

        if (!targetFile) {
          new Notice(
            t('chat.editSummary.fileMissing', '文件不存在或已被移动。'),
          )
          return
        }

        const currentContent = await app.vault.read(targetFile)
        if (currentContent !== latestSnapshot.afterContent) {
          const leaf = app.workspace.getLeaf(false)
          await leaf.openFile(targetFile)
          new Notice(
            t(
              'chat.editSummary.undoUnavailable',
              '文件内容已变化，无法安全撤销本轮修改。',
            ),
          )
          return
        }

        await plugin.openApplyReview({
          file: targetFile,
          originalContent: firstSnapshot.beforeContent,
          newContent: latestSnapshot.afterContent,
          viewMode: 'revert-review',
          reviewMode: 'full',
        })
        return
      }

      if (!targetFile) {
        new Notice(t('chat.editSummary.fileMissing', '文件不存在或已被移动。'))
        return
      }

      const leaf = app.workspace.getLeaf(false)
      await leaf.openFile(targetFile)
    },
    [app, app.vault, app.workspace, currentConversationId, plugin, settings, t],
  )

  const handleToolMessageUpdate = useCallback(
    (toolMessage: ChatToolMessage) => {
      const toolMessageIndex = chatMessages.findIndex(
        (message) => message.id === toolMessage.id,
      )
      if (toolMessageIndex === -1) {
        // The tool message no longer exists in the chat history.
        // This likely means a new message was submitted while this stream was running.
        // Abort the tool calls and keep the current chat history.
        void (async () => {
          const mcpManager = await getMcpManager()
          toolMessage.toolCalls.forEach((toolCall) => {
            mcpManager.abortToolCall(toolCall.request.id)
          })
        })()
        return
      }

      const updatedMessages = chatMessages.map((message) =>
        message.id === toolMessage.id ? toolMessage : message,
      )
      setChatMessages(updatedMessages)
      agentService.replaceConversationMessages(
        currentConversationId,
        updatedMessages,
      )

      // Resume the chat automatically if this tool message is the last message
      // and all tool calls have completed.
      if (
        toolMessageIndex === chatMessages.length - 1 &&
        toolMessage.toolCalls.every((toolCall) =>
          [
            ToolCallResponseStatus.Success,
            ToolCallResponseStatus.Error,
          ].includes(toolCall.response.status),
        )
      ) {
        // Using updated toolMessage directly because chatMessages state
        // still contains the old values
        submitChatMutation.mutate({
          chatMessages: updatedMessages,
          conversationId: currentConversationId,
          reasoningLevel: resolveReasoningLevelForMessages(updatedMessages),
          modelIds: getLatestUserSelectedModelIds(updatedMessages),
        })
        requestAnimationFrame(() => {
          forceScrollToBottom()
        })
      }
    },
    [
      chatMessages,
      currentConversationId,
      agentService,
      submitChatMutation,
      getMcpManager,
      forceScrollToBottom,
      resolveReasoningLevelForMessages,
    ],
  )

  const handleContinueResponse = useCallback(() => {
    const latestMessage = chatMessages.at(-1)
    submitChatMutation.mutate({
      chatMessages: chatMessages,
      conversationId: currentConversationId,
      reasoningLevel: resolveReasoningLevelForMessages(chatMessages),
      modelIds:
        latestMessage?.role === 'user'
          ? latestMessage.selectedModelIds
          : undefined,
    })
  }, [
    submitChatMutation,
    chatMessages,
    currentConversationId,
    resolveReasoningLevelForMessages,
  ])

  useEffect(() => {
    setFocusedMessageId(inputMessage.id)
  }, [inputMessage.id])

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

  const buildSelectionMentionable = useCallback(
    (selectedBlock: MentionableBlockData): MentionableBlock =>
      createSelectionBlockMentionable(selectedBlock),
    [],
  )

  const removeSelectionMentionable = useCallback(
    (mentionables: ChatUserMessage['mentionables']) =>
      mentionables.filter(
        (mentionable) => !isSyncSelectionMentionable(mentionable),
      ),
    [],
  )

  const syncSelectionMentionable = useCallback(
    (selectedBlock: MentionableBlockData) => {
      if (!focusedMessageId) return

      const mentionable = buildSelectionMentionable(selectedBlock)
      const mentionableKey = getMentionableKey(
        serializeMentionable(mentionable),
      )

      if (focusedMessageId === inputMessage.id) {
        setInputMessage((prevInputMessage) => {
          const existingSelection = prevInputMessage.mentionables.find((m) =>
            isSyncSelectionMentionable(m),
          )
          if (existingSelection) {
            const existingKey = getMentionableKey(
              serializeMentionable(existingSelection),
            )
            if (existingKey === mentionableKey) {
              return prevInputMessage
            }
          }
          const nextMentionables = [
            ...removeSelectionMentionable(prevInputMessage.mentionables),
            mentionable,
          ]
          return {
            ...prevInputMessage,
            mentionables: nextMentionables,
            promptContent: null,
          }
        })
        return
      }

      setChatMessages((prevChatHistory) =>
        prevChatHistory.map((message) => {
          if (message.id === focusedMessageId && message.role === 'user') {
            const existingSelection = message.mentionables.find((m) =>
              isSyncSelectionMentionable(m),
            )
            if (existingSelection) {
              const existingKey = getMentionableKey(
                serializeMentionable(existingSelection),
              )
              if (existingKey === mentionableKey) {
                return message
              }
            }
            return {
              ...message,
              mentionables: [
                ...removeSelectionMentionable(message.mentionables),
                mentionable,
              ],
              promptContent: null,
            }
          }
          return message
        }),
      )
    },
    [
      buildSelectionMentionable,
      focusedMessageId,
      inputMessage.id,
      removeSelectionMentionable,
    ],
  )

  const syncSelectionMentionableToInput = useCallback(
    (selectedBlock: MentionableBlockData) => {
      const mentionable = buildSelectionMentionable(selectedBlock)
      const mentionableKey = getMentionableKey(
        serializeMentionable(mentionable),
      )

      flushSync(() => {
        setInputMessage((prevInputMessage) => {
          const existingSelection = prevInputMessage.mentionables.find((m) =>
            isSyncSelectionMentionable(m),
          )
          if (existingSelection) {
            const existingKey = getMentionableKey(
              serializeMentionable(existingSelection),
            )
            if (existingKey === mentionableKey) {
              return prevInputMessage
            }
          }

          return {
            ...prevInputMessage,
            mentionables: [
              ...removeSelectionMentionable(prevInputMessage.mentionables),
              mentionable,
            ],
            promptContent: null,
          }
        })
      })
    },
    [buildSelectionMentionable, removeSelectionMentionable],
  )

  const syncWebSelectionMentionableToInput = useCallback(
    (selection: MentionableWebSelection) => {
      const mentionable: MentionableWebSelection = {
        ...selection,
        source: selection.source ?? 'web-selection-sync',
        contentHash:
          selection.contentHash ?? getBlockContentHash(selection.content),
      }
      const mentionableKey = getMentionableKey(
        serializeMentionable(mentionable),
      )

      flushSync(() => {
        setInputMessage((prevInputMessage) => {
          const existingSelection = prevInputMessage.mentionables.find((m) =>
            isSyncSelectionMentionable(m),
          )
          if (existingSelection) {
            const existingKey = getMentionableKey(
              serializeMentionable(existingSelection),
            )
            if (existingKey === mentionableKey) {
              return prevInputMessage
            }
          }

          return {
            ...prevInputMessage,
            mentionables: [
              ...removeSelectionMentionable(prevInputMessage.mentionables),
              mentionable,
            ],
            promptContent: null,
          }
        })
      })
    },
    [removeSelectionMentionable],
  )

  const upsertSelectionMentionableInMainInput = useCallback(
    (mentionable: MentionableBlock) => {
      setInputMessage((prevInputMessage) => {
        const mentionableKey = getMentionableKey(
          serializeMentionable(mentionable),
        )
        let changed = false
        const nextMentionables = prevInputMessage.mentionables.map((m) => {
          const key = getMentionableKey(serializeMentionable(m))
          if (key !== mentionableKey) return m
          if (m.type === 'block' && isSyncSelectionMentionable(m)) {
            changed = true
            return mentionable
          }
          return m
        })

        if (changed) {
          return {
            ...prevInputMessage,
            mentionables: nextMentionables,
            promptContent: null,
          }
        }

        if (
          prevInputMessage.mentionables.some(
            (m) =>
              getMentionableKey(serializeMentionable(m)) === mentionableKey,
          )
        ) {
          return prevInputMessage
        }

        return {
          ...prevInputMessage,
          mentionables: [...prevInputMessage.mentionables, mentionable],
          promptContent: null,
        }
      })
    },
    [],
  )

  const clearSelectionMentionable = useCallback(() => {
    if (!focusedMessageId) return

    if (focusedMessageId === inputMessage.id) {
      const nextMentionables = removeSelectionMentionable(
        inputMessageRef.current.mentionables,
      )
      releaseHighlightIds(
        collectRemovedSelectionHighlightIds(
          inputMessageRef.current.mentionables,
          nextMentionables,
        ),
      )
      setInputMessage((prevInputMessage) => {
        const nextMentionables = removeSelectionMentionable(
          prevInputMessage.mentionables,
        )
        if (nextMentionables.length === prevInputMessage.mentionables.length) {
          return prevInputMessage
        }
        return {
          ...prevInputMessage,
          mentionables: nextMentionables,
          promptContent: null,
        }
      })
      return
    }

    const focusedMessage = chatMessagesStateRef.current.find(
      (message): message is ChatUserMessage =>
        message.role === 'user' && message.id === focusedMessageId,
    )
    if (focusedMessage) {
      const nextMentionables = removeSelectionMentionable(
        focusedMessage.mentionables,
      )
      releaseHighlightIds(
        collectRemovedSelectionHighlightIds(
          focusedMessage.mentionables,
          nextMentionables,
        ),
      )
    }

    updateHistoricalUserMessage(focusedMessageId, (message) => {
      const nextMentionables = removeSelectionMentionable(message.mentionables)
      if (nextMentionables.length === message.mentionables.length) {
        return message
      }

      return {
        ...message,
        mentionables: nextMentionables,
        promptContent: null,
      }
    })
  }, [
    focusedMessageId,
    inputMessage.id,
    removeSelectionMentionable,
    releaseHighlightIds,
    updateHistoricalUserMessage,
  ])

  // 从所有消息中删除指定的 mentionable，并清空 promptContent 以便重新编译
  const handleMentionableDeleteFromAll = useCallback(
    (mentionable: ChatUserMessage['mentionables'][number]) => {
      const mentionableKey = getMentionableKey(
        serializeMentionable(mentionable),
      )

      // 从所有历史消息中删除
      const sourceMessages = chatMessagesStateRef.current
      const idsToRelease = new Set<string>()
      for (const message of sourceMessages) {
        if (message.role !== 'user') continue
        for (const id of collectSelectionHighlightIdsByMentionableKey(
          message.mentionables,
          mentionableKey,
        )) {
          idsToRelease.add(id)
        }
      }
      for (const id of collectSelectionHighlightIdsByMentionableKey(
        inputMessageRef.current.mentionables,
        mentionableKey,
      )) {
        idsToRelease.add(id)
      }
      releaseHighlightIds(idsToRelease)

      let didChangeHistory = false
      const nextMessages = sourceMessages.flatMap((message): ChatMessage[] => {
        if (message.role !== 'user') {
          return [message]
        }

        const filtered = message.mentionables.filter(
          (m) => getMentionableKey(serializeMentionable(m)) !== mentionableKey,
        )
        if (filtered.length === message.mentionables.length) {
          return [message]
        }
        didChangeHistory = true

        const nextMessage: ChatUserMessage = {
          ...message,
          mentionables: filtered,
          promptContent: null,
        }

        return isUserMessageEffectivelyEmpty(nextMessage) ? [] : [nextMessage]
      })
      const nextAssistantGroupBoundaryMessageIds =
        buildAssistantGroupBoundaryMessageIdsAfterUserRemoval(
          sourceMessages,
          nextMessages,
          assistantGroupBoundaryMessageIds,
        )

      if (didChangeHistory) {
        chatMessagesStateRef.current = nextMessages
        setChatMessages(nextMessages)
        setAssistantGroupBoundaryMessageIds(
          nextAssistantGroupBoundaryMessageIds,
        )
      }

      const retainedUserMessageIds = new Set(
        nextMessages
          .filter(
            (message): message is ChatUserMessage => message.role === 'user',
          )
          .map((message) => message.id),
      )

      setFocusedMessageId((prev) =>
        prev && !retainedUserMessageIds.has(prev) && prev !== inputMessage.id
          ? inputMessage.id
          : prev,
      )
      setMessageModelMap(
        (prev) =>
          new Map(
            Array.from(prev.entries()).filter(([messageId]) =>
              retainedUserMessageIds.has(messageId),
            ),
          ),
      )
      setMessageReasoningMap(
        (prev) =>
          new Map(
            Array.from(prev.entries()).filter(([messageId]) =>
              retainedUserMessageIds.has(messageId),
            ),
          ),
      )

      const nextActiveBranchByUserMessageId = new Map(
        Array.from(activeBranchByUserMessageIdRef.current.entries()).filter(
          ([messageId]) => retainedUserMessageIds.has(messageId),
        ),
      )
      activeBranchByUserMessageIdRef.current = nextActiveBranchByUserMessageId
      setActiveBranchByUserMessageId(nextActiveBranchByUserMessageId)

      // 从当前输入消息中删除
      setInputMessage((prev) => ({
        ...prev,
        mentionables: prev.mentionables.filter(
          (m) => getMentionableKey(serializeMentionable(m)) !== mentionableKey,
        ),
      }))
      if (!didChangeHistory) {
        return
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
      inputMessage.id,
      isUserMessageEffectivelyEmpty,
      persistConversation,
      releaseHighlightIds,
    ],
  )

  useImperativeHandle(ref, () => ({
    openNewChat: (selectedBlock?: MentionableBlockData) =>
      handleNewChat(selectedBlock),
    loadConversation: async (conversationId: string) =>
      await handleLoadConversation(conversationId),
    addSelectionToChat: (selectedBlock: MentionableBlockData) => {
      const mentionable = createSelectionBlockMentionable({
        ...selectedBlock,
        source: 'selection-pinned',
      })

      setAddedBlockKey(null)

      if (focusedMessageId === inputMessage.id) {
        setInputMessage((prevInputMessage) => {
          const mentionableKey = getMentionableKey(
            serializeMentionable(mentionable),
          )
          let changed = false
          const nextMentionables = prevInputMessage.mentionables.map((m) => {
            const key = getMentionableKey(serializeMentionable(m))
            if (key !== mentionableKey) return m
            if (m.type === 'block' && isSyncSelectionMentionable(m)) {
              changed = true
              return mentionable
            }
            return m
          })

          if (changed) {
            return {
              ...prevInputMessage,
              mentionables: nextMentionables,
              promptContent: null,
            }
          }

          if (
            prevInputMessage.mentionables.some(
              (m) =>
                getMentionableKey(serializeMentionable(m)) === mentionableKey,
            )
          ) {
            return prevInputMessage
          }

          return {
            ...prevInputMessage,
            mentionables: [...prevInputMessage.mentionables, mentionable],
            promptContent: null,
          }
        })
      } else {
        setChatMessages((prevChatHistory) =>
          prevChatHistory.map((message) => {
            if (message.id === focusedMessageId && message.role === 'user') {
              const mentionableKey = getMentionableKey(
                serializeMentionable(mentionable),
              )
              let changed = false
              const nextMentionables = message.mentionables.map((m) => {
                const key = getMentionableKey(serializeMentionable(m))
                if (key !== mentionableKey) return m
                if (m.type === 'block' && isSyncSelectionMentionable(m)) {
                  changed = true
                  return mentionable
                }
                return m
              })

              if (changed) {
                return {
                  ...message,
                  mentionables: nextMentionables,
                  promptContent: null,
                }
              }

              if (
                message.mentionables.some(
                  (m) =>
                    getMentionableKey(serializeMentionable(m)) ===
                    mentionableKey,
                )
              ) {
                return message
              }
              return {
                ...message,
                mentionables: [...message.mentionables, mentionable],
                promptContent: null,
              }
            }
            return message
          }),
        )
      }
    },
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
      flushSync(() => {
        if (overrideAssistant) {
          setConversationAssistantId(overrideAssistant.id)
          conversationAssistantIdRef.current.set(
            currentConversationId,
            overrideAssistant.id,
          )
          if (overrideAssistant.modelId) {
            applyAssistantDefaultModel(overrideAssistant.modelId)
          }
        }
        upsertSelectionMentionableInMainInput(mentionable)
      })

      const inputRef = chatUserInputRefs.current.get(inputMessage.id)
      if (text) {
        inputRef?.appendText(text)
      }

      if (options?.submit) {
        inputRef?.submit()
        return
      }

      inputRef?.focus()
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
    addFileToChat: (file: TFile) => {
      const mentionable: { type: 'file'; file: TFile } = {
        type: 'file',
        file: file,
      }

      setAddedBlockKey(null)

      if (focusedMessageId === inputMessage.id) {
        setInputMessage((prevInputMessage) => {
          const mentionableKey = getMentionableKey(
            serializeMentionable(mentionable),
          )
          // Check if mentionable already exists
          if (
            prevInputMessage.mentionables.some(
              (m) =>
                getMentionableKey(serializeMentionable(m)) === mentionableKey,
            )
          ) {
            return prevInputMessage
          }
          return {
            ...prevInputMessage,
            mentionables: [...prevInputMessage.mentionables, mentionable],
          }
        })
      } else {
        setChatMessages((prevChatHistory) =>
          prevChatHistory.map((message) => {
            if (message.id === focusedMessageId && message.role === 'user') {
              const mentionableKey = getMentionableKey(
                serializeMentionable(mentionable),
              )
              // Check if mentionable already exists
              if (
                message.mentionables.some(
                  (m) =>
                    getMentionableKey(serializeMentionable(m)) ===
                    mentionableKey,
                )
              ) {
                return message
              }
              return {
                ...message,
                mentionables: [...message.mentionables, mentionable],
              }
            }
            return message
          }),
        )
      }
    },
    addFolderToChat: (folder: TFolder) => {
      const mentionable: { type: 'folder'; folder: TFolder } = {
        type: 'folder',
        folder: folder,
      }

      setAddedBlockKey(null)

      if (focusedMessageId === inputMessage.id) {
        setInputMessage((prevInputMessage) => {
          const mentionableKey = getMentionableKey(
            serializeMentionable(mentionable),
          )
          // Check if mentionable already exists
          if (
            prevInputMessage.mentionables.some(
              (m) =>
                getMentionableKey(serializeMentionable(m)) === mentionableKey,
            )
          ) {
            return prevInputMessage
          }
          return {
            ...prevInputMessage,
            mentionables: [...prevInputMessage.mentionables, mentionable],
          }
        })
      } else {
        setChatMessages((prevChatHistory) =>
          prevChatHistory.map((message) => {
            if (message.id === focusedMessageId && message.role === 'user') {
              const mentionableKey = getMentionableKey(
                serializeMentionable(mentionable),
              )
              // Check if mentionable already exists
              if (
                message.mentionables.some(
                  (m) =>
                    getMentionableKey(serializeMentionable(m)) ===
                    mentionableKey,
                )
              ) {
                return message
              }
              return {
                ...message,
                mentionables: [...message.mentionables, mentionable],
              }
            }
            return message
          }),
        )
      }
    },
    addImageToChat: (image: MentionableImage) => {
      addMentionableToFocusedMessage(image)
    },
    insertTextToInput: (text: string) => {
      if (!focusedMessageId) return
      const inputRef = chatUserInputRefs.current.get(focusedMessageId)
      if (inputRef) {
        inputRef.insertText(text)
      }
    },
    appendTextToInput: (text: string) => {
      if (!text) return
      chatUserInputRefs.current.get(inputMessage.id)?.appendText(text)
    },
    setMainInputText: (text: string) => {
      chatUserInputRefs.current.get(inputMessage.id)?.replaceText(text)
    },
    focusMessage: () => {
      if (!focusedMessageId) return
      chatUserInputRefs.current.get(focusedMessageId)?.focus()
    },
    focusMainInput: () => {
      chatUserInputRefs.current.get(inputMessage.id)?.focus()
    },
    submitMainInput: () => {
      chatUserInputRefs.current.get(inputMessage.id)?.submit()
    },
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
  }))

  const applyChatModeChange = useCallback(
    (nextMode: ChatMode) => {
      setChatMode(nextMode)
      setConversationOverrides((prev) => ({
        ...(prev ?? {}),
        chatMode: nextMode,
      }))
      conversationOverridesRef.current.set(currentConversationId, {
        ...(conversationOverridesRef.current.get(currentConversationId) ?? {}),
        chatMode: nextMode,
      })
    },
    [currentConversationId],
  )

  const handleChatModeChange = useCallback(
    (nextMode: ChatMode) => {
      const resolvedMode = nextMode

      if (
        resolvedMode === 'agent-full' &&
        !settings.chatOptions.fullAccessWarningConfirmed
      ) {
        new AgentModeWarningModal(app, {
          title: t(
            'chatMode.fullAccessWarning.title',
            'Please confirm before enabling YOLO Mode',
          ),
          description: t(
            'chatMode.fullAccessWarning.description',
            'YOLO Mode auto-approves all tool calls, including file edits and terminal commands. Review the risks before continuing:',
          ),
          risks: [
            t(
              'chatMode.fullAccessWarning.permission',
              'Tools run without per-call approval. Dangerous command prefixes are still blocked.',
            ),
            t(
              'chatMode.fullAccessWarning.cost',
              'Autonomous runs may consume significant model resources and incur higher costs.',
            ),
            t(
              'chatMode.fullAccessWarning.backup',
              'Back up important content in advance to avoid unintended changes.',
            ),
          ],
          checkboxLabel: t(
            'chatMode.fullAccessWarning.checkbox',
            'I understand the risks above and accept responsibility for proceeding',
          ),
          cancelText: t('chatMode.fullAccessWarning.cancel', 'Cancel'),
          confirmText: t(
            'chatMode.fullAccessWarning.confirm',
            'Continue with YOLO Mode',
          ),
          onConfirm: () => {
            applyChatModeChange('agent-full')
            void persistPreferredChatMode('agent-full')
            void (async () => {
              try {
                await setSettings({
                  ...settings,
                  chatOptions: {
                    ...settings.chatOptions,
                    fullAccessWarningConfirmed: true,
                  },
                })
              } catch (error: unknown) {
                console.error(
                  'Failed to persist full access warning confirmation',
                  error,
                )
              }
            })()
          },
        }).open()
        return
      }

      if (
        resolvedMode === 'agent' &&
        !settings.chatOptions.agentModeWarningConfirmed
      ) {
        new AgentModeWarningModal(app, {
          title: t(
            'chatMode.warning.title',
            'Please confirm before enabling Agent mode',
          ),
          description: t(
            'chatMode.warning.description',
            'Agent can automatically invoke tools. Please review the following risks before continuing:',
          ),
          risks: [
            t(
              'chatMode.warning.permission',
              'Strictly control tool-call permissions and grant only what is necessary.',
            ),
            t(
              'chatMode.warning.cost',
              'Agent tasks may consume significant model resources and incur higher costs.',
            ),
            t(
              'chatMode.warning.backup',
              'Back up important content in advance to avoid unintended changes.',
            ),
          ],
          checkboxLabel: t(
            'chatMode.warning.checkbox',
            'I understand the risks above and accept responsibility for proceeding',
          ),
          cancelText: t('chatMode.warning.cancel', 'Cancel'),
          confirmText: t(
            'chatMode.warning.confirm',
            'Continue and Enable Agent',
          ),
          onConfirm: () => {
            applyChatModeChange('agent')
            void persistPreferredChatMode('agent')
            void (async () => {
              try {
                await setSettings({
                  ...settings,
                  chatOptions: {
                    ...settings.chatOptions,
                    agentModeWarningConfirmed: true,
                  },
                })
              } catch (error: unknown) {
                console.error(
                  'Failed to persist agent mode warning confirmation',
                  error,
                )
              }
            })()
          },
        }).open()
        return
      }

      applyChatModeChange(resolvedMode)
      void persistPreferredChatMode(resolvedMode)

      if (
        isAgentChatMode(resolvedMode) &&
        selectedAssistant?.modelId &&
        conversationModelId === settings.chatModelId
      ) {
        applyAssistantDefaultModel(selectedAssistant.modelId)
      }
    },
    [
      app,
      applyAssistantDefaultModel,
      applyChatModeChange,
      conversationModelId,
      selectedAssistant?.modelId,
      persistPreferredChatMode,
      setSettings,
      settings,
      t,
    ],
  )

  const header = (
    <div
      ref={headerRef}
      className={`yolo-chat-header${
        isSidebarPlacement ? '' : ' yolo-chat-header--workspace'
      }`}
    >
      {onChangeView ? (
        <ViewToggle
          activeView={activeView}
          onChangeView={onChangeView}
          showComposer={isSidebarPlacement}
          disabled={false}
        />
      ) : (
        <h1 className="yolo-chat-header-title">
          {t('sidebar.tabs.chat', 'Chat')}
        </h1>
      )}
      {activeView === 'chat' && (
        <div className="yolo-chat-header-right">
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
          <div className="yolo-chat-header-buttons">
            <button
              type="button"
              onClick={() => handleNewChat()}
              className="clickable-icon"
              aria-label="New Chat"
            >
              <Plus size={18} />
            </button>
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
            <ChatListDropdown
              chatList={chatList}
              currentConversationId={currentConversationId}
              runSummariesByConversationId={runSummariesByConversationId}
              onSelect={(conversationId) => {
                if (conversationId === currentConversationId) return
                void handleLoadConversation(conversationId)
              }}
              onDelete={(conversationId) => {
                void (async () => {
                  await deleteConversation(conversationId)
                  if (conversationId === currentConversationId) {
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
                await generateConversationTitle(
                  conversationId,
                  conversation.messages,
                  {
                    force: true,
                  },
                )
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

  const lastAssistantGroupRenderKey = useMemo(() => {
    for (let i = chatTimelineItems.length - 1; i >= 0; i--) {
      const item = chatTimelineItems[i]
      if (item.kind === 'assistant-group') {
        return item.renderKey
      }
    }
    return null
  }, [chatTimelineItems])

  // 后台任务结果在渲染上会接回对应 tool card，且 subagent/terminal result
  // standalone group 会被 timeline 过滤掉；因此必须在过滤前的 grouped
  // messages 上决定“视觉回合”的 footer 归属。
  const foregroundAgentVisualTurnPlan = useMemo(
    () => buildForegroundAgentVisualTurnPlan(groupedChatMessages),
    [groupedChatMessages],
  )

  const renderChatTimelineItem = useCallback(
    (timelineItem: ChatTimelineItem) => {
      if (timelineItem.kind === 'compaction-pending') {
        return (
          <div
            className="yolo-chat-compaction-pending"
            data-anchor-message-id={timelineItem.anchorMessageId}
          >
            <div className="yolo-chat-compaction-pending__loader">
              <DotLoader text={compactionPendingTitle} />
            </div>
            <div className="yolo-chat-compaction-pending__description">
              {compactionPendingDescription}
            </div>
          </div>
        )
      }

      if (timelineItem.kind === 'compaction-divider') {
        return (
          <div
            className={cx(
              'yolo-chat-compaction-divider',
              timelineItem.renderKey ===
                `${enteringCompactionDividerAnchorMessageId}-compact-divider` &&
                'is-entering',
            )}
          >
            <div className="yolo-chat-compaction-divider__title">
              {compactionDividerTitle}
            </div>
            <div className="yolo-chat-compaction-divider__line" />
            <div className="yolo-chat-compaction-divider__content">
              <div className="yolo-chat-compaction-divider__description">
                {compactionDividerDescription}
              </div>
            </div>
          </div>
        )
      }

      if (timelineItem.kind === 'assistant-group') {
        const messageOrGroup = timelineItem.messages
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

        return (
          <AssistantToolMessageGroupItem
            messages={messageOrGroup}
            conversationId={currentConversationId}
            conversationRunSummary={
              timelineItem.renderKey === lastAssistantGroupRenderKey
                ? currentConversationRunSummary
                : undefined
            }
            activeBranchKey={activeBranchByUserMessageId.get(
              getSourceUserMessageIdForGroup(messageOrGroup) ?? '',
            )}
            suppressFooter={
              shouldSuppressCompactionAnchorFooter ||
              foregroundAgentFooter?.suppress === true
            }
            inlineInfoMessages={
              foregroundAgentFooter?.inlineInfoMessages ?? messageOrGroup
            }
            showInlineInfo={chatSurfacePreset.assistantActions.showInlineInfo}
            showRetryAction={chatSurfacePreset.assistantActions.showRetryAction}
            showInsertAction={
              chatSurfacePreset.assistantActions.showInsertAction
            }
            showCopyAction={chatSurfacePreset.assistantActions.showCopyAction}
            showBranchAction={
              chatSurfacePreset.assistantActions.showBranchAction
            }
            showEditAction={chatSurfacePreset.assistantActions.showEditAction}
            showDeleteAction={
              chatSurfacePreset.assistantActions.showDeleteAction
            }
            isApplying={applyMutation.isPending}
            activeApplyRequestKey={activeApplyRequestKey}
            onApply={handleApply}
            onToolMessageUpdate={handleToolMessageUpdate}
            terminalCommandResultsByToolCallId={
              terminalCommandResultsByToolCallId
            }
            subagentResultsByToolCallId={subagentResultsByToolCallId}
            onRecoverToolCall={handleRecoverPendingToolCall}
            onRecoverAnswerUserQuestion={handleRecoverAnswerUserQuestion}
            editingAssistantMessageId={editingAssistantMessageId}
            onEditStart={(messageId) => {
              setEditingAssistantMessageId(messageId)
            }}
            onEditCancel={handleAssistantMessageEditCancel}
            onEditSave={handleAssistantMessageEditSave}
            onDeleteGroup={handleAssistantMessageGroupDelete}
            onRetryGroup={handleAssistantMessageGroupRetry}
            onBranchGroup={handleAssistantMessageGroupBranch}
            onActiveBranchChange={(branchKey) => {
              const sourceUserMessageId =
                getSourceUserMessageIdForGroup(messageOrGroup)
              if (!sourceUserMessageId) {
                return
              }
              const next = new Map(activeBranchByUserMessageIdRef.current)
              if (!branchKey) {
                next.delete(sourceUserMessageId)
              } else {
                next.set(sourceUserMessageId, branchKey)
              }
              activeBranchByUserMessageIdRef.current = next
              setActiveBranchByUserMessageId(next)
              void persistConversation(chatMessagesStateRef.current)
            }}
            onQuoteAssistantSelection={handleQuoteAssistantSelection}
            onOpenEditSummaryFile={handleOpenEditSummaryFile}
            onUndoEditSummary={handleUndoEditSummary}
            undoingEditSummaryTarget={undoingEditSummaryTarget}
            pendingCompactionAnchorMessageId={pendingCompactionAnchorMessageId}
            hidePendingAssistantPlaceholders={
              shouldHidePendingAssistantPlaceholders
            }
            showQuoteAction={chatSurfacePreset.assistantActions.showQuoteAction}
          />
        )
      }

      if (timelineItem.kind === 'user-message') {
        const messageOrGroup = timelineItem.message
        const groupedMessageIndex = groupedChatMessages.findIndex(
          (candidate) =>
            !Array.isArray(candidate) && candidate.id === messageOrGroup.id,
        )
        const messageReasoningLevel =
          messageReasoningMap.get(messageOrGroup.id) ??
          normalizeReasoningLevel(messageOrGroup.reasoningLevel) ??
          reasoningLevel

        return (
          <UserMessageItem
            message={messageOrGroup}
            isFocused={focusedMessageId === messageOrGroup.id}
            isActionDisabled={isCurrentConversationRunActive}
            onDelete={() => {
              handleHistoricalUserMessageDelete(messageOrGroup.id)
            }}
            displayMentionables={messageOrGroup.mentionables}
            chatUserInputRef={(ref) =>
              registerChatUserInputRef(messageOrGroup.id, ref)
            }
            onControlPopoverOpenChange={(isOpen) => {
              if (!isOpen) {
                return
              }
              suppressNextHistoricalUserMessageOutsidePointerRef.current =
                messageOrGroup.id
            }}
            onInputChange={(content) => {
              updateHistoricalUserMessage(messageOrGroup.id, (message) => ({
                ...message,
                content,
                promptContent: null,
              }))
            }}
            onSubmit={(content) => {
              if (
                editorStateToPlainText(content).trim() === '' &&
                messageOrGroup.mentionables.length === 0 &&
                (messageOrGroup.selectedSkills?.length ?? 0) === 0
              ) {
                finalizeHistoricalUserMessageEdit(messageOrGroup.id)
                chatUserInputRefs.current.get(inputMessage.id)?.focus()
                return
              }
              const modelForThisMessage =
                messageModelMap.get(messageOrGroup.id) ?? conversationModelId
              const reasoningForThisMessage =
                messageReasoningMap.get(messageOrGroup.id) ??
                messageReasoningLevel
              const nextMessageModelMap = new Map(messageModelMap)
              nextMessageModelMap.set(messageOrGroup.id, modelForThisMessage)
              // 历史编辑后重新提交是一个新的用户回合 → 打上新的当前时间。
              const editedUserMessage: ChatUserMessage =
                stampUserMessageTimeContext(
                  {
                    role: 'user',
                    content,
                    promptContent: null,
                    id: messageOrGroup.id,
                    reasoningLevel: reasoningForThisMessage,
                    mentionables: messageOrGroup.mentionables,
                    selectedSkills: messageOrGroup.selectedSkills ?? [],
                    selectedModelIds: extractSelectedModelIds(
                      messageOrGroup.mentionables,
                    ),
                  },
                  resolveAssistantTimeContextEnabled(
                    selectedAssistant,
                    settings,
                  ),
                )
              const inputChatMessages = [
                ...groupedChatMessages
                  .slice(0, groupedMessageIndex)
                  .flatMap((candidate): ChatMessage[] =>
                    !Array.isArray(candidate) ? [candidate] : candidate,
                  ),
                editedUserMessage,
              ]
              const requestChatMessages = [
                ...groupedChatMessages
                  .slice(0, groupedMessageIndex)
                  .flatMap((candidate): ChatMessage[] =>
                    !Array.isArray(candidate)
                      ? [candidate]
                      : getDisplayedAssistantToolMessages(
                          candidate,
                          activeBranchByUserMessageId.get(
                            getSourceUserMessageIdForGroup(candidate) ?? '',
                          ),
                        ),
                  ),
                editedUserMessage,
              ]
              void handleUserMessageSubmit({
                inputChatMessages,
                requestChatMessages,
                persistedMessageModelMap: nextMessageModelMap,
              })
              chatUserInputRefs.current.get(inputMessage.id)?.focus()
              setMessageModelMap(nextMessageModelMap)
              setMessageReasoningMap((prev) => {
                const next = new Map(prev)
                next.set(messageOrGroup.id, reasoningForThisMessage)
                return next
              })
            }}
            onFocus={() => {
              setFocusedMessageId(messageOrGroup.id)
            }}
            onMentionablesChange={(mentionables) => {
              const currentMessage = chatMessagesStateRef.current.find(
                (message): message is ChatUserMessage =>
                  message.role === 'user' && message.id === messageOrGroup.id,
              )
              if (currentMessage) {
                releaseHighlightIds(
                  collectRemovedSelectionHighlightIds(
                    currentMessage.mentionables,
                    mentionables,
                  ),
                )
              }
              updateHistoricalUserMessage(messageOrGroup.id, (message) => {
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
              })
            }}
            onSelectedSkillsChange={(selectedSkills) => {
              updateHistoricalUserMessage(messageOrGroup.id, (message) => ({
                ...message,
                selectedSkills,
                promptContent: null,
                snapshotRef: undefined,
              }))
            }}
            modelId={
              messageModelMap.get(messageOrGroup.id) ?? conversationModelId
            }
            onModelChange={(id) => {
              setMessageModelMap((prev) => {
                const next = new Map(prev)
                next.set(messageOrGroup.id, id)
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
                next.set(messageOrGroup.id, level)
                return next
              })
              setChatMessages((prevChatHistory) =>
                prevChatHistory.map((msg) =>
                  msg.role === 'user' && msg.id === messageOrGroup.id
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
              void persistReasoningLevelForModel(conversationModelId, level)
            }}
            currentAssistantId={conversationAssistantId}
            currentChatMode={chatMode}
            onSelectChatModeForConversation={handleChatModeChange}
            showReasoningSelect={
              chatSurfacePreset.userMessage.showReasoningSelect
            }
            allowAgentModeOption={
              chatSurfacePreset.userMessage.allowAgentModeOption
            }
          />
        )
      }

      if (timelineItem.kind === 'query-progress') {
        return <QueryProgress state={queryProgress} />
      }

      if (timelineItem.kind === 'continue-response') {
        return (
          <div className="yolo-continue-response-button-container">
            <button
              type="button"
              className="yolo-continue-response-button"
              onClick={handleContinueResponse}
            >
              <div>Continue response</div>
            </button>
          </div>
        )
      }

      return (
        <div
          ref={bottomAnchorRef}
          className="yolo-chat-bottom-anchor"
          aria-hidden="true"
        />
      )
    },
    [
      activeApplyRequestKey,
      activeBranchByUserMessageId,
      applyMutation.isPending,
      chatSurfacePreset,
      chatMode,
      compactionDividerAnchorMessageId,
      compactionDividerDescription,
      compactionPendingDescription,
      compactionPendingTitle,
      compactionDividerTitle,
      conversationAssistantId,
      conversationModelId,
      currentConversationId,
      editingAssistantMessageId,
      enteringCompactionDividerAnchorMessageId,
      firstUserMessageId,
      focusedMessageId,
      groupedChatMessages,
      handleApply,
      handleAssistantMessageEditCancel,
      handleAssistantMessageEditSave,
      handleHistoricalUserMessageDelete,
      handleChatModeChange,
      handleContinueResponse,
      handleOpenEditSummaryFile,
      handleQuoteAssistantSelection,
      handleToolMessageUpdate,
      handleUndoEditSummary,
      handleUserMessageSubmit,
      inputMessage.id,
      isCurrentConversationRunActive,
      lastAssistantGroupRenderKey,
      latestCompactionState?.triggerToolCallId,
      messageModelMap,
      messageReasoningMap,
      pendingCompactionAnchorMessageId,
      persistConversation,
      queryProgress,
      reasoningLevel,
      foregroundAgentVisualTurnPlan,
      shouldHidePendingAssistantPlaceholders,
      undoingEditSummaryTarget,
      updateHistoricalUserMessage,
      finalizeHistoricalUserMessageEdit,
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
        activeMessageId={activeNavigatorMessageId}
        itemLabel={getMessageNavigatorItemLabel}
        onSelect={handleNavigateToUserMessage}
      />
    ) : undefined

  return (
    <div
      ref={containerRef}
      className={containerClassName}
      style={containerStyle}
    >
      {header}
      {activeView === 'composer' ? (
        <div className="yolo-chat-composer-wrapper">
          <Composer onNavigateChat={() => onChangeView?.('chat')} />
        </div>
      ) : (
        <ChatConversationPane
          chatMode={chatMode}
          groupedChatMessagesLength={groupedChatMessages.length}
          isCurrentConversationRunActive={isCurrentConversationRunActive}
          isAutoFollowEnabled={isAutoFollowEnabled}
          currentConversationId={currentConversationId}
          chatTimelineItems={chatTimelineItems}
          chatMessagesRef={chatMessagesRef}
          renderChatTimelineItem={renderChatTimelineItem}
          followOutput={followOutput}
          onAtBottomStateChange={onAtBottomStateChange}
          editingAssistantMessageId={editingAssistantMessageId}
          hasEarlierMessages={hasEarlierMessages}
          hasNewerMessages={hasNewerMessages}
          onLoadEarlier={loadEarlier}
          onLoadNewer={loadNewer}
          loadEarlierLabel={t('chat.loadEarlierMessages', '正在加载更早消息')}
          loadNewerLabel={t('chat.loadNewerMessages', '正在加载更新消息')}
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
          onTimelineVirtualizationChange={setTimelineIsVirtualized}
          onActiveUserMessageChange={setActiveNavigatorMessageId}
          windowNavigationKey={windowNavigationKey || undefined}
          windowNavigationTargetMessageId={windowNavigationTargetMessageId}
          messageNavigatorContent={messageNavigatorContent}
          bottomSpacerHeight={inputOverlayHeight}
          footerContent={
            <>
              {(settings.chatOptions.mentionDisplayMode ?? 'inline') ===
                'badge' &&
                displayMentionablesForInput.length > 0 && (
                  <div className="yolo-chat-user-input-files">
                    {displayMentionablesForInput.map((mentionable) => {
                      const mentionableKey = getMentionableKey(
                        serializeMentionable(mentionable),
                      )
                      return (
                        <MentionableBadge
                          key={mentionableKey}
                          mentionable={mentionable}
                          onDelete={() =>
                            handleMentionableDeleteFromAll(mentionable)
                          }
                          onClick={() => {}}
                        />
                      )
                    })}
                  </div>
                )}
              <div className="yolo-chat-input-wrapper">
                <div
                  ref={setInputOverlayElement}
                  className="yolo-chat-input-overlay"
                >
                  {queuedUserMessages.length > 0 && (
                    <div className="yolo-chat-queued-messages">
                      <div className="yolo-chat-queued-messages__hint">
                        {t(
                          'chat.queueMessage.hint',
                          '等待 Agent 完成当前步骤...',
                        )}
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
                            {preview || ' '}
                          </div>
                        )
                      })}
                    </div>
                  )}
                  <TodoListPanel
                    key={currentConversationId}
                    messages={displayedChatMessages}
                    queuedMessageCount={queuedUserMessages.length}
                  />
                </div>
                <ChatUserInput
                  key={inputMessage.id}
                  ref={(ref) => registerChatUserInputRef(inputMessage.id, ref)}
                  initialSerializedEditorState={inputMessage.content}
                  onChange={(content) => {
                    setInputMessage((prevInputMessage) => ({
                      ...prevInputMessage,
                      content,
                    }))
                  }}
                  onSubmit={(content) => {
                    if (
                      editorStateToPlainText(content).trim() === '' &&
                      inputMessage.mentionables.length === 0 &&
                      (inputMessage.selectedSkills?.length ?? 0) === 0
                    ) {
                      return
                    }
                    // 新用户回合进入对话:在此固定当前时间。同时覆盖随后两条出口
                    // ——入队(running 分支)与普通提交——保证两者用的都是入队/提交
                    // 那一刻的时间,而非 drain 时刻。
                    const messageForSubmit = stampUserMessageTimeContext(
                      buildInputMessageForSubmit(content),
                      resolveAssistantTimeContextEnabled(
                        selectedAssistant,
                        settings,
                      ),
                    )

                    // ask_user_question parks the agent in a paused state that
                    // may outlive the run itself (run can finalize while the
                    // panel is still awaiting answers). Intercept the submit
                    // here so a new message can't bypass the awaiting panel —
                    // the user must answer the panel first.
                    if (currentConversationRunSummary.isWaitingUserInput) {
                      new Notice(
                        t(
                          'chat.queueMessage.blockedAwaitingInput',
                          '请先在对话中回答模型的提问，再发送新消息。',
                        ),
                      )
                      return
                    }

                    if (currentConversationRunSummary.isWaitingApproval) {
                      new Notice(
                        t(
                          'chat.queueMessage.blockedApproval',
                          '请先批准或拒绝待审批工具，再发送新消息。',
                        ),
                      )
                      return
                    }

                    // While the live loop is queueable, route the message
                    // through AgentService so it can be injected at the next
                    // safe LLM boundary instead of aborting the current run.
                    if (currentConversationRunSummary.isQueueable) {
                      const enqueueResult = agentService.enqueueUserMessage(
                        currentConversationId,
                        messageForSubmit,
                      )
                      if (enqueueResult === 'enqueued') {
                        setMessageReasoningMap((prev) => {
                          const next = new Map(prev)
                          next.set(inputMessage.id, reasoningLevel)
                          return next
                        })
                        commitSentSelectionHighlights(
                          messageForSubmit.mentionables,
                        )
                        setInputMessage(getNewInputMessage(reasoningLevel))
                        return
                      }
                      if (enqueueResult === 'blocked_awaiting_approval') {
                        new Notice(
                          t(
                            'chat.queueMessage.blockedApproval',
                            '请先批准或拒绝待审批工具，再发送新消息。',
                          ),
                        )
                        return
                      }
                      // 'idle' → fall through to the normal submit path below.
                    }

                    if (currentConversationRunSummary.isActive) {
                      new Notice(
                        t(
                          'chat.queueMessage.blockedActiveTool',
                          '请等待当前工具调用完成后再发送新消息。',
                        ),
                      )
                      return
                    }

                    const nextMessageModelMap = new Map(messageModelMap)
                    nextMessageModelMap.set(
                      inputMessage.id,
                      conversationModelId,
                    )
                    void handleUserMessageSubmit({
                      inputChatMessages: [...chatMessages, messageForSubmit],
                      requestChatMessages: [
                        ...displayedChatMessages,
                        messageForSubmit,
                      ],
                      persistedMessageModelMap: nextMessageModelMap,
                    })
                    setMessageModelMap(nextMessageModelMap)
                    setMessageReasoningMap((prev) => {
                      const next = new Map(prev)
                      next.set(inputMessage.id, reasoningLevel)
                      return next
                    })
                    commitSentSelectionHighlights(messageForSubmit.mentionables)
                    setInputMessage(getNewInputMessage(reasoningLevel))
                  }}
                  onFocus={() => {
                    setFocusedMessageId(inputMessage.id)
                  }}
                  mentionables={inputMessage.mentionables}
                  setMentionables={(mentionables) => {
                    releaseHighlightIds(
                      collectRemovedSelectionHighlightIds(
                        inputMessageRef.current.mentionables,
                        mentionables,
                      ),
                    )
                    setInputMessage((prevInputMessage) => {
                      return {
                        ...prevInputMessage,
                        mentionables,
                      }
                    })
                  }}
                  selectedSkills={inputMessage.selectedSkills ?? []}
                  setSelectedSkills={(selectedSkills) => {
                    setInputMessage((prevInputMessage) => ({
                      ...prevInputMessage,
                      selectedSkills,
                      promptContent: null,
                      snapshotRef: undefined,
                    }))
                  }}
                  modelId={conversationModelId}
                  onModelChange={(id) => {
                    setConversationModelId(id)
                    conversationModelIdRef.current.set(
                      currentConversationId,
                      id,
                    )
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
                  reasoningLevel={reasoningLevel}
                  onReasoningChange={(level) => {
                    setReasoningLevel(level)
                    conversationReasoningLevelRef.current.set(
                      currentConversationId,
                      level,
                    )
                    void persistReasoningLevelForModel(
                      conversationModelId,
                      level,
                    )
                    setInputMessage((prev) => ({
                      ...prev,
                      reasoningLevel: level,
                    }))
                  }}
                  autoFocus
                  addedBlockKey={addedBlockKey}
                  hideBadgeMentionables
                  displayMentionables={displayMentionablesForInput}
                  onDeleteFromAll={handleMentionableDeleteFromAll}
                  currentAssistantId={conversationAssistantId}
                  onSelectAssistantForConversation={
                    handleConversationAssistantSelect
                  }
                  currentChatMode={chatMode}
                  onSelectChatModeForConversation={handleChatModeChange}
                  chatMode={chatMode}
                  onChatModeChange={handleChatModeChange}
                  allowAgentModeOption={true}
                  enableResize
                  onRunSlashCommand={(command) => {
                    if (command.id === 'compact-context') {
                      void handleManualContextCompaction()
                    }
                  }}
                  isGenerating={currentConversationRunSummary.isAbortable}
                  canQueueWhileGenerating={
                    currentConversationRunSummary.isQueueable
                  }
                  onAbort={() => abortConversationRun(currentConversationId)}
                  submitDisabled={isInputEmpty}
                  contextUsage={
                    headerContextUsage
                      ? {
                          promptTokens: headerContextUsage.promptTokens,
                          maxContextTokens: headerContextUsage.maxContextTokens,
                          label: t('chat.contextUsage', '上下文窗口占用'),
                          buildBreakdownInputs: () =>
                            buildContextBreakdownInputs(chatMessages),
                        }
                      : undefined
                  }
                />
              </div>
            </>
          }
        />
      )}
    </div>
  )
})

Chat.displayName = 'Chat'

export default Chat
