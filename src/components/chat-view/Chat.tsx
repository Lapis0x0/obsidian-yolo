import { EditorView } from '@codemirror/view'
import { useMutation } from '@tanstack/react-query'
import { Bot, CircleStop, History, MessageCircle, Plus } from 'lucide-react'
import { MarkdownView, Notice, Platform } from 'obsidian'
import type { TFile, TFolder } from 'obsidian'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { v4 as uuidv4 } from 'uuid'

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import { useMcp } from '../../contexts/mcp-context'
import { usePlugin } from '../../contexts/plugin-context'
import { useRAG } from '../../contexts/rag-context'
import { useSettings } from '../../contexts/settings-context'
import { DEFAULT_ASSISTANT_ID } from '../../core/agent/default-assistant'
import { isAssistantToolEnabled } from '../../core/agent/tool-preferences'
import { materializeTextEditPlan } from '../../core/edits/textEditEngine'
import { parseTextEditPlan } from '../../core/edits/textEditPlan'
import { getChatModelClient } from '../../core/llm/manager'
import { getLocalFileToolServerName } from '../../core/mcp/localFileTools'
import { getToolName } from '../../core/mcp/tool-name-utils'
import { selectionHighlightController } from '../../features/editor/selection-highlight/selectionHighlightController'
import { useChatHistory } from '../../hooks/useChatHistory'
import type { ApplyViewState } from '../../types/apply-view.types'
import type {
  AssistantToolMessageGroup,
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'
import type { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import type {
  MentionableBlock,
  MentionableBlockData,
  MentionableCurrentFile,
} from '../../types/mentionable'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import {
  getBlockContentHash,
  getBlockMentionableCountInfo,
  getMentionableKey,
  serializeMentionable,
} from '../../utils/chat/mentionable'
import { groupAssistantAndToolMessages } from '../../utils/chat/message-groups'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { readTFileContent } from '../../utils/obsidian'
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
import QueryProgress from './QueryProgress'
import type { QueryProgressState } from './QueryProgress'
import { useAutoScroll } from './useAutoScroll'
import { useChatStreamManager } from './useChatStreamManager'
import UserMessageItem from './UserMessageItem'
import ViewToggle from './ViewToggle'

const LOCAL_FILE_TOOL_SERVER = getLocalFileToolServerName()
const LOCAL_FS_READ_TOOL = getToolName(LOCAL_FILE_TOOL_SERVER, 'fs_read')

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
  }
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
  syncSelectionToChat: (selectedBlock: MentionableBlockData) => void
  clearSelectionFromChat: () => void
  addFileToChat: (file: TFile) => void
  addFolderToChat: (folder: TFolder) => void
  insertTextToInput: (text: string) => void
  focusMessage: () => void
  getCurrentConversationOverrides: () =>
    | ConversationOverrideSettings
    | undefined
  getCurrentConversationModelId: () => string | undefined
}

export type ChatProps = {
  selectedBlock?: MentionableBlockData
  activeView?: 'chat' | 'composer'
  onChangeView?: (view: 'chat' | 'composer') => void
  initialConversationId?: string
  onConversationContextChange?: (context: {
    currentConversationId?: string
    currentModelId?: string
    currentOverrides?: ConversationOverrideSettings
  }) => void
}

