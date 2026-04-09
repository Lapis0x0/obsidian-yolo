import { EditorView } from '@codemirror/view'
import { useMutation } from '@tanstack/react-query'
import cx from 'clsx'
import { Download, History, Plus } from 'lucide-react'
import { MarkdownView, Notice, Platform, TFile } from 'obsidian'
import type { TFolder } from 'obsidian'
import {
  Fragment,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import { v4 as uuidv4 } from 'uuid'

import { DEFAULT_UNTITLED_CONVERSATION_TITLE } from '../../constants'
import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import { useMcp } from '../../contexts/mcp-context'
import { usePlugin } from '../../contexts/plugin-context'
import { useRAG } from '../../contexts/rag-context'
import { useSettings } from '../../contexts/settings-context'
import {
  getLatestAssistantContextUsage,
  resolveAutoContextCompactionChatOptions,
  shouldTriggerAutoContextCompaction,
} from '../../core/agent/compaction'
import { DEFAULT_ASSISTANT_ID } from '../../core/agent/default-assistant'
import type { AgentConversationRunSummary } from '../../core/agent/service'
import { materializeTextEditPlan } from '../../core/edits/textEditEngine'
import { parseTextEditPlan } from '../../core/edits/textEditPlan'
import type { ChatLeafPlacement } from '../../features/chat/chatLeafSessionManager'
import { selectionHighlightController } from '../../features/editor/selection-highlight/selectionHighlightController'
import { useChatHistory } from '../../hooks/useChatHistory'
import { useChatManager } from '../../hooks/useJsonManagers'
import type { ApplyViewState } from '../../types/apply-view.types'
import type {
  AssistantToolMessageGroup,
  ChatConversationCompactionState,
  ChatMessage,
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
} from '../../types/mentionable'
import {
  type ToolCallRequest,
  type ToolCallResponse,
  ToolCallResponseStatus,
  getToolCallArgumentsObject,
} from '../../types/tool-call.types'
import { readEditReviewSnapshot } from '../../database/json/chat/editReviewSnapshotStore'
import {
  type GroupEditSummary,
  deriveToolEditUndoStatus,
  updateToolMessageEditSummary,
} from '../../utils/chat/editSummary'
import {
  getBlockContentHash,
  getBlockMentionableCountInfo,
  getMentionableKey,
  serializeMentionable,
} from '../../utils/chat/mentionable'
import { normalizeMentionablesWithAutoCurrentFile } from '../../utils/chat/currentFileMentionable'
import { groupAssistantAndToolMessages } from '../../utils/chat/message-groups'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { exportChatConversationToVault } from '../../utils/chat/exportConversation'
import { buildChatTimelineItems } from '../../utils/chat/timeline'
import { formatTokenCount } from '../../utils/llm/contextTokenEstimate'
import { readTFileContent } from '../../utils/obsidian'
import DotLoader from '../common/DotLoader'
import { AgentModeWarningModal } from '../modals/AgentModeWarningModal'

// removed Prompt Templates feature

import { AssistantSelector } from './AssistantSelector'
import AssistantToolMessageGroupItem from './AssistantToolMessageGroupItem'
import type { ChatMode } from './chat-input/ChatModeSelect'
import ChatSettingsButton from './chat-input/ChatSettingsButton'
import ChatUserInput from './chat-input/ChatUserInput'
import type { ChatUserInputRef } from './chat-input/ChatUserInput'
import MentionableBadge from './chat-input/MentionableBadge'
import { getDefaultReasoningLevel } from './chat-input/ReasoningSelect'
import type { ReasoningLevel } from './chat-input/ReasoningSelect'
import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'
import { ChatListDropdown } from './ChatListDropdown'
import Composer from './Composer'
import ContextUsageRing from './ContextUsageRing'
import { syncRenderedLatexSelection } from './latex-copy'
import QueryProgress from './QueryProgress'
import type { QueryProgressState } from './QueryProgress'
import { getChatSurfacePreset } from './chat-surface-presets'
import { ChatConversationPane } from './ChatConversationPane'
import { useAutoScroll } from './useAutoScroll'
import { useChatStreamManager } from './useChatStreamManager'
import UserMessageItem from './UserMessageItem'
import ViewToggle from './ViewToggle'

const WORKSPACE_WIDE_HEADER_MIN_WIDTH = 1200

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

const getSourceUserMessageIdForGroup = (
  messages: AssistantToolMessageGroup,
): string | null => {
  for (const message of messages) {
    const sourceUserMessageId = message.metadata?.sourceUserMessageId
    if (sourceUserMessageId) {
      return sourceUserMessageId
    }
  }

  return null
}

const getDisplayedAssistantToolMessages = (
  messages: AssistantToolMessageGroup,
  activeBranchKey?: string | null,
): AssistantToolMessageGroup => {
  const isBranchCompleted = (branchMessages: AssistantToolMessageGroup) => {
    const latestMessage = branchMessages.at(-1)
    if (latestMessage?.metadata?.branchWaitingApproval) {
      return false
    }

    if (latestMessage?.metadata?.branchRunStatus) {
      return latestMessage.metadata.branchRunStatus === 'completed'
    }

    return branchMessages.some(
      (message) =>
        message.role === 'assistant' &&
        message.metadata?.generationState === 'completed',
    )
  }

  const branchGroups = new Map<string, AssistantToolMessageGroup>()
  messages.forEach((message) => {
    const branchId = message.metadata?.branchId
    if (!branchId) {
      return
    }

    const existing = branchGroups.get(branchId)
    if (existing) {
      existing.push(message)
      return
    }

    branchGroups.set(branchId, [message])
  })

  const groupedBranches = Array.from(branchGroups.values())
  if (groupedBranches.length <= 1) {
    return messages
  }

  const resolvedActiveBranchKey =
    activeBranchKey ??
    groupedBranches.find((branchMessages) =>
      isBranchCompleted(branchMessages),
    )?.[0]?.metadata?.branchId ??
    groupedBranches[0]?.[0]?.metadata?.branchId ??
    null

  return (
    groupedBranches.find(
      (branchMessages) =>
        branchMessages[0]?.metadata?.branchId === resolvedActiveBranchKey,
    ) ??
    groupedBranches[0] ??
    messages
  )
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

const isSyncSelectionMentionable = (mentionable: MentionableBlock): boolean => {
  return isSyncSelectionSource(mentionable.source)
}

const REASONING_LEVEL_CANDIDATES: ReasoningLevel[] = [
  'off',
  'on',
  'auto',
  'low',
  'medium',
  'high',
  'extra-high',
]

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
    },
  ) => void
  syncSelectionToChat: (selectedBlock: MentionableBlockData) => void
  syncSelectionToInput: (selectedBlock: MentionableBlockData) => void
  clearSelectionFromChat: () => void
  addFileToChat: (file: TFile) => void
  addFolderToChat: (folder: TFolder) => void
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

