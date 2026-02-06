import { useMutation } from '@tanstack/react-query'
import { CircleStop, History, Plus } from 'lucide-react'
import { App, Notice, Platform, TFile, TFolder } from 'obsidian'
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
import {
  LLMAPIKeyInvalidException,
  LLMAPIKeyNotSetException,
  LLMBaseUrlNotSetException,
} from '../../core/llm/exception'
import { getChatModelClient } from '../../core/llm/manager'
import { useChatHistory } from '../../hooks/useChatHistory'
import type { ApplyViewState } from '../../types/apply-view.types'
import {
  AssistantToolMessageGroup,
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'
import { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import {
  MentionableBlock,
  MentionableBlockData,
  MentionableCurrentFile,
} from '../../types/mentionable'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { applyChangesToFile } from '../../utils/chat/apply'
import {
  getMentionableKey,
  serializeMentionable,
} from '../../utils/chat/mentionable'
import { groupAssistantAndToolMessages } from '../../utils/chat/message-groups'
import { PromptGenerator } from '../../utils/chat/promptGenerator'
import { readTFileContent } from '../../utils/obsidian'
import { ErrorModal } from '../modals/ErrorModal'

// removed Prompt Templates feature

import { AssistantSelector } from './AssistantSelector'
import AssistantToolMessageGroupItem from './AssistantToolMessageGroupItem'
import { ChatMode } from './chat-input/ChatModeSelect'
import ChatSettingsButton from './chat-input/ChatSettingsButton'
import ChatUserInput, { ChatUserInputRef } from './chat-input/ChatUserInput'
import {
  ReasoningLevel,
  getDefaultReasoningLevel,
} from './chat-input/ReasoningSelect'
import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'
import { ChatListDropdown } from './ChatListDropdown'
import Composer from './Composer'
import QueryProgress, { QueryProgressState } from './QueryProgress'
import { useAutoScroll } from './useAutoScroll'
import { useChatStreamManager } from './useChatStreamManager'
import UserMessageItem from './UserMessageItem'
import ViewToggle from './ViewToggle'

const getNewInputMessage = (
  app: App,
  includeCurrentFile: boolean,
  suppression: 'none' | 'hidden' | 'deleted',
  reasoningLevel: ReasoningLevel,
): ChatUserMessage => {
  return {
    role: 'user',
    content: null,
    promptContent: null,
    id: uuidv4(),
    reasoningLevel,
    mentionables:
      includeCurrentFile && suppression !== 'deleted'
        ? [
            {
              type: 'current-file',
              file:
                suppression === 'hidden' ? null : app.workspace.getActiveFile(),
            },
          ]
        : [],
  }
}

export type ChatRef = {
  openNewChat: (selectedBlock?: MentionableBlockData) => void
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
}

const Chat = forwardRef<ChatRef, ChatProps>((props, ref) => {
  const app = useApp()
  const plugin = usePlugin()
  const { settings } = useSettings()
  const { t } = useLanguage()
  const { getRAGEngine } = useRAG()
  const { getMcpManager } = useMcp()

  const {
    createOrUpdateConversation,
    deleteConversation,
    getConversationById,
    updateConversationTitle,
    toggleConversationPinned,
    generateConversationTitle,
    chatList,
  } = useChatHistory()
  const promptGenerator = useMemo(() => {
    return new PromptGenerator(getRAGEngine, app, settings)
  }, [getRAGEngine, app, settings])

  const initialReasoningLevel = useMemo(() => {
    const initialModel =
      settings.chatModels.find((m) => m.id === settings.chatModelId) ?? null
    return getDefaultReasoningLevel(initialModel)
  }, [settings.chatModelId, settings.chatModels])

  const normalizeReasoningLevel = useCallback(
    (value?: string): ReasoningLevel | null => {
      if (!value) return null
      const candidates: ReasoningLevel[] = [
        'off',
        'on',
        'auto',
        'low',
        'medium',
        'high',
        'extra-high',
      ]
      return candidates.includes(value as ReasoningLevel)
        ? (value as ReasoningLevel)
        : null
    },
    [],
  )

  // Per-conversation suppression: 'none' | 'hidden' | 'deleted'
  // hidden: show badge with strike-through; deleted: remove entirely
  const [currentFileSuppression, setCurrentFileSuppression] = useState<
    'none' | 'hidden' | 'deleted'
  >('none')
  const conversationSuppressionRef = useRef<
    Map<string, 'none' | 'hidden' | 'deleted'>
  >(new Map())

  const [inputMessage, setInputMessage] = useState<ChatUserMessage>(() => {
    const newMessage = getNewInputMessage(
      app,
      settings.chatOptions.includeCurrentFileContent,
      'none',
      initialReasoningLevel,
    )
    if (props.selectedBlock) {
      newMessage.mentionables = [
        ...newMessage.mentionables,
        {
          type: 'block',
          ...props.selectedBlock,
        },
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

  // Per-conversation model id (do NOT write back to global settings)
  const conversationModelIdRef = useRef<Map<string, string>>(new Map())
  const [conversationModelId, setConversationModelId] = useState<string>(
    settings.chatModelId,
  )

  // Per-message model mapping for historical user messages
  const [messageModelMap, setMessageModelMap] = useState<Map<string, string>>(
    new Map(),
  )
  const submitMutationPendingRef = useRef(false)

  const groupedChatMessages: (ChatUserMessage | AssistantToolMessageGroup)[] =
    useMemo(() => {
      return groupAssistantAndToolMessages(chatMessages)
    }, [chatMessages])

  useEffect(() => {
    inputMessageRef.current = inputMessage
  }, [inputMessage])

  useEffect(() => {
    chatMessagesStateRef.current = chatMessages
  }, [chatMessages])

  // 底部输入框仅显示当前消息的 mentionables
  const displayMentionablesForInput = useMemo(
    () => inputMessage.mentionables,
    [inputMessage.mentionables],
  )

  const chatUserInputRefs = useRef<Map<string, ChatUserInputRef>>(new Map())
  const chatMessagesRef = useRef<HTMLDivElement>(null)

  const { autoScrollToBottom, forceScrollToBottom } = useAutoScroll({
    scrollContainerRef: chatMessagesRef,
  })

  const { abortActiveStreams, submitChatMutation } = useChatStreamManager({
    setChatMessages,
    autoScrollToBottom,
    promptGenerator,
    conversationOverrides: conversationOverrides ?? undefined,
    modelId: conversationModelId,
    chatMode,
  })

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
      conversationOverrides,
      createOrUpdateConversation,
      currentConversationId,
      reasoningLevel,
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
        const suppressed =
          conversationSuppressionRef.current.get(conversationId) ?? 'none'
        setCurrentFileSuppression(suppressed)
        setConversationOverrides(conversation.overrides ?? null)
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
          conversationModelIdRef.current.get(conversationId) ??
          settings.chatModelId
        const modelForConversation =
          settings.chatModels.find((m) => m.id === modelFromRef) ?? null
        setConversationModelId(modelFromRef)
        const storedReasoningLevel = normalizeReasoningLevel(
          conversation.reasoningLevel,
        )
        const resolvedReasoningLevel =
          storedReasoningLevel ?? getDefaultReasoningLevel(modelForConversation)
        setReasoningLevel(resolvedReasoningLevel)
        conversationReasoningLevelRef.current.set(
          conversationId,
          resolvedReasoningLevel,
        )
        // Reset per-message model mapping when switching conversation
        setMessageModelMap(new Map())
        const nextMessageReasoningMap = new Map<string, ReasoningLevel>()
        conversation.messages.forEach((message) => {
          if (message.role !== 'user') return
          const messageLevel = normalizeReasoningLevel(message.reasoningLevel)
          if (messageLevel) {
            nextMessageReasoningMap.set(message.id, messageLevel)
          }
        })
        setMessageReasoningMap(nextMessageReasoningMap)
        const newInputMessage = getNewInputMessage(
          app,
          settings.chatOptions.includeCurrentFileContent &&
            !conversation.messages.some((message) => message.role === 'user'),
          suppressed,
          resolvedReasoningLevel,
        )
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
      app,
      getConversationById,
      settings.chatModelId,
      settings.chatModels,
      settings.chatOptions.includeCurrentFileContent,
      normalizeReasoningLevel,
    ],
  )

  // Load an initial conversation passed in via props (e.g., from Quick Ask)
  useEffect(() => {
    if (!props.initialConversationId) return
    void handleLoadConversation(props.initialConversationId)
  }, [handleLoadConversation, props.initialConversationId])

  const handleNewChat = (selectedBlock?: MentionableBlockData) => {
    const newId = uuidv4()
    setCurrentConversationId(newId)
    conversationSuppressionRef.current.set(newId, 'none')
    setCurrentFileSuppression('none')
    setConversationOverrides(null)
    const defaultChatMode = settings.chatOptions.chatMode ?? 'chat'
    setChatMode(
      !Platform.isDesktop && defaultChatMode === 'agent'
        ? 'chat'
        : defaultChatMode,
    )
    conversationModelIdRef.current.set(newId, settings.chatModelId)
    setConversationModelId(settings.chatModelId)
    const defaultReasoningLevel = getDefaultReasoningLevel(
      settings.chatModels.find((m) => m.id === settings.chatModelId) ?? null,
    )
    setReasoningLevel(defaultReasoningLevel)
    conversationReasoningLevelRef.current.set(newId, defaultReasoningLevel)
    setMessageModelMap(new Map())
    setMessageReasoningMap(new Map())
    setChatMessages([])
    setEditingAssistantMessageId(null)
    const newInputMessage = getNewInputMessage(
      app,
      settings.chatOptions.includeCurrentFileContent,
      'none',
      defaultReasoningLevel,
    )
    if (selectedBlock) {
      const mentionableBlock: MentionableBlock = {
        type: 'block',
        ...selectedBlock,
      }
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

  const handleUserMessageSubmit = useCallback(
    async ({
      inputChatMessages,
      useVaultSearch,
    }: {
      inputChatMessages: ChatMessage[]
      useVaultSearch?: boolean
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
              await promptGenerator.compileUserMessagePrompt({
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
              await promptGenerator.compileUserMessagePrompt({
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

      setChatMessages(compiledMessages)
      void persistConversation(compiledMessages)
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
      promptGenerator,
      abortActiveStreams,
      forceScrollToBottom,
      persistConversation,
      resolveReasoningLevelForMessages,
    ],
  )

  const applyMutation = useMutation({
    mutationFn: async ({
      blockToApply,
      chatMessages,
    }: {
      blockToApply: string
      chatMessages: ChatMessage[]
    }) => {
      const activeFile = app.workspace.getActiveFile()
      if (!activeFile) {
        throw new Error(
          'No file is currently open to apply changes. Please open a file and try again.',
        )
      }
      const activeFileContent = await readTFileContent(activeFile, app.vault)

      const { providerClient, model } = getChatModelClient({
        settings,
        modelId: settings.applyModelId,
      })

      const updatedFileContent = await applyChangesToFile({
        blockToApply,
        currentFile: activeFile,
        currentFileContent: activeFileContent,
        chatMessages,
        providerClient,
        model,
      })
      if (!updatedFileContent) {
        throw new Error('Failed to apply changes')
      }

      await plugin.openApplyReview({
        file: activeFile,
        originalContent: activeFileContent,
        newContent: updatedFileContent,
      } satisfies ApplyViewState)
    },
    onError: (error) => {
      if (
        error instanceof LLMAPIKeyNotSetException ||
        error instanceof LLMAPIKeyInvalidException ||
        error instanceof LLMBaseUrlNotSetException
      ) {
        new ErrorModal(app, 'Error', error.message, error.rawError?.message, {
          showSettingsButton: true,
        }).open()
      } else {
        new Notice(error.message)
        console.error('Failed to apply changes', error)
      }
    },
  })

  const handleApply = useCallback(
    (blockToApply: string, chatMessages: ChatMessage[]) => {
      applyMutation.mutate({ blockToApply, chatMessages })
    },
    [applyMutation],
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
      setChatMessages,
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
      void persistConversation(chatMessages)
    }
  }, [chatMessages, persistConversation, submitChatMutation.isPending])

  // 用户首次发送消息后自动生成对话标题
  // 不需要等待模型回答，只要有用户消息就触发
  // generateConversationTitle 内部会检查标题是否已经命名过
  useEffect(() => {
    if (chatMessages.length > 0 && currentConversationId) {
      const hasUserMessage = chatMessages.some((m) => m.role === 'user')
      if (hasUserMessage) {
        void generateConversationTitle(currentConversationId, chatMessages)
      }
    }
  }, [chatMessages, currentConversationId, generateConversationTitle])

  // Updates the currentFile of the focused message (input or chat history)
  // This happens when active file changes or focused message changes
  const handleActiveLeafChange = useCallback(() => {
    const inputSnapshot = inputMessageRef.current
    const chatMessagesSnapshot = chatMessagesStateRef.current
    const focusedMessage =
      focusedMessageId === inputSnapshot.id
        ? inputSnapshot
        : chatMessagesSnapshot.find(
            (message): message is ChatUserMessage =>
              message.id === focusedMessageId && message.role === 'user',
          )
    const focusedHasCurrentFile = Boolean(
      focusedMessage?.mentionables.some((m) => m.type === 'current-file'),
    )

    // If the setting is disabled, remove any existing current-file mentionable
    if (!settings.chatOptions.includeCurrentFileContent) {
      if (!focusedMessageId || !focusedHasCurrentFile) return
      if (inputSnapshot.id === focusedMessageId) {
        setInputMessage((prevInputMessage) => ({
          ...prevInputMessage,
          mentionables: prevInputMessage.mentionables.filter(
            (m) => m.type !== 'current-file',
          ),
        }))
      } else {
        setChatMessages((prevChatHistory) =>
          prevChatHistory.map((message) =>
            message.id === focusedMessageId && message.role === 'user'
              ? {
                  ...message,
                  mentionables: message.mentionables.filter(
                    (m) => m.type !== 'current-file',
                  ),
                }
              : message,
          ),
        )
      }
      return
    }

    // If suppressed for this conversation, do not auto-add or update current-file mentionable
    if (currentFileSuppression !== 'none') return

    if (!focusedHasCurrentFile) {
      const activeFile = app.workspace.getActiveFile()
      if (!activeFile || !focusedMessageId) return
      const mentionable: MentionableCurrentFile = {
        type: 'current-file',
        file: activeFile,
      }
      if (inputSnapshot.id === focusedMessageId) {
        setInputMessage((prevInputMessage) => ({
          ...prevInputMessage,
          mentionables: [mentionable, ...prevInputMessage.mentionables],
        }))
      } else {
        setChatMessages((prevChatHistory) =>
          prevChatHistory.map((message) =>
            message.id === focusedMessageId && message.role === 'user'
              ? {
                  ...message,
                  mentionables: [mentionable, ...message.mentionables],
                }
              : message,
          ),
        )
      }
      return
    }

    // Setting enabled: keep the current-file mentionable updated
    const activeFile = app.workspace.getActiveFile()
    if (!activeFile) {
      if (!focusedMessageId) return
      if (inputMessage.id === focusedMessageId) {
        setInputMessage((prevInputMessage) => ({
          ...prevInputMessage,
          mentionables: prevInputMessage.mentionables.filter(
            (m) => m.type !== 'current-file',
          ),
        }))
      } else {
        setChatMessages((prevChatHistory) =>
          prevChatHistory.map((message) =>
            message.id === focusedMessageId && message.role === 'user'
              ? {
                  ...message,
                  mentionables: message.mentionables.filter(
                    (m) => m.type !== 'current-file',
                  ),
                }
              : message,
          ),
        )
      }
      return
    }

    const mentionable: Omit<MentionableCurrentFile, 'id'> = {
      type: 'current-file',
      file: activeFile,
    }

    if (!focusedMessageId) return
    if (inputSnapshot.id === focusedMessageId) {
      setInputMessage((prevInputMessage) => {
        const existing = prevInputMessage.mentionables.find(
          (m) => m.type === 'current-file',
        )
        if (!existing) return prevInputMessage
        if (existing.file === null) return prevInputMessage
        if (existing.file.path === activeFile.path) return prevInputMessage
        // Preserve temporary hidden state (file === null)
        const nextMentionable: MentionableCurrentFile =
          existing && existing.file === null
            ? { type: 'current-file', file: null }
            : mentionable
        return {
          ...prevInputMessage,
          mentionables: [
            nextMentionable,
            ...prevInputMessage.mentionables.filter(
              (m) => m.type !== 'current-file',
            ),
          ],
        }
      })
    } else {
      setChatMessages((prevChatHistory) =>
        prevChatHistory.map((message) => {
          if (message.id === focusedMessageId && message.role === 'user') {
            const existing = message.mentionables.find(
              (m) => m.type === 'current-file',
            )
            if (!existing) return message
            if (existing.file === null) return message
            if (existing.file.path === activeFile.path) return message
            const nextMentionable: MentionableCurrentFile =
              existing && existing.file === null
                ? { type: 'current-file', file: null }
                : mentionable
            return {
              ...message,
              mentionables: [
                nextMentionable,
                ...message.mentionables.filter(
                  (m) => m.type !== 'current-file',
                ),
              ],
            }
          }
          return message
        }),
      )
    }
  }, [
    app.workspace,
    focusedMessageId,
    settings.chatOptions.includeCurrentFileContent,
    currentFileSuppression,
  ])

  useEffect(() => {
    app.workspace.on('active-leaf-change', handleActiveLeafChange)
    app.workspace.on('file-open', handleActiveLeafChange)
    return () => {
      app.workspace.off('active-leaf-change', handleActiveLeafChange)
      app.workspace.off('file-open', handleActiveLeafChange)
    }
  }, [app.workspace, handleActiveLeafChange])

  // React to toggle changes immediately by syncing the current-file mentionable
  useEffect(() => {
    handleActiveLeafChange()
  }, [handleActiveLeafChange, settings.chatOptions.includeCurrentFileContent])

  const buildSelectionMentionable = useCallback(
    (selectedBlock: MentionableBlockData): MentionableBlock => ({
      type: 'block',
      source: 'selection',
      ...selectedBlock,
    }),
    [],
  )

  const removeSelectionMentionable = useCallback(
    (mentionables: ChatUserMessage['mentionables']) =>
      mentionables.filter(
        (mentionable) =>
          !(mentionable.type === 'block' && mentionable.source === 'selection'),
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
            (m) => m.type === 'block' && m.source === 'selection',
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
              (m) => m.type === 'block' && m.source === 'selection',
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
        setCurrentFileSuppression('deleted')
        conversationSuppressionRef.current.set(currentConversationId, 'deleted')
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
    [currentConversationId],
  )

  useImperativeHandle(ref, () => ({
    openNewChat: (selectedBlock?: MentionableBlockData) =>
      handleNewChat(selectedBlock),
    addSelectionToChat: (selectedBlock: MentionableBlockData) => {
      const mentionable: Omit<MentionableBlock, 'id'> = {
        type: 'block',
        ...selectedBlock,
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

  const header = (
    <div className="smtcmp-chat-header">
      {onChangeView ? (
        <ViewToggle
          activeView={activeView}
          onChangeView={onChangeView}
          disabled={false}
        />
      ) : (
        <h1 className="smtcmp-chat-header-title">{viewLabel}</h1>
      )}
      {activeView === 'chat' && (
        <div className="smtcmp-chat-header-right">
          <AssistantSelector />
          <div className="smtcmp-chat-header-buttons">
            <button
              onClick={() => handleNewChat()}
              className="clickable-icon"
              aria-label="New Chat"
            >
              <Plus size={18} />
            </button>
            <ChatListDropdown
              chatList={chatList}
              currentConversationId={currentConversationId}
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
              onUpdateTitle={(conversationId, newTitle) => {
                void updateConversationTitle(conversationId, newTitle)
              }}
              onTogglePinned={(conversationId) => {
                void toggleConversationPinned(conversationId)
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

  return (
    <div className="smtcmp-chat-container">
      {header}
      <div className="smtcmp-chat-messages" ref={chatMessagesRef}>
        {groupedChatMessages.map((messageOrGroup, index) => {
          if (Array.isArray(messageOrGroup)) {
            return (
              <AssistantToolMessageGroupItem
                key={messageOrGroup.at(0)?.id}
                messages={messageOrGroup}
                contextMessages={groupedChatMessages
                  .slice(0, index + 1)
                  .flatMap((messageOrGroup): ChatMessage[] =>
                    !Array.isArray(messageOrGroup)
                      ? [messageOrGroup]
                      : messageOrGroup,
                  )}
                conversationId={currentConversationId}
                isApplying={applyMutation.isPending}
                onApply={handleApply}
                onToolMessageUpdate={handleToolMessageUpdate}
                editingAssistantMessageId={editingAssistantMessageId}
                onEditStart={(messageId) => {
                  setEditingAssistantMessageId(messageId)
                }}
                onEditCancel={handleAssistantMessageEditCancel}
                onEditSave={handleAssistantMessageEditSave}
                onDeleteGroup={handleAssistantMessageGroupDelete}
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
                        }
                      : msg,
                  ),
                )
              }}
              onSubmit={(content, useVaultSearch) => {
                if (editorStateToPlainText(content).trim() === '') return
                // Use the model mapping for this message if exists, otherwise current conversation model
                const modelForThisMessage =
                  messageModelMap.get(messageOrGroup.id) ?? conversationModelId
                const reasoningForThisMessage =
                  messageReasoningMap.get(messageOrGroup.id) ??
                  messageReasoningLevel
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
                    },
                  ],
                  useVaultSearch,
                })
                chatUserInputRefs.current.get(inputMessage.id)?.focus()
                // Record the model used for this message id
                setMessageModelMap((prev) => {
                  const next = new Map(prev)
                  next.set(messageOrGroup.id, modelForThisMessage)
                  return next
                })
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
                // Detect visibility toggles or deletion of current-file on historical messages
                const prevCurrent = messageOrGroup.mentionables.find(
                  (m) => m.type === 'current-file',
                )
                const nextCurrent = mentionables.find(
                  (m) => m.type === 'current-file',
                )
                const prevHad = !!prevCurrent
                const nextHas = !!nextCurrent
                const prevVisible = prevCurrent?.file != null
                const nextVisible = nextCurrent?.file != null

                if (prevHad && !nextHas) {
                  // Deleted -> suppression: deleted
                  setCurrentFileSuppression('deleted')
                  conversationSuppressionRef.current.set(
                    currentConversationId,
                    'deleted',
                  )
                  // Ensure input message removes the badge entirely
                  setInputMessage((prev) => ({
                    ...prev,
                    mentionables: prev.mentionables.filter(
                      (m) => m.type !== 'current-file',
                    ),
                  }))
                } else if (prevVisible && !nextVisible) {
                  // Hidden -> suppression: hidden
                  setCurrentFileSuppression('hidden')
                  conversationSuppressionRef.current.set(
                    currentConversationId,
                    'hidden',
                  )
                  // Ensure input message shows hidden current-file badge
                  setInputMessage((prev) => {
                    const existing = prev.mentionables.find(
                      (m) => m.type === 'current-file',
                    )
                    const others = prev.mentionables.filter(
                      (m) => m.type !== 'current-file',
                    )
                    const hidden: MentionableCurrentFile = {
                      type: 'current-file',
                      file: null,
                    }
                    return {
                      ...prev,
                      mentionables: existing
                        ? [hidden, ...others]
                        : [hidden, ...prev.mentionables],
                    }
                  })
                } else if (!prevVisible && nextVisible) {
                  // Turned visible -> unsuppress
                  setCurrentFileSuppression('none')
                  conversationSuppressionRef.current.set(
                    currentConversationId,
                    'none',
                  )
                }

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
              }}
            />
          )
        })}
        <QueryProgress state={queryProgress} />
        {showContinueResponseButton && (
          <div className="smtcmp-continue-response-button-container">
            <button
              className="smtcmp-continue-response-button"
              onClick={handleContinueResponse}
            >
              <div>Continue response</div>
            </button>
          </div>
        )}
        {submitChatMutation.isPending && (
          <button onClick={abortActiveStreams} className="smtcmp-stop-gen-btn">
            <CircleStop size={16} />
            <div>Stop generation</div>
          </button>
        )}
      </div>
      <div className="smtcmp-chat-input-wrapper">
        <div className="smtcmp-chat-input-settings-outer">
          <ChatSettingsButton
            overrides={conversationOverrides}
            onChange={(next) => {
              const nextOverrides = next
                ? {
                    ...next,
                    chatMode,
                  }
                : { chatMode }
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
          chatMode={chatMode}
          onModeChange={(nextMode) => {
            const resolvedMode =
              !Platform.isDesktop && nextMode === 'agent' ? 'chat' : nextMode
            setChatMode(resolvedMode)
            setConversationOverrides((prev) => ({
              ...(prev ?? {}),
              chatMode: resolvedMode,
            }))
            conversationOverridesRef.current.set(currentConversationId, {
              ...(conversationOverridesRef.current.get(currentConversationId) ??
                {}),
              chatMode: resolvedMode,
            })
          }}
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
            if (editorStateToPlainText(content).trim() === '') return
            void handleUserMessageSubmit({
              inputChatMessages: [
                ...chatMessages,
                { ...inputMessage, content, reasoningLevel },
              ],
              useVaultSearch,
            })
            // Record the model used for this just-submitted input message
            setMessageModelMap((prev) => {
              const next = new Map(prev)
              next.set(inputMessage.id, conversationModelId)
              return next
            })
            setMessageReasoningMap((prev) => {
              const next = new Map(prev)
              next.set(inputMessage.id, reasoningLevel)
              return next
            })
            setInputMessage(
              getNewInputMessage(
                app,
                settings.chatOptions.includeCurrentFileContent,
                currentFileSuppression,
                reasoningLevel,
              ),
            )
          }}
          onFocus={() => {
            setFocusedMessageId(inputMessage.id)
          }}
          mentionables={inputMessage.mentionables}
          setMentionables={(mentionables) => {
            setInputMessage((prevInputMessage) => {
              const prevCurrent = prevInputMessage.mentionables.find(
                (m) => m.type === 'current-file',
              )
              const nextCurrent = mentionables.find(
                (m) => m.type === 'current-file',
              )
              const prevHad = !!prevCurrent
              const nextHas = !!nextCurrent
              const prevVisible = prevCurrent?.file != null
              const nextVisible = nextCurrent?.file != null

              if (prevHad && !nextHas) {
                // Deleted -> suppression: deleted
                setCurrentFileSuppression('deleted')
                conversationSuppressionRef.current.set(
                  currentConversationId,
                  'deleted',
                )
              } else if (prevVisible && !nextVisible) {
                // Hidden -> suppression: hidden
                setCurrentFileSuppression('hidden')
                conversationSuppressionRef.current.set(
                  currentConversationId,
                  'hidden',
                )
              } else if (!prevVisible && nextVisible) {
                // Turned visible -> unsuppress
                setCurrentFileSuppression('none')
                conversationSuppressionRef.current.set(
                  currentConversationId,
                  'none',
                )
              }

              return {
                ...prevInputMessage,
                mentionables,
              }
            })
          }}
          modelId={conversationModelId}
          onModelChange={(id) => {
            setConversationModelId(id)
            conversationModelIdRef.current.set(currentConversationId, id)
          }}
          reasoningLevel={reasoningLevel}
          onReasoningChange={(level) => {
            setReasoningLevel(level)
            conversationReasoningLevelRef.current.set(
              currentConversationId,
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
                }
              : { chatMode }
            setConversationOverrides(nextOverrides)
            conversationOverridesRef.current.set(
              currentConversationId,
              nextOverrides,
            )
          }}
          showConversationSettingsButton={false}
          displayMentionables={displayMentionablesForInput}
          onDeleteFromAll={handleMentionableDeleteFromAll}
        />
      </div>
    </div>
  )
})

Chat.displayName = 'Chat'

export default Chat