const Chat = forwardRef<ChatRef, ChatProps>((props, ref) => {
  const app = useApp()
  const plugin = usePlugin()
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
  const [addedBlockKey, setAddedBlockKey] = useState<string | null>(null)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null)
  const [currentConversationId, setCurrentConversationId] =
    useState<string>(uuidv4())
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

  const activeView = props.activeView ?? 'chat'
  const onChangeView = props.onChangeView

  const viewLabel =
    activeView === 'composer'
      ? t('sidebar.tabs.composer', 'Composer')
      : t('sidebar.tabs.chat', 'Chat')

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

  const shouldPreferToolReadMentions = useMemo(() => {
    if (chatMode === 'chat') {
      return true
    }

    const toolsEnabled = selectedAssistant?.enableTools ?? true
    const includeBuiltinTools = selectedAssistant?.includeBuiltinTools ?? true
    if (!toolsEnabled || !includeBuiltinTools) {
      return false
    }

    if (
      !selectedAssistant?.toolPreferences &&
      !selectedAssistant?.enabledToolNames
    ) {
      return true
    }

    return isAssistantToolEnabled(selectedAssistant, LOCAL_FS_READ_TOOL)
  }, [chatMode, selectedAssistant])

  // Per-conversation model id (do NOT write back to global settings)
  const conversationModelIdRef = useRef<Map<string, string>>(new Map())
  const [conversationModelId, setConversationModelId] = useState<string>(
    settings.chatModelId,
  )

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
  const submitMutationPendingRef = useRef(false)

  const groupedChatMessages: (ChatUserMessage | AssistantToolMessageGroup)[] =
    useMemo(() => {
      return groupAssistantAndToolMessages(chatMessages)
    }, [chatMessages])

  const latestAssistantToolGroupIndex = useMemo(() => {
    for (let index = groupedChatMessages.length - 1; index >= 0; index -= 1) {
      if (Array.isArray(groupedChatMessages[index])) {
        return index
      }
    }
    return -1
  }, [groupedChatMessages])

  const firstUserMessageId = useMemo(() => {
    return chatMessages.find((message) => message.role === 'user')?.id
  }, [chatMessages])

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

  const shouldShowAutoAttachBadge =
    settings.chatOptions.includeCurrentFileContent &&
    autoAttachCurrentFile &&
    !hasUserMessages &&
    Boolean(activeFile)

  const displayMentionablesForInput = useMemo(() => {
    if (!shouldShowAutoAttachBadge) return inputMessage.mentionables
    const autoAttachMentionable: MentionableCurrentFile = {
      type: 'current-file',
      file: activeFile,
    }
    return [autoAttachMentionable, ...inputMessage.mentionables]
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
  const hasStreamingMessages = useMemo(
    () =>
      chatMessages.some(
        (message) =>
          message.role === 'assistant' &&
          message.metadata?.generationState === 'streaming',
      ),
    [chatMessages],
  )

  const { autoScrollToBottom, forceScrollToBottom } = useAutoScroll({
    scrollContainerRef: chatMessagesRef,
    bottomAnchorRef,
    isStreaming: hasStreamingMessages,
  })

  const { abortActiveStreams, submitChatMutation } = useChatStreamManager({
    setChatMessages,
    autoScrollToBottom,
    requestContextBuilder,
    conversationOverrides: conversationOverrides ?? undefined,
    modelId: conversationModelId,
    chatMode,
    currentFileOverride,
    assistantIdOverride: conversationAssistantId,
  })

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
          conversationReasoningLevelRef.current.get(currentConversationId) ??
            reasoningLevel,
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
          conversationReasoningLevelRef.current.get(currentConversationId) ??
            reasoningLevel,
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
      reasoningLevel,
      serializeMessageModelMap,
    ],
  )

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

  const handleLoadConversation = useCallback(
    async (conversationId: string) => {
      try {
        abortActiveStreams()
        const conversation = await getConversationById(conversationId)
        if (!conversation) {
          throw new Error('Conversation not found')
        }
        setCurrentConversationId(conversationId)
        setChatMessages(conversation.messages)
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
        const nextMessageReasoningMap = new Map<string, ReasoningLevel>()
        conversation.messages.forEach((message) => {
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
      } catch (error) {
        new Notice('Failed to load conversation')
        console.error('Failed to load conversation', error)
      }
    },
    [
      abortActiveStreams,
      getConversationById,
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
    conversationModelId,
    conversationOverrides,
    currentConversationId,
    props.onConversationContextChange,
  ])

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
    setMessageReasoningMap(new Map())
    setChatMessages([])
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
    abortActiveStreams()
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

      abortActiveStreams()
      setCurrentConversationId(newConversationId)
      setChatMessages(nextMessages)
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
          resolvedReasoningLevel,
        )
        await updateConversationTitle(newConversationId, branchTitle)
        new Notice(t('chat.branchCreated', 'Branch created'))
      })().catch((error) => {
        new Notice(t('chat.branchCreateFailed', 'Failed to create branch'))
        console.error('Failed to create branched conversation', error)
      })
    },
    [
      abortActiveStreams,
      chatList,
      chatMode,
      conversationAssistantId,
      conversationModelId,
      conversationOverrides,
      createOrUpdateConversationImmediately,
      currentConversationId,
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
      let mentionables = inputMessage.mentionables
      const shouldAttachCurrentFileBadge =
        settings.chatOptions.includeCurrentFileContent &&
        autoAttachCurrentFile &&
        !hasUserMessages
      const hasCurrentFileMentionable = mentionables.some(
        (mentionable) => mentionable.type === 'current-file',
      )
      if (
        shouldAttachCurrentFileBadge &&
        !hasCurrentFileMentionable &&
        activeFile
      ) {
        mentionables = [
          {
            type: 'current-file',
            file: activeFile,
          },
          ...mentionables,
        ]
      }
      return {
        ...inputMessage,
        content,
        reasoningLevel,
        mentionables,
        selectedSkills: inputMessage.selectedSkills ?? [],
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
      useVaultSearch,
      persistedMessageModelMap,
    }: {
      inputChatMessages: ChatMessage[]
      useVaultSearch?: boolean
      persistedMessageModelMap?: Map<string, string>
    }) => {
      abortActiveStreams()
      setQueryProgress({
        type: 'idle',
      })

      // Update the chat history to show the new user message
      setChatMessages(inputChatMessages)
      requestAnimationFrame(() => {
        forceScrollToBottom()
      })

      const lastMessage = inputChatMessages.at(-1)
      if (lastMessage?.role !== 'user') {
        throw new Error('Last message is not a user message')
      }

      const compiledMessages = await Promise.all(
        inputChatMessages.map(async (message) => {
          if (message.role === 'user' && message.id === lastMessage.id) {
            const { promptContent, similaritySearchResults } =
              await requestContextBuilder.compileUserMessagePrompt({
                message,
                useVaultSearch,
                onQueryProgressChange: setQueryProgress,
                preferToolRead: shouldPreferToolReadMentions,
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
                preferToolRead: shouldPreferToolReadMentions,
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

      const persistedMessages = compiledMessages.map((message) => {
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
      void createOrUpdateConversation(
        currentConversationId,
        compiledMessages,
        {
          ...(conversationOverrides ?? {}),
          chatMode,
        },
        conversationModelId,
        serializeMessageModelMap(
          compiledMessages,
          persistedMessageModelMap ?? messageModelMap,
        ),
        conversationReasoningLevelRef.current.get(currentConversationId) ??
          reasoningLevel,
      )
      const requestReasoningLevel =
        resolveReasoningLevelForMessages(compiledMessages)
      submitChatMutation.mutate({
        chatMessages: compiledMessages,
        conversationId: currentConversationId,
        reasoningLevel: requestReasoningLevel,
      })
    },
    [
      submitChatMutation,
      currentConversationId,
      conversationModelId,
      conversationOverrides,
      requestContextBuilder,
      abortActiveStreams,
      forceScrollToBottom,
      createOrUpdateConversation,
      chatMode,
      messageModelMap,
      reasoningLevel,
      resolveReasoningLevelForMessages,
      serializeMessageModelMap,
      shouldPreferToolReadMentions,
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
        })
        requestAnimationFrame(() => {
          forceScrollToBottom()
        })
      }
    },
    [
      chatMessages,
      currentConversationId,
      submitChatMutation,
      getMcpManager,
      forceScrollToBottom,
      resolveReasoningLevelForMessages,
    ],
  )

  const showContinueResponseButton = useMemo(() => {
    /**
     * Display the button to continue response when:
     * 1. There is no ongoing generation
     * 2. The most recent message is a tool message
     * 3. All tool calls within that message have completed
     */

    if (submitChatMutation.isPending) return false

    const lastMessage = chatMessages.at(-1)
    if (lastMessage?.role !== 'tool') return false

    return lastMessage.toolCalls.every((toolCall) =>
      [
        ToolCallResponseStatus.Aborted,
        ToolCallResponseStatus.Rejected,
        ToolCallResponseStatus.Error,
        ToolCallResponseStatus.Success,
      ].includes(toolCall.response.status),
    )
  }, [submitChatMutation.isPending, chatMessages])

  const handleContinueResponse = useCallback(() => {
    submitChatMutation.mutate({
      chatMessages: chatMessages,
      conversationId: currentConversationId,
      reasoningLevel: resolveReasoningLevelForMessages(chatMessages),
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
    if (submitChatMutation.isPending) {
      submitMutationPendingRef.current = true
      return
    }
    if (submitMutationPendingRef.current) {
      submitMutationPendingRef.current = false
      void (async () => {
        const saved = await persistConversationImmediately(chatMessages)
        if (!saved) {
          return
        }
        await generateConversationTitle(currentConversationId, chatMessages)
      })().catch((error) => {
        console.error('Failed to generate conversation title', error)
      })
    }
  }, [
    chatMessages,
    currentConversationId,
    generateConversationTitle,
    persistConversationImmediately,
    submitChatMutation.isPending,
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
    syncSelectionToChat: (selectedBlock: MentionableBlockData) => {
      syncSelectionMentionable(selectedBlock)
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
    focusMessage: () => {
      if (!focusedMessageId) return
      chatUserInputRefs.current.get(focusedMessageId)?.focus()
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
    <div className="smtcmp-chat-header">
      {onChangeView ? (
        <ViewToggle
          activeView={activeView}
          onChangeView={onChangeView}
          chatMode={chatMode}
          onChangeChatMode={handleChatModeChange}
          disabled={false}
        />
      ) : (
        <h1 className="smtcmp-chat-header-title">{viewLabel}</h1>
      )}
      {activeView === 'chat' && (
        <div className="smtcmp-chat-header-right">
          <AssistantSelector
            currentAssistantId={conversationAssistantId}
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
            <ChatListDropdown
              chatList={chatList}
              currentConversationId={currentConversationId}
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
            >
              <History size={18} />
            </ChatListDropdown>
          </div>
        </div>
      )}
    </div>
  )

  if (activeView === 'composer') {
    return (
      <div className="smtcmp-chat-container">
        {header}
        <div className="smtcmp-chat-composer-wrapper">
          <Composer onNavigateChat={() => onChangeView?.('chat')} />
        </div>
      </div>
    )
  }

  const showEmptyState =
    groupedChatMessages.length === 0 && !submitChatMutation.isPending

  return (
    <div className="smtcmp-chat-container">
      {header}
      {showEmptyState && (
        <div className="smtcmp-chat-empty-state-overlay" aria-hidden="true">
          <div className="smtcmp-chat-empty-state">
            <div
              key={chatMode}
              className="smtcmp-chat-empty-state-icon"
              data-mode={chatMode}
            >
              {chatMode === 'agent' ? (
                <Bot size={18} strokeWidth={2} />
              ) : (
                <MessageCircle size={18} strokeWidth={2} />
              )}
            </div>
            <div className="smtcmp-chat-empty-state-title">
              {chatMode === 'agent'
                ? t('chat.emptyState.agentTitle', '让 AI 去执行')
                : t('chat.emptyState.chatTitle', '先想清楚，再落笔')}
            </div>
            <div className="smtcmp-chat-empty-state-description">
              {chatMode === 'agent'
                ? t(
                    'chat.emptyState.agentDescription',
                    '启用工具链，处理搜索、读写与多步骤任务',
                  )
                : t(
                    'chat.emptyState.chatDescription',
                    '适合提问、润色与改写，专注表达本身',
                  )}
            </div>
          </div>
        </div>
      )}
      <div className="smtcmp-chat-messages" ref={chatMessagesRef}>
        {groupedChatMessages.map((messageOrGroup, index) => {
          if (Array.isArray(messageOrGroup)) {
            return (
              <AssistantToolMessageGroupItem
                key={messageOrGroup.at(0)?.id}
                messages={messageOrGroup}
                conversationId={currentConversationId}
                suppressFooter={
                  submitChatMutation.isPending &&
                  index === latestAssistantToolGroupIndex
                }
                isApplying={applyMutation.isPending}
                activeApplyRequestKey={activeApplyRequestKey}
                onApply={handleApply}
                onToolMessageUpdate={handleToolMessageUpdate}
                editingAssistantMessageId={editingAssistantMessageId}
                onEditStart={(messageId) => {
                  setEditingAssistantMessageId(messageId)
                }}
                onEditCancel={handleAssistantMessageEditCancel}
                onEditSave={handleAssistantMessageEditSave}
                onDeleteGroup={handleAssistantMessageGroupDelete}
                onBranchGroup={handleAssistantMessageGroupBranch}
              />
            )
          }

          const messageReasoningLevel =
            messageReasoningMap.get(messageOrGroup.id) ??
            normalizeReasoningLevel(messageOrGroup.reasoningLevel) ??
            reasoningLevel

          return (
            <UserMessageItem
              key={messageOrGroup.id}
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
                // Use the model mapping for this message if exists, otherwise current conversation model
                const modelForThisMessage =
                  messageModelMap.get(messageOrGroup.id) ?? conversationModelId
                const reasoningForThisMessage =
                  messageReasoningMap.get(messageOrGroup.id) ??
                  messageReasoningLevel
                const nextMessageModelMap = new Map(messageModelMap)
                nextMessageModelMap.set(messageOrGroup.id, modelForThisMessage)
                void handleUserMessageSubmit({
                  inputChatMessages: [
                    ...groupedChatMessages
                      .slice(0, index)
                      .flatMap((messageOrGroup): ChatMessage[] =>
                        !Array.isArray(messageOrGroup)
                          ? [messageOrGroup]
                          : messageOrGroup,
                      ),
                    {
                      role: 'user',
                      content: content,
                      promptContent: null,
                      id: messageOrGroup.id,
                      reasoningLevel: reasoningForThisMessage,
                      mentionables: messageOrGroup.mentionables,
                      selectedSkills: messageOrGroup.selectedSkills ?? [],
                    },
                  ],
                  useVaultSearch,
                  persistedMessageModelMap: nextMessageModelMap,
                })
                chatUserInputRefs.current.get(inputMessage.id)?.focus()
                // Record the model used for this message id
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
                // Update both the mapping for this message and the conversation-level model
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
            />
          )
        })}
        <QueryProgress state={queryProgress} />
        {showContinueResponseButton && (
          <div className="smtcmp-continue-response-button-container">
            <button
              type="button"
              className="smtcmp-continue-response-button"
              onClick={handleContinueResponse}
            >
              <div>Continue response</div>
            </button>
          </div>
        )}
        {submitChatMutation.isPending && (
          <button
            type="button"
            onClick={abortActiveStreams}
            className="smtcmp-stop-gen-btn"
          >
            <CircleStop size={16} />
            <div>Stop generation</div>
          </button>
        )}
        <div
          ref={bottomAnchorRef}
          className="smtcmp-chat-bottom-anchor"
          aria-hidden="true"
        />
      </div>
      {(settings.chatOptions.mentionDisplayMode ?? 'inline') === 'badge' &&
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
                  onDelete={() => handleMentionableDeleteFromAll(mentionable)}
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
          key={inputMessage.id} // this is needed to clear the editor when the user submits a new message
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
            nextMessageModelMap.set(inputMessage.id, conversationModelId)
            void handleUserMessageSubmit({
              inputChatMessages: [...chatMessages, messageForSubmit],
              useVaultSearch,
              persistedMessageModelMap: nextMessageModelMap,
            })
            // Record the model used for this just-submitted input message
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
          reasoningLevel={reasoningLevel}
          onReasoningChange={(level) => {
            setReasoningLevel(level)
            conversationReasoningLevelRef.current.set(
              currentConversationId,
              level,
            )
            void persistReasoningLevelForModel(conversationModelId, level)
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
          onSelectAssistantForConversation={handleConversationAssistantSelect}
          currentChatMode={chatMode}
          onSelectChatModeForConversation={handleChatModeChange}
          allowAgentModeOption={Platform.isDesktop}
        />
      </div>
    </div>
  )
})

Chat.displayName = 'Chat'

export default Chat
