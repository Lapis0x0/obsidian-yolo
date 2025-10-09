import { useMutation } from '@tanstack/react-query'
import { Book, CircleStop, History, Plus } from 'lucide-react'
import { App, Notice } from 'obsidian'
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

import { ApplyViewState } from '../../ApplyView'
import { APPLY_VIEW_TYPE } from '../../constants'
import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import { useMcp } from '../../contexts/mcp-context'
import { useRAG } from '../../contexts/rag-context'
import { useSettings } from '../../contexts/settings-context'
import {
  LLMAPIKeyInvalidException,
  LLMAPIKeyNotSetException,
  LLMBaseUrlNotSetException,
} from '../../core/llm/exception'
import { getChatModelClient } from '../../core/llm/manager'
import { useChatHistory } from '../../hooks/useChatHistory'
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
import ChatSettingsButton from './chat-input/ChatSettingsButton'
import ChatUserInput, { ChatUserInputRef } from './chat-input/ChatUserInput'
import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'
import { ChatListDropdown } from './ChatListDropdown'
import { ChatModeDropdown } from './ChatModeDropdown'
import Composer from './Composer'
import QueryProgress, { QueryProgressState } from './QueryProgress'
import { useAutoScroll } from './useAutoScroll'
import { useChatStreamManager } from './useChatStreamManager'
import UserMessageItem from './UserMessageItem'
import ViewToggle from './ViewToggle'