export type ChatProps = {
  selectedBlock?: MentionableBlockData
  activeView?: 'chat' | 'composer'
  onChangeView?: (view: 'chat' | 'composer') => void
  placement?: ChatLeafPlacement
  initialConversationId?: string
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
  const { getRAGEngine } = useRAG()
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
  const [conversationAssistantId, setConversationAssistantId] =
    useState<string>(settings.currentAssistantId ?? DEFAULT_ASSISTANT_ID)
  const conversationAssistantIdRef = useRef<Map<string, string>>(new Map())
  const effectiveSettings = useMemo(
    () => ({
      ...settings,
      currentAssistantId: conversationAssistantId,
    }),
    [conversationAssistantId, settings],
  )
  const requestContextBuilder = useMemo(() => {
    return new RequestContextBuilder(getRAGEngine, app, effectiveSettings)
  }, [app, effectiveSettings, getRAGEngine])

  const normalizeReasoningLevel = useCallback(
    (value?: string): ReasoningLevel | null => {
      if (!value) return null
      return REASONING_LEVEL_CANDIDATES.includes(value as ReasoningLevel)
        ? (value as ReasoningLevel)
        : null
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

  const [autoAttachCurrentFile, setAutoAttachCurrentFile] = useState(true)
  const conversationAutoAttachRef = useRef<Map<string, boolean>>(new Map())
  const [activeFile, setActiveFile] = useState<TFile | null>(() =>
    app.workspace.getActiveFile(),
  )
  const containerRef = useRef<HTMLDivElement | null>(null)
  const headerRef = useRef<HTMLDivElement | null>(null)
  const [isWorkspaceWideHeader, setIsWorkspaceWideHeader] = useState(false)
  const [workspaceWideHeaderHeight, setWorkspaceWideHeaderHeight] = useState(0)

  const [inputMessage, setInputMessage] = useState<ChatUserMessage>(() => {
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
  const [currentConversationId, setCurrentConversationId] =
    useState<string>(uuidv4())
  const currentConversationTitle = useMemo(() => {
    if (!currentConversationId) {
      return DEFAULT_UNTITLED_CONVERSATION_TITLE
    }

    return (
      chatList.find((conversation) => conversation.id === currentConversationId)
        ?.title ?? DEFAULT_UNTITLED_CONVERSATION_TITLE
    )
  }, [chatList, currentConversationId])
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>(
    initialReasoningLevel,
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

  const containerClassName = `smtcmp-chat-container${
    isSidebarPlacement
      ? ' smtcmp-chat-container--sidebar'
      : ' smtcmp-chat-container--centered'
  }${
    !isSidebarPlacement && isWorkspaceWideHeader
      ? ' smtcmp-chat-container--workspace-wide-header'
      : ''
  }`
  const containerStyle =
    !isSidebarPlacement && isWorkspaceWideHeader
      ? ({
          '--smtcmp-chat-workspace-header-height': `${workspaceWideHeaderHeight}px`,
        } as CSSProperties)
      : undefined

  // Per-conversation override settings (temperature, top_p, context, stream)
  const conversationOverridesRef = useRef<
    Map<string, ConversationOverrideSettings | null>
  >(new Map())
  const [conversationOverrides, setConversationOverrides] =
    useState<ConversationOverrideSettings | null>(null)
  const [chatMode, setChatMode] = useState<ChatMode>(() => {
    const defaultMode = settings.chatOptions.chatMode ?? 'chat'
    if (!Platform.isDesktop && defaultMode === 'agent') {
      return 'chat'
    }
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
  const [conversationModelId, setConversationModelId] = useState<string>(
    settings.chatModelId,
  )

  const currentConversationModel = useMemo(() => {
    return (
      settings.chatModels.find((model) => model.id === conversationModelId) ??
      null
    )
  }, [conversationModelId, settings.chatModels])

  const headerContextUsage = useMemo(() => {
    const contextUsage = getLatestAssistantContextUsage({
      messages: chatMessages,
      maxContextTokens: currentConversationModel?.maxContextTokens,
    })
    if (!contextUsage || contextUsage.maxContextTokens === null) {
      return null
    }

    return {
      promptTokens: contextUsage.promptTokens,
      maxContextTokens: contextUsage.maxContextTokens,
    }
  }, [chatMessages, currentConversationModel?.maxContextTokens])

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
  const [activeBranchByUserMessageId, setActiveBranchByUserMessageId] =
    useState<Map<string, string>>(new Map())
  const submitMutationPendingRef = useRef(false)

  const groupedChatMessages: (ChatUserMessage | AssistantToolMessageGroup)[] =
    useMemo(() => {
      return groupAssistantAndToolMessages(chatMessages)
    }, [chatMessages])

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

  const hasUserMessages = useMemo(
    () => chatMessages.some((message) => message.role === 'user'),
    [chatMessages],
  )

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
  const compactionDividerDescription =
    typeof latestCompactionState?.estimatedNextContextTokens === 'number'
      ? t(
          'chat.compaction.dividerDescriptionWithEstimate',
          '以上对话已压缩为摘要，下一轮总上下文约为 {count} tokens',
        ).replace(
          '{count}',
          formatTokenCount(latestCompactionState.estimatedNextContextTokens),
        )
      : t(
          'chat.compaction.dividerDescription',
          '以上对话已压缩为摘要，以下回复基于摘要继续',
        )
  const compactionPendingDescription = t(
    'chat.compaction.pendingStatus',
    '正在整理上下文，稍后将从新的上下文继续。',
  )

  const shouldShowAutoAttachBadge =
    settings.chatOptions.includeCurrentFileContent &&
    autoAttachCurrentFile &&
    !hasUserMessages &&
    Boolean(activeFile)

  const displayMentionablesForInput = useMemo(() => {
    return normalizeMentionablesWithAutoCurrentFile(
      inputMessage.mentionables,
      activeFile,
      shouldShowAutoAttachBadge,
    )
  }, [activeFile, inputMessage.mentionables, shouldShowAutoAttachBadge])

  const currentFileOverride = useMemo(() => {
    if (!settings.chatOptions.includeCurrentFileContent) return null
    if (!autoAttachCurrentFile) return null
    return activeFile
  }, [
    activeFile,
    autoAttachCurrentFile,
    settings.chatOptions.includeCurrentFileContent,
  ])

  const chatUserInputRefs = useRef<Map<string, ChatUserInputRef>>(new Map())
  const chatMessagesRef = useRef<HTMLDivElement>(null)
  const bottomAnchorRef = useRef<HTMLDivElement>(null)
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
    isAutoFollowEnabled,
    followOutput,
    onAtBottomStateChange,
  } = useAutoScroll({
    scrollContainerRef: chatMessagesRef,
    bottomAnchorRef,
    isStreaming: hasStreamingMessages,
  })

  const {
    abortConversationRun,
    compactConversation,
    currentConversationRunSummary,
    submitChatMutation,
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
    assistantIdOverride: conversationAssistantId,
    compaction: effectiveCompactionState,
  })
  const [runSummariesByConversationId, setRunSummariesByConversationId] =
    useState<Map<string, AgentConversationRunSummary>>(new Map())
  const isCurrentConversationRunActive =
    currentConversationRunSummary.isRunning ||
    currentConversationRunSummary.isWaitingApproval
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
        groupedChatMessages,
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
      compactionDividerAnchorMessageIds,
      focusedMessageId,
      groupedChatMessages,
      inputMessage.id,
      latestCompactionState,
      pendingCompactionAnchorMessageId,
      queryProgress,
      showContinueResponseButton,
    ],
  )
  const latestTimelineAssistantToolGroupKey = useMemo(() => {
    for (let index = chatTimelineItems.length - 1; index >= 0; index -= 1) {
      const candidate = chatTimelineItems[index]
      if (candidate.kind === 'assistant-group') {
        return candidate.renderKey
      }
    }

    return null
  }, [chatTimelineItems])
  useEffect(() => {
    const chatMessagesElement = chatMessagesRef.current
    if (!chatMessagesElement) {
      return
    }

    let didSelectionTouchChat = false

    const syncLatexSelectionInView = () => {
      latexSelectionSyncFrameRef.current = null

      const selection = window.getSelection()
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
        .querySelectorAll<HTMLElement>('.smtcmp-markdown-rendered')
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

    document.addEventListener('selectionchange', scheduleLatexSelectionSync)
    document.addEventListener('mouseup', scheduleLatexSelectionSync)
    document.addEventListener('keyup', scheduleLatexSelectionSync)

    return () => {
      document.removeEventListener(
        'selectionchange',
        scheduleLatexSelectionSync,
      )
      document.removeEventListener('mouseup', scheduleLatexSelectionSync)
      document.removeEventListener('keyup', scheduleLatexSelectionSync)
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

  const persistConversation = useCallback(
    async (messages: ChatMessage[]) => {
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
      serializeMessageModelMap,
    ],
  )

  const persistConversationImmediately = useCallback(
    async (messages: ChatMessage[]): Promise<boolean> => {
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
      serializeMessageModelMap,
    ],
  )

  const handleManualContextCompaction = useCallback(async () => {
    if (currentConversationRunSummary.isRunning) {
      new Notice(
        t('chat.compaction.runActive', '请等待当前回复完成后再压缩上下文。'),
      )
      return
    }

    if (currentConversationRunSummary.isWaitingApproval) {
      new Notice(
        t(
          'chat.compaction.waitingApproval',
          '请先处理当前待确认的工具调用，再压缩上下文。',
        ),
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
    currentConversationRunSummary.isRunning,
    currentConversationRunSummary.isWaitingApproval,
    effectiveCompactionState,
    plugin,
    reasoningLevel,
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
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }

      if (
        target.closest('.smtcmp-chat-sidebar-popover') ||
        target.closest('.smtcmp-smart-space-popover')
      ) {
        return
      }

      const activeMessageElement = chatMessagesRef.current?.querySelector(
        `[data-user-message-id="${focusedMessageId}"]`,
      )
      if (activeMessageElement?.contains(target)) {
        return
      }

      setFocusedMessageId(inputMessage.id)
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
    }
  }, [focusedMessageId, inputMessage.id])

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
        setCompactionState(conversation.compaction ?? [])
        setPendingCompactionAnchorMessageId(null)
        plugin
          .getAgentService()
          .replaceConversationMessages(
            conversationId,
            normalizedConversation.messages,
            conversation.compaction ?? [],
            { persistState: true },
          )
        const storedAutoAttach = conversation.overrides?.autoAttachCurrentFile
        const resolvedAutoAttach =
          typeof storedAutoAttach === 'boolean' ? storedAutoAttach : true
        setAutoAttachCurrentFile(resolvedAutoAttach)
        conversationAutoAttachRef.current.set(
          conversationId,
          resolvedAutoAttach,
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
        const loadedChatModeRaw = conversation.overrides?.chatMode
        const loadedChatMode: ChatMode =
          loadedChatModeRaw === 'agent' || loadedChatModeRaw === 'chat'
            ? loadedChatModeRaw
            : (settings.chatOptions.chatMode ?? 'chat')
        setChatMode(
          !Platform.isDesktop && loadedChatMode === 'agent'
            ? 'chat'
            : loadedChatMode,
        )
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
        const newInputMessage = getNewInputMessage(resolvedReasoningLevel)
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
    conversationAutoAttachRef.current.set(newId, true)
    setAutoAttachCurrentFile(true)
    setConversationOverrides(null)
    const defaultChatMode = chatMode
    setChatMode(
      !Platform.isDesktop && defaultChatMode === 'agent'
        ? 'chat'
        : defaultChatMode,
    )
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
    activeBranchByUserMessageIdRef.current = new Map()
    setActiveBranchByUserMessageId(new Map())
    setMessageReasoningMap(new Map())
    setChatMessages([])
    setCompactionState([])
    setPendingCompactionAnchorMessageId(null)
    setEditingAssistantMessageId(null)
    const newInputMessage = getNewInputMessage(defaultReasoningLevel)
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
      setChatMessages((prevChatHistory) => {
        const nextMessages = prevChatHistory.filter(
          (message) => !idsToRemove.has(message.id),
        )
        void persistConversation(nextMessages)
        return nextMessages
      })
      setEditingAssistantMessageId((prev) =>
        prev && idsToRemove.has(prev) ? null : prev,
      )
    },
    [persistConversation],
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

      const sourceTitle =
        chatList.find((chat) => chat.id === currentConversationId)?.title ??
        t('chat.newChat', 'New chat')
      const branchTitle = `${sourceTitle} (copy)`

      const newConversationId = uuidv4()
      const nextOverrides =
        conversationOverridesRef.current.get(currentConversationId) ??
        conversationOverrides ??
        null
      const rawNextChatMode = nextOverrides?.chatMode
      const resolvedNextChatMode: ChatMode =
        rawNextChatMode === 'agent' || rawNextChatMode === 'chat'
          ? rawNextChatMode
          : chatMode
      const nextChatMode =
        !Platform.isDesktop && resolvedNextChatMode === 'agent'
          ? 'chat'
          : resolvedNextChatMode
      const storedAutoAttach = nextOverrides?.autoAttachCurrentFile
      const resolvedAutoAttach =
        typeof storedAutoAttach === 'boolean' ? storedAutoAttach : true

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
      setAutoAttachCurrentFile(resolvedAutoAttach)
      conversationAutoAttachRef.current.set(
        newConversationId,
        resolvedAutoAttach,
      )

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
            autoAttachCurrentFile: resolvedAutoAttach,
          },
          resolvedConversationModelId,
          serializeMessageModelMap(nextMessages, nextMessageModelMap),
          serializeActiveBranchByUserMessageId(
            nextMessages,
            nextActiveBranchByUserMessageId,
          ),
          resolvedReasoningLevel,
          branchedCompactionState,
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

      try {
        const mcpManager = await getMcpManager()
        const args = getToolCallArgumentsObject(request.arguments)

        if (allowForConversation) {
          mcpManager.allowToolForConversation(
            request.name,
            conversationId,
            args,
          )
        }

        const result = await mcpManager.callTool({
          name: request.name,
          args,
          id: request.id,
          conversationId,
          conversationMessages: runningMessages,
          roundId: toolMessageId,
        })

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

  const updateAutoAttachCurrentFile = useCallback(
    (value: boolean) => {
      setAutoAttachCurrentFile(value)
      conversationAutoAttachRef.current.set(currentConversationId, value)
      setConversationOverrides((prev) => {
        const nextOverrides = {
          ...(prev ?? {}),
          chatMode,
          autoAttachCurrentFile: value,
        }
        conversationOverridesRef.current.set(
          currentConversationId,
          nextOverrides,
        )
        return nextOverrides
      })
    },
    [chatMode, currentConversationId],
  )

  const buildInputMessageForSubmit = useCallback(
    (content: ChatUserMessage['content']): ChatUserMessage => {
      const shouldAttachCurrentFileBadge =
        settings.chatOptions.includeCurrentFileContent &&
        autoAttachCurrentFile &&
        !hasUserMessages
      const mentionables = normalizeMentionablesWithAutoCurrentFile(
        inputMessage.mentionables,
        activeFile,
        shouldAttachCurrentFileBadge,
      )
      return {
        ...inputMessage,
        content,
        reasoningLevel,
        mentionables,
        selectedSkills: inputMessage.selectedSkills ?? [],
        selectedModelIds: extractSelectedModelIds(mentionables),
      }
    },
    [
      activeFile,
      autoAttachCurrentFile,
      hasUserMessages,
      inputMessage,
      reasoningLevel,
      settings.chatOptions.includeCurrentFileContent,
    ],
  )

  const handleUserMessageSubmit = useCallback(
    async ({
      inputChatMessages,
      requestChatMessages,
      useVaultSearch,
      persistedMessageModelMap,
    }: {
      inputChatMessages: ChatMessage[]
      requestChatMessages?: ChatMessage[]
      useVaultSearch?: boolean
      persistedMessageModelMap?: Map<string, string>
    }) => {
      abortConversationRun(currentConversationId)
      setQueryProgress({
        type: 'idle',
      })

      const previousMessages = inputChatMessages.slice(0, -1)
      const autoCompactionOptions = resolveAutoContextCompactionChatOptions(
        settings.chatOptions,
      )
      let compactionForSubmit = effectiveCompactionState
      if (
        shouldTriggerAutoContextCompaction({
          previousMessages,
          chatOptions: autoCompactionOptions,
          maxContextTokens: currentConversationModel?.maxContextTokens,
          compactionState: effectiveCompactionState,
          isConversationRunActive:
            currentConversationRunSummary.isRunning ||
            currentConversationRunSummary.isWaitingApproval,
        })
      ) {
        setPendingCompactionAnchorMessageId(previousMessages.at(-1)?.id ?? null)
        try {
          const nextCompactionState =
            await compactConversation(previousMessages)
          setPendingCompactionAnchorMessageId(null)
          if (nextCompactionState) {
            compactionForSubmit = [
              ...effectiveCompactionState,
              nextCompactionState,
            ]
          }
        } catch (error) {
          setPendingCompactionAnchorMessageId(null)
          new Notice(t('chat.compaction.autoFailed'))
          console.error('Automatic context compaction failed', error)
        }
      }

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
            const { promptContent, similaritySearchResults } =
              await requestContextBuilder.compileUserMessagePrompt({
                message,
                useVaultSearch,
                onQueryProgressChange: setQueryProgress,
              })
            return {
              ...message,
              promptContent,
              similaritySearchResults,
            }
          } else if (message.role === 'user' && !message.promptContent) {
            // Ensure all user messages have prompt content
            // This is a fallback for cases where compilation was missed earlier in the process
            const { promptContent, similaritySearchResults } =
              await requestContextBuilder.compileUserMessagePrompt({
                message,
              })
            return {
              ...message,
              promptContent,
              similaritySearchResults,
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
              similaritySearchResults:
                compiledUserMessage.similaritySearchResults,
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
      forceScrollToBottom,
      createOrUpdateConversation,
      effectiveCompactionState,
      generateConversationTitle,
      chatMode,
      messageModelMap,
      reasoningLevel,
      resolveReasoningLevelForMessages,
      serializeMessageModelMap,
      settings.chatOptions,
      compactConversation,
      plugin,
      currentConversationModel?.maxContextTokens,
      currentConversationRunSummary.isRunning,
      currentConversationRunSummary.isWaitingApproval,
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
                variant: 'updated' as const,
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
          const targetFile = app.vault.getAbstractFileByPath(fileGroup.path)
          if (!(targetFile instanceof TFile)) {
            undoStateByPath.set(fileGroup.path, 'unavailable')
            continue
          }

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

          const currentContent = await app.vault.read(targetFile)
          if (
            !firstSnapshot ||
            !latestSnapshot ||
            currentContent !== latestSnapshot.afterContent
          ) {
            undoStateByPath.set(fileGroup.path, 'unavailable')
            continue
          }

          undoStateByPath.set(fileGroup.path, 'applied')
          if (currentContent !== firstSnapshot.beforeContent) {
            await app.vault.modify(targetFile, firstSnapshot.beforeContent)
          }
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

            const nextFiles = entry.summary.files.map((file, index) => {
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
      const targetFile = app.vault.getAbstractFileByPath(path)
      if (!(targetFile instanceof TFile)) {
        new Notice(t('chat.editSummary.fileMissing', '文件不存在或已被移动。'))
        return
      }

      if (!currentConversationId) {
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

  const handleActiveLeafChange = useCallback(() => {
    setActiveFile(app.workspace.getActiveFile())
  }, [app.workspace])

  useEffect(() => {
    app.workspace.on('active-leaf-change', handleActiveLeafChange)
    app.workspace.on('file-open', handleActiveLeafChange)
    return () => {
      app.workspace.off('active-leaf-change', handleActiveLeafChange)
      app.workspace.off('file-open', handleActiveLeafChange)
    }
  }, [app.workspace, handleActiveLeafChange])

  useEffect(() => {
    handleActiveLeafChange()
  }, [handleActiveLeafChange])

  const buildSelectionMentionable = useCallback(
    (selectedBlock: MentionableBlockData): MentionableBlock =>
      createSelectionBlockMentionable(selectedBlock),
    [],
  )

  const removeSelectionMentionable = useCallback(
    (mentionables: ChatUserMessage['mentionables']) =>
      mentionables.filter(
        (mentionable) =>
          !(
            mentionable.type === 'block' &&
            isSyncSelectionMentionable(mentionable)
          ),
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
          const existingSelection = prevInputMessage.mentionables.find(
            (m) => m.type === 'block' && isSyncSelectionMentionable(m),
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
            const existingSelection = message.mentionables.find(
              (m) => m.type === 'block' && isSyncSelectionMentionable(m),
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
          const existingSelection = prevInputMessage.mentionables.find(
            (m) => m.type === 'block' && isSyncSelectionMentionable(m),
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
            (m) => getMentionableKey(serializeMentionable(m)) === mentionableKey,
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

    setChatMessages((prevChatHistory) =>
      prevChatHistory.map((message) => {
        if (message.id === focusedMessageId && message.role === 'user') {
          const nextMentionables = removeSelectionMentionable(
            message.mentionables,
          )
          if (nextMentionables.length === message.mentionables.length) {
            return message
          }
          return {
            ...message,
            mentionables: nextMentionables,
            promptContent: null,
          }
        }
        return message
      }),
    )
  }, [focusedMessageId, inputMessage.id, removeSelectionMentionable])

  // 从所有消息中删除指定的 mentionable，并清空 promptContent 以便重新编译
  const handleMentionableDeleteFromAll = useCallback(
    (mentionable: ChatUserMessage['mentionables'][number]) => {
      const mentionableKey = getMentionableKey(
        serializeMentionable(mentionable),
      )
      if (mentionable.type === 'current-file') {
        updateAutoAttachCurrentFile(false)
      }

      // 从所有历史消息中删除
      setChatMessages((prevMessages) =>
        prevMessages.map((message) => {
          if (message.role !== 'user') return message
          const filtered = message.mentionables.filter(
            (m) =>
              getMentionableKey(serializeMentionable(m)) !== mentionableKey,
          )
          // 如果 mentionables 变化了，清空 promptContent 以便下次重新编译
          if (filtered.length !== message.mentionables.length) {
            return {
              ...message,
              mentionables: filtered,
              promptContent: null,
            }
          }
          return message
        }),
      )

      // 从当前输入消息中删除
      setInputMessage((prev) => ({
        ...prev,
        mentionables: prev.mentionables.filter(
          (m) => getMentionableKey(serializeMentionable(m)) !== mentionableKey,
        ),
      }))
    },
    [updateAutoAttachCurrentFile],
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
      },
    ) => {
      const mentionable = createSelectionBlockMentionable({
        ...selectedBlock,
        source: 'selection-pinned',
      })

      setAddedBlockKey(null)
      flushSync(() => {
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
      const resolvedMode =
        !Platform.isDesktop && nextMode === 'agent' ? 'chat' : nextMode

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
        resolvedMode === 'agent' &&
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
      className={`smtcmp-chat-header${
        isSidebarPlacement ? '' : ' smtcmp-chat-header--workspace'
      }`}
    >
      {onChangeView ? (
        <ViewToggle
          activeView={activeView}
          onChangeView={onChangeView}
          chatMode={chatMode}
          onChangeChatMode={handleChatModeChange}
          showComposer={isSidebarPlacement}
          disabled={false}
        />
      ) : (
        <h1 className="smtcmp-chat-header-title">
          {t('sidebar.tabs.chat', 'Chat')}
        </h1>
      )}
      {activeView === 'chat' && (
        <div className="smtcmp-chat-header-right">
          {headerContextUsage && (
            <ContextUsageRing
              promptTokens={headerContextUsage.promptTokens}
              maxContextTokens={headerContextUsage.maxContextTokens}
              label={t('chat.contextUsage', '上下文窗口占用')}
            />
          )}
          <AssistantSelector
            currentAssistantId={conversationAssistantId}
            triggerClassName={
              !isSidebarPlacement && isWorkspaceWideHeader
                ? 'smtcmp-assistant-selector-button--workspace-floating'
                : undefined
            }
            contentClassName={
              !isSidebarPlacement && isWorkspaceWideHeader
                ? 'smtcmp-assistant-selector-content--workspace-floating'
                : undefined
            }
            onAssistantChange={(assistant) => {
              handleConversationAssistantSelect(assistant.id)
            }}
          />
          <div className="smtcmp-chat-header-buttons">
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
              title={t(
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
              archiveEnabled={
                settings.chatOptions.historyArchiveEnabled ?? true
              }
              archiveThreshold={
                settings.chatOptions.historyArchiveThreshold ?? 50
              }
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

  const renderChatTimelineItem = useCallback(
    (timelineItem: ChatTimelineItem) => {
      if (timelineItem.kind === 'compaction-pending') {
        return (
          <div
            className="smtcmp-chat-compaction-pending"
            data-anchor-message-id={timelineItem.anchorMessageId}
          >
            <div className="smtcmp-chat-compaction-pending__loader">
              <DotLoader text={compactionPendingTitle} />
            </div>
            <div className="smtcmp-chat-compaction-pending__description">
              {compactionPendingDescription}
            </div>
          </div>
        )
      }

      if (timelineItem.kind === 'compaction-divider') {
        return (
          <div
            className={cx(
              'smtcmp-chat-compaction-divider',
              timelineItem.renderKey ===
                `${enteringCompactionDividerAnchorMessageId}-compact-divider` &&
                'is-entering',
            )}
          >
            <div className="smtcmp-chat-compaction-divider__title">
              {compactionDividerTitle}
            </div>
            <div className="smtcmp-chat-compaction-divider__line" />
            <div className="smtcmp-chat-compaction-divider__content">
              <div className="smtcmp-chat-compaction-divider__description">
                {compactionDividerDescription}
              </div>
            </div>
          </div>
        )
      }

      if (timelineItem.kind === 'assistant-group') {
        const messageOrGroup = timelineItem.messages
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
            activeBranchKey={activeBranchByUserMessageId.get(
              getSourceUserMessageIdForGroup(messageOrGroup) ?? '',
            )}
            suppressFooter={
              shouldSuppressCompactionAnchorFooter ||
              (isCurrentConversationRunActive &&
                timelineItem.renderKey === latestTimelineAssistantToolGroupKey)
            }
            showInlineInfo={chatSurfacePreset.assistantActions.showInlineInfo}
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
            onRecoverToolCall={handleRecoverPendingToolCall}
            editingAssistantMessageId={editingAssistantMessageId}
            onEditStart={(messageId) => {
              setEditingAssistantMessageId(messageId)
            }}
            onEditCancel={handleAssistantMessageEditCancel}
            onEditSave={handleAssistantMessageEditSave}
            onDeleteGroup={handleAssistantMessageGroupDelete}
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
            displayMentionables={
              messageOrGroup.id === firstUserMessageId
                ? messageOrGroup.mentionables
                : messageOrGroup.mentionables.filter(
                    (mentionable) => mentionable.type !== 'current-file',
                  )
            }
            chatUserInputRef={(ref) =>
              registerChatUserInputRef(messageOrGroup.id, ref)
            }
            onBlur={() => {
              if (focusedMessageId === messageOrGroup.id) {
                setFocusedMessageId(inputMessage.id)
              }
            }}
            onInputChange={(content) => {
              setChatMessages((prevChatHistory) =>
                prevChatHistory.map((msg) =>
                  msg.role === 'user' && msg.id === messageOrGroup.id
                    ? {
                        ...msg,
                        content,
                        promptContent: null,
                        similaritySearchResults: undefined,
                      }
                    : msg,
                ),
              )
            }}
            onSubmit={(content, useVaultSearch) => {
              if (
                editorStateToPlainText(content).trim() === '' &&
                messageOrGroup.mentionables.length === 0 &&
                (messageOrGroup.selectedSkills?.length ?? 0) === 0
              ) {
                return
              }
              const modelForThisMessage =
                messageModelMap.get(messageOrGroup.id) ?? conversationModelId
              const reasoningForThisMessage =
                messageReasoningMap.get(messageOrGroup.id) ??
                messageReasoningLevel
              const nextMessageModelMap = new Map(messageModelMap)
              nextMessageModelMap.set(messageOrGroup.id, modelForThisMessage)
              const editedUserMessage: ChatUserMessage = {
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
              }
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
                useVaultSearch,
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
              setChatMessages((prevChatHistory) =>
                prevChatHistory.map((msg) => {
                  if (msg.id !== messageOrGroup.id) return msg
                  if (msg.role !== 'user') return msg
                  const prevKeys = msg.mentionables.map((m) =>
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
                    ...msg,
                    mentionables,
                    promptContent: isSameMentionables
                      ? msg.promptContent
                      : null,
                    similaritySearchResults: isSameMentionables
                      ? msg.similaritySearchResults
                      : undefined,
                  }
                }),
              )
            }}
            onSelectedSkillsChange={(selectedSkills) => {
              setChatMessages((prevChatHistory) =>
                prevChatHistory.map((msg) =>
                  msg.role === 'user' && msg.id === messageOrGroup.id
                    ? {
                        ...msg,
                        selectedSkills,
                        promptContent: null,
                        snapshotRef: undefined,
                        similaritySearchResults: undefined,
                      }
                    : msg,
                ),
              )
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
              chatSurfacePreset.userMessage.allowAgentModeOption &&
              Platform.isDesktop
            }
          />
        )
      }

      if (timelineItem.kind === 'query-progress') {
        return <QueryProgress state={queryProgress} />
      }

      if (timelineItem.kind === 'continue-response') {
        return (
          <div className="smtcmp-continue-response-button-container">
            <button
              type="button"
              className="smtcmp-continue-response-button"
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
          className="smtcmp-chat-bottom-anchor"
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
      handleChatModeChange,
      handleContinueResponse,
      handleOpenEditSummaryFile,
      handleQuoteAssistantSelection,
      handleToolMessageUpdate,
      handleUndoEditSummary,
      handleUserMessageSubmit,
      inputMessage.id,
      isCurrentConversationRunActive,
      latestCompactionState?.triggerToolCallId,
      latestTimelineAssistantToolGroupKey,
      messageModelMap,
      messageReasoningMap,
      pendingCompactionAnchorMessageId,
      persistConversation,
      queryProgress,
      reasoningLevel,
      shouldHidePendingAssistantPlaceholders,
      undoingEditSummaryTarget,
    ],
  )

  return (
    <div
      ref={containerRef}
      className={containerClassName}
      style={containerStyle}
    >
      {header}
      {activeView === 'composer' ? (
        <div className="smtcmp-chat-composer-wrapper">
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
          currentConversationRunSummaryIsRunning={
            currentConversationRunSummary.isRunning
          }
          onAbortConversationRun={() =>
            abortConversationRun(currentConversationId)
          }
          onForceScrollToBottom={forceScrollToBottom}
          hasStreamingMessages={hasStreamingMessages}
          scrollToBottomLabel={t('chat.scrollToBottom', '回到底部')}
          scrollToBottomWhileStreamingLabel={t(
            'chat.scrollToBottomWhileStreaming',
            '回到底部继续跟随',
          )}
          emptyStateChatTitle={t(
            'chat.emptyState.chatTitle',
            '先想清楚，再落笔',
          )}
          emptyStateAgentTitle={t('chat.emptyState.agentTitle', '让 AI 去执行')}
          emptyStateChatDescription={t(
            'chat.emptyState.chatDescription',
            '适合提问、润色与改写，专注表达本身',
          )}
          emptyStateAgentDescription={t(
            'chat.emptyState.agentDescription',
            '启用工具链，处理搜索、读写与多步骤任务',
          )}
          footerContent={
            <>
              {(settings.chatOptions.mentionDisplayMode ?? 'inline') ===
                'badge' &&
                displayMentionablesForInput.length > 0 && (
                  <div className="smtcmp-chat-user-input-files">
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
              <div className="smtcmp-chat-input-wrapper">
                <div className="smtcmp-chat-input-settings-outer">
                  <ChatSettingsButton
                    overrides={conversationOverrides}
                    onChange={(next) => {
                      const nextOverrides = next
                        ? {
                            ...next,
                            chatMode,
                            autoAttachCurrentFile,
                          }
                        : { chatMode, autoAttachCurrentFile }
                      setConversationOverrides(nextOverrides)
                      conversationOverridesRef.current.set(
                        currentConversationId,
                        nextOverrides,
                      )
                    }}
                    currentModel={settings.chatModels?.find(
                      (m) => m.id === conversationModelId,
                    )}
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
                  onSubmit={(content, useVaultSearch) => {
                    if (
                      editorStateToPlainText(content).trim() === '' &&
                      inputMessage.mentionables.length === 0 &&
                      (inputMessage.selectedSkills?.length ?? 0) === 0
                    ) {
                      return
                    }
                    const messageForSubmit = buildInputMessageForSubmit(content)
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
                      useVaultSearch,
                      persistedMessageModelMap: nextMessageModelMap,
                    })
                    setMessageModelMap(nextMessageModelMap)
                    setMessageReasoningMap((prev) => {
                      const next = new Map(prev)
                      next.set(inputMessage.id, reasoningLevel)
                      return next
                    })
                    setInputMessage(getNewInputMessage(reasoningLevel))
                  }}
                  onFocus={() => {
                    setFocusedMessageId(inputMessage.id)
                  }}
                  mentionables={inputMessage.mentionables}
                  setMentionables={(mentionables) => {
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
                      similaritySearchResults: undefined,
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
                  conversationOverrides={conversationOverrides}
                  onConversationOverridesChange={(next) => {
                    const nextOverrides = next
                      ? {
                          ...next,
                          chatMode,
                          autoAttachCurrentFile,
                        }
                      : { chatMode, autoAttachCurrentFile }
                    setConversationOverrides(nextOverrides)
                    conversationOverridesRef.current.set(
                      currentConversationId,
                      nextOverrides,
                    )
                  }}
                  showConversationSettingsButton={false}
                  hideBadgeMentionables
                  displayMentionables={displayMentionablesForInput}
                  onDeleteFromAll={handleMentionableDeleteFromAll}
                  currentAssistantId={conversationAssistantId}
                  onSelectAssistantForConversation={
                    handleConversationAssistantSelect
                  }
                  currentChatMode={chatMode}
                  onSelectChatModeForConversation={handleChatModeChange}
                  allowAgentModeOption={Platform.isDesktop}
                  enableResize
                  onRunSlashCommand={(command) => {
                    if (command.id === 'compact-context') {
                      void handleManualContextCompaction()
                    }
                  }}
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