// Add an empty line here
const getNewInputMessage = (
  app: App,
  includeCurrentFile: boolean,
  suppression: 'none' | 'hidden' | 'deleted',
): ChatUserMessage => {
  return {
    role: 'user',
    content: null,
    promptContent: null,
    id: uuidv4(),
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
}

const Chat = forwardRef<ChatRef, ChatProps>((props, ref) => {
  const app = useApp()
  const { settings } = useSettings()
  const { t } = useLanguage()
  const { getRAGEngine } = useRAG()
  const { getMcpManager } = useMcp()

  const {
    createOrUpdateConversation,
    deleteConversation,
    getConversationById,
    updateConversationTitle,
    chatList,
  } = useChatHistory()
  const promptGenerator = useMemo(() => {
    return new PromptGenerator(getRAGEngine, app, settings)
  }, [getRAGEngine, app, settings])

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
  const [addedBlockKey, setAddedBlockKey] = useState<string | null>(
    props.selectedBlock
      ? getMentionableKey(
          serializeMentionable({
            type: 'block',
            ...props.selectedBlock,
          }),
        )
      : null,
  )
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null)
  const [currentConversationId, setCurrentConversationId] =
    useState<string>(uuidv4())
  const [queryProgress, setQueryProgress] = useState<QueryProgressState>({
    type: 'idle',
  })
  const [chatMode, setChatMode] = useState<'rag' | 'brute'>('rag')
  const [learningMode, setLearningMode] = useState<boolean>(
    settings.chatOptions.enableLearningMode ?? false,
  )

  const superContinuationEnabled = Boolean(
    settings.continuationOptions.enableSuperContinuation,
  )
  const activeView = superContinuationEnabled
    ? (props.activeView ?? 'chat')
    : 'chat'
  const onChangeView = superContinuationEnabled ? props.onChangeView : undefined

  const viewLabel =
    activeView === 'composer'
      ? t('sidebar.tabs.composer', 'Composer')
      : t('sidebar.tabs.chat', 'Chat')

  // Per-conversation override settings (temperature, top_p, context, stream)
  const conversationOverridesRef = useRef<
    Map<string, ConversationOverrideSettings>
  >(new Map())
  const [conversationOverrides, setConversationOverrides] = useState<
    ConversationOverrideSettings | undefined
  >(undefined)

  // Per-conversation model id (do NOT write back to global settings)
  const conversationModelIdRef = useRef<Map<string, string>>(new Map())
  const [conversationModelId, setConversationModelId] = useState<string>(
    settings.chatModelId,
  )

  // Per-message model mapping for historical user messages
  const [messageModelMap, setMessageModelMap] = useState<Map<string, string>>(
    new Map(),
  )

  const groupedChatMessages: (ChatUserMessage | AssistantToolMessageGroup)[] =
    useMemo(() => {
      return groupAssistantAndToolMessages(chatMessages)
    }, [chatMessages])

  const chatUserInputRefs = useRef<Map<string, ChatUserInputRef>>(new Map())
  const chatMessagesRef = useRef<HTMLDivElement>(null)

  const { autoScrollToBottom, forceScrollToBottom } = useAutoScroll({
    scrollContainerRef: chatMessagesRef,
  })

  const { abortActiveStreams, submitChatMutation } = useChatStreamManager({
    setChatMessages,
    autoScrollToBottom,
    promptGenerator,
    chatMode,
    learningMode,
    conversationOverrides,
    modelId: conversationModelId,
  })

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

  const handleLoadConversation = async (conversationId: string) => {
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
      setConversationOverrides(conversation.overrides ?? undefined)
      if (conversation.overrides) {
        conversationOverridesRef.current.set(
          conversationId,
          conversation.overrides,
        )
      }
      const modelFromRef =
        conversationModelIdRef.current.get(conversationId) ??
        settings.chatModelId
      setConversationModelId(modelFromRef)
      // Reset per-message model mapping when switching conversation
      setMessageModelMap(new Map())
      const newInputMessage = getNewInputMessage(
        app,
        settings.chatOptions.includeCurrentFileContent,
        suppressed,
      )
      setInputMessage(newInputMessage)
      setFocusedMessageId(newInputMessage.id)
      setQueryProgress({
        type: 'idle',
      })
    } catch (error) {
      new Notice('Failed to load conversation')
      console.error('Failed to load conversation', error)
    }
  }

  const handleNewChat = (selectedBlock?: MentionableBlockData) => {
    const newId = uuidv4()
    setCurrentConversationId(newId)
    conversationSuppressionRef.current.set(newId, 'none')
    setCurrentFileSuppression('none')
    setConversationOverrides(undefined)
    conversationModelIdRef.current.set(newId, settings.chatModelId)
    setConversationModelId(settings.chatModelId)
    setMessageModelMap(new Map())
    setChatMessages([])
    const newInputMessage = getNewInputMessage(
      app,
      settings.chatOptions.includeCurrentFileContent,
      'none',
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
      setAddedBlockKey(
        getMentionableKey(serializeMentionable(mentionableBlock)),
      )
    }
    setInputMessage(newInputMessage)
    setFocusedMessageId(newInputMessage.id)
    setQueryProgress({
      type: 'idle',
    })
    abortActiveStreams()
  }

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
                chatMode,
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
                chatMode,
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
      submitChatMutation.mutate({
        chatMessages: compiledMessages,
        conversationId: currentConversationId,
      })
    },
    [
      submitChatMutation,
      currentConversationId,
      promptGenerator,
      abortActiveStreams,
      forceScrollToBottom,
      chatMode,
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

      await app.workspace.getLeaf(true).setViewState({
        type: APPLY_VIEW_TYPE,
        active: true,
        state: {
          file: activeFile,
          originalContent: activeFileContent,
          newContent: updatedFileContent,
        } satisfies ApplyViewState,
      })
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
    async (toolMessage: ChatToolMessage) => {
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
    })
  }, [submitChatMutation, chatMessages, currentConversationId])

  useEffect(() => {
    setFocusedMessageId(inputMessage.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Ensure local learningMode state is turned off if the feature is disabled in settings
  useEffect(() => {
    const enabledInSettings = settings.chatOptions.enableLearningMode ?? false
    if (!enabledInSettings && learningMode) {
      setLearningMode(false)
    }
  }, [settings.chatOptions.enableLearningMode, learningMode])

  useEffect(() => {
    const updateConversationAsync = async () => {
      try {
        if (chatMessages.length > 0) {
          createOrUpdateConversation(
            currentConversationId,
            chatMessages,
            conversationOverrides ?? null,
          )
        }
      } catch (error) {
        new Notice('Failed to save chat history')
        console.error('Failed to save chat history', error)
      }
    }
    updateConversationAsync()
  }, [
    currentConversationId,
    chatMessages,
    createOrUpdateConversation,
    conversationOverrides,
  ])

  // Updates the currentFile of the focused message (input or chat history)
  // This happens when active file changes or focused message changes
  const handleActiveLeafChange = useCallback(() => {
    // If the setting is disabled, remove any existing current-file mentionable
    if (!settings.chatOptions.includeCurrentFileContent) {
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

    // If suppressed for this conversation, do not auto-add or update current-file mentionable
    if (currentFileSuppression !== 'none') return

    // Setting enabled: keep the current-file mentionable updated
    const activeFile = app.workspace.getActiveFile()
    if (!activeFile) return

    const mentionable: Omit<MentionableCurrentFile, 'id'> = {
      type: 'current-file',
      file: activeFile,
    }

    if (!focusedMessageId) return
    if (inputMessage.id === focusedMessageId) {
      setInputMessage((prevInputMessage) => {
        const existing = prevInputMessage.mentionables.find(
          (m) => m.type === 'current-file',
        )
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
    inputMessage.id,
    settings.chatOptions.includeCurrentFileContent,
    currentFileSuppression,
  ])

  useEffect(() => {
    app.workspace.on('active-leaf-change', handleActiveLeafChange)
    return () => {
      app.workspace.off('active-leaf-change', handleActiveLeafChange)
    }
  }, [app.workspace, handleActiveLeafChange])

  // React to toggle changes immediately by syncing the current-file mentionable
  useEffect(() => {
    handleActiveLeafChange()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.chatOptions.includeCurrentFileContent])

  useImperativeHandle(ref, () => ({
    openNewChat: (selectedBlock?: MentionableBlockData) =>
      handleNewChat(selectedBlock),
    addSelectionToChat: (selectedBlock: MentionableBlockData) => {
      const mentionable: Omit<MentionableBlock, 'id'> = {
        type: 'block',
        ...selectedBlock,
      }

      setAddedBlockKey(getMentionableKey(serializeMentionable(mentionable)))

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
      return conversationOverridesRef.current.get(currentConversationId)
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
          disabled={!superContinuationEnabled}
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
              onSelect={async (conversationId) => {
                if (conversationId === currentConversationId) return
                await handleLoadConversation(conversationId)
              }}
              onDelete={async (conversationId) => {
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
              }}
              onUpdateTitle={async (conversationId, newTitle) => {
                await updateConversationTitle(conversationId, newTitle)
              }}
            >
              <History size={18} />
            </ChatListDropdown>
            <ChatModeDropdown
              mode={chatMode}
              onChange={setChatMode}
              showBruteOption={settings.chatOptions.enableBruteMode ?? false}
              showLearningOption={
                settings.chatOptions.enableLearningMode ?? false
              }
              learningEnabled={learningMode}
              onToggleLearning={setLearningMode}
            >
              <Book size={18} />
            </ChatModeDropdown>
          </div>
        </div>
      )}
    </div>
  )

  if (superContinuationEnabled && activeView === 'composer') {
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
        {groupedChatMessages.map((messageOrGroup, index) =>
          !Array.isArray(messageOrGroup) ? (
            <UserMessageItem
              key={messageOrGroup.id}
              message={messageOrGroup}
              chatUserInputRef={(ref) =>
                registerChatUserInputRef(messageOrGroup.id, ref)
              }
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
                handleUserMessageSubmit({
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
                  prevChatHistory.map((msg) =>
                    msg.id === messageOrGroup.id
                      ? { ...msg, mentionables }
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
              }}
            />
          ) : (
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
            />
          ),
        )}
        <QueryProgress state={queryProgress} />
        {showContinueResponseButton && (
          <div className="smtcmp-continue-response-button-container">
            <button
              className="smtcmp-continue-response-button"
              onClick={handleContinueResponse}
            >
              <div>Continue Response</div>
            </button>
          </div>
        )}
        {submitChatMutation.isPending && (
          <button onClick={abortActiveStreams} className="smtcmp-stop-gen-btn">
            <CircleStop size={16} />
            <div>Stop Generation</div>
          </button>
        )}
      </div>
      <div
        className="smtcmp-chat-input-wrapper"
        style={{ position: 'relative', width: '100%' }}
      >
        <div
          className="smtcmp-chat-input-settings-outer"
          style={{ position: 'absolute', top: -23, right: -3, zIndex: 3 }}
        >
          <ChatSettingsButton
            overrides={conversationOverrides}
            onChange={(next) => {
              setConversationOverrides(next)
              conversationOverridesRef.current.set(currentConversationId, next)
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
            if (editorStateToPlainText(content).trim() === '') return
            handleUserMessageSubmit({
              inputChatMessages: [
                ...chatMessages,
                { ...inputMessage, content },
              ],
              useVaultSearch,
            })
            // Record the model used for this just-submitted input message
            setMessageModelMap((prev) => {
              const next = new Map(prev)
              next.set(inputMessage.id, conversationModelId)
              return next
            })
            setInputMessage(
              getNewInputMessage(
                app,
                settings.chatOptions.includeCurrentFileContent,
                currentFileSuppression,
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
          autoFocus
          addedBlockKey={addedBlockKey}
          conversationOverrides={conversationOverrides}
          onConversationOverridesChange={(next) => {
            setConversationOverrides(next)
            conversationOverridesRef.current.set(currentConversationId, next)
          }}
          showConversationSettingsButton={false}
        />
      </div>
    </div>
  )
})

Chat.displayName = 'Chat'

export default Chat
