import { App, Notice, TFile, TFolder } from 'obsidian'
import {
  Dispatch,
  MutableRefObject,
  SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import { v4 as uuidv4 } from 'uuid'

import { usePlugin } from '../../contexts/plugin-context'
import { resolveAssistantTimeContextEnabled } from '../../core/agent/assistant-capabilities'
import type { AgentService } from '../../core/agent/service'
import {
  type ChatRuntimeId,
  type CliChatMode,
  type CliConversationController,
  type CliRuntimeScope,
  buildCliEnvironmentContext,
} from '../../core/cli-runtime'
import type { useChatHistory } from '../../hooks/useChatHistory'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { Assistant } from '../../types/assistant.types'
import type { ChatMessage, ChatUserMessage } from '../../types/chat'
import type { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import type {
  CurrentFileViewState,
  Mentionable,
  MentionableAssistantQuote,
  MentionableBlock,
  MentionableBlockData,
  MentionableImage,
  MentionableWebSelection,
} from '../../types/mentionable'
import type { ReasoningLevel } from '../../types/reasoning'
import {
  getBlockContentHash,
  getMentionableKey,
  serializeMentionable,
} from '../../utils/chat/mentionable'
import {
  addOrUpdateMentionable,
  collectRemovedSelectionHighlightIds,
  collectSelectionHighlightIdsByMentionableKey,
  createAssistantQuoteMentionable,
  createSelectionBlockMentionable,
  getMaxAssistantQuoteNumber,
  isSyncSelectionMentionable,
} from '../../utils/chat/selection-mentionables'
import { stampUserMessageTimeContext } from '../../utils/prompt/timeContext'
import { ClaudePluginManagerModal } from '../settings/modals/ClaudePluginManagerModal'
import { McpServerStatusModal } from '../settings/modals/McpServerStatusModal'

import { ChatInputDraftHolder } from './chat-input/chatInputDraft'
import type {
  ChatUserInputProps,
  ChatUserInputRef,
} from './chat-input/ChatUserInput'
import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'
import {
  type CliChatOperationCoordinator,
  type CliChatOperationSnapshot,
  isCliConversationActive,
  prepareCliConversation,
  submitCliComposerTurn,
} from './cliChatIntegration'

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

type HandleUserMessageSubmitArgs = {
  inputChatMessages: ChatMessage[]
  requestChatMessages?: ChatMessage[]
  retryBranchTarget?: {
    branchId: string
    sourceUserMessageId: string
    branchModelId?: string
    branchLabel?: string
  }
  persistedMessageModelMap?: Map<string, string>
}

/**
 * 提交/编辑/CLI 运行时切换等一旦就绪才能提供的依赖。这些值大多来自
 * useCliRuntimeOrchestration、useChatStreamManager、会话领域函数（步骤 4
 * 前仍在 Chat.tsx），而 useChatInputController 必须在它们之前调用（CLI
 * hook 反过来消费本 hook 的 getLatestInputMessage/replaceInputMessage）。
 * 通过一个稳定的 ref 注入，Chat.tsx 在每次渲染的稍后位置写入最新值——
 * 与既有的 `mainInputSubmitStateRef`/`useLatestRef` 惯例完全一致，只是
 * ref 的创建挪到了 hook 内部，写入仍在 Chat.tsx 完成。
 */
export type ChatInputLateState = {
  reasoningLevel: ReasoningLevel
  updateHistoricalUserMessage: (
    messageId: string,
    updater: (message: ChatUserMessage) => ChatUserMessage,
  ) => void
  releaseHighlightIds: (ids: Iterable<string>) => void
  isUserMessageEffectivelyEmpty: (
    message: Pick<
      ChatUserMessage,
      'content' | 'mentionables' | 'selectedSkills'
    >,
  ) => boolean
  buildAssistantGroupBoundaryMessageIdsAfterUserRemoval: (
    sourceMessages: ChatMessage[],
    nextMessages: ChatMessage[],
    existingBoundaryMessageIds: readonly string[],
  ) => string[]
  assistantGroupBoundaryMessageIds: string[]
  setAssistantGroupBoundaryMessageIds: Dispatch<SetStateAction<string[]>>
  persistConversation: (
    messages: ChatMessage[],
    assistantGroupBoundaryIdsOverride?: readonly string[],
  ) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  currentConversationId: string
  setMessageModelMap: Dispatch<SetStateAction<Map<string, string>>>
  setMessageReasoningMap: Dispatch<SetStateAction<Map<string, ReasoningLevel>>>
  activeBranchByUserMessageIdRef: MutableRefObject<Map<string, string>>
  setActiveBranchByUserMessageId: Dispatch<SetStateAction<Map<string, string>>>
  activeFile: TFile | null
  activeViewState: CurrentFileViewState | undefined
  agentService: AgentService
  app: App
  chatMessages: ChatMessage[]
  cliChatMode: CliChatMode
  cliConversationId: string | null
  commitSentSelectionHighlights: (mentionables: Mentionable[]) => void
  conversationModelId: string
  conversationOverrides: ConversationOverrideSettings | null
  cliConversationController: CliConversationController | null
  cliOperationCoordinator: CliChatOperationCoordinator | null
  cliRuntimeScope: CliRuntimeScope | undefined
  currentConversationRunSummary: {
    isActive: boolean
    isWaitingApproval: boolean
    isWaitingUserInput: boolean
    isQueueable: boolean
  }
  createOrTouchCliConversation: ReturnType<
    typeof useChatHistory
  >['createOrTouchCliConversation']
  displayedChatMessages: ChatMessage[]
  handleUserMessageSubmit: (
    args: HandleUserMessageSubmitArgs,
  ) => void | Promise<void>
  generateConversationTitle: ReturnType<
    typeof useChatHistory
  >['generateConversationTitle']
  syncCliConversationTitle: (conversationId: string, title: string) => void
  messageModelMap: Map<string, string>
  queuedMessageEditState: {
    preservedInputMessage: ChatUserMessage
    preservedReasoningLevel: ReasoningLevel
  } | null
  setQueuedMessageEditState: Dispatch<
    SetStateAction<{
      preservedInputMessage: ChatUserMessage
      preservedReasoningLevel: ReasoningLevel
    } | null>
  >
  selectedAssistant: Assistant | null
  settings: YoloSettings
  t: (keyPath: string, fallback?: string) => string
  cliYoloEnabled: boolean
  setCliConversationId: Dispatch<SetStateAction<string | null>>
  consumeAcceptedCliDraft: (
    acceptedDraft: NonNullable<CliChatOperationSnapshot['acceptedDraft']>,
  ) => void
  conversationReasoningLevelRef: MutableRefObject<Map<string, ReasoningLevel>>
  setReasoningLevel: Dispatch<SetStateAction<ReasoningLevel>>
  chatMountedRef: MutableRefObject<boolean>
  handleManualContextCompaction: () => Promise<void>
  cliPreferenceSettingsRef: MutableRefObject<YoloSettings>
  /** Forces the CLI skills list to re-fetch, e.g. after the Claude plugin manager mutates plugins. */
  refreshCliSkills: () => void
  abortConversationRun: (conversationId: string) => void
  setConversationModelId: Dispatch<SetStateAction<string>>
  conversationModelIdRef: MutableRefObject<Map<string, string>>
  getReasoningLevelForModelId: (modelId?: string | null) => ReasoningLevel
  persistReasoningLevelForModel: (
    modelId: string,
    level: ReasoningLevel,
  ) => Promise<void>
}

export type UseChatInputControllerParams = {
  seededInputMessage: ChatUserMessage | undefined
  seededInputDraftRevision: number | undefined
  initialReasoningLevel: ReasoningLevel
  selectedBlock: MentionableBlockData | undefined
  activeRuntimeId: ChatRuntimeId
  buildNewInputMessage: (reasoningLevel: ReasoningLevel) => ChatUserMessage
  chatMessagesStateRef: MutableRefObject<ChatMessage[]>
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>
}

/**
 * 输入栏控制器：草稿状态、mentionable 增删、编辑器/网页选区同步、
 * 提交前的消息构建、以及 ChatUserInput 的全部事件处理器。
 *
 * 本 hook 必须在 useCliRuntimeOrchestration 之前调用——后者消费本 hook
 * 的 getLatestInputMessage/replaceInputMessage/inputDraftRevisionRef。
 * 但 handleMainInputSubmit 等处理器反过来需要 CLI/会话侧在本 hook 调用
 * 之后才产生的值,因此这些处理器一律通过 `lateStateRef` 读取——Chat.tsx
 * 在渲染的稍后位置（CLI hook、会话动作、useChatStreamManager 都已就绪
 * 之后）写入最新快照,写入时机与既有 `mainInputSubmitStateRef` 完全一致。
 */
export function useChatInputController({
  seededInputMessage,
  seededInputDraftRevision,
  initialReasoningLevel,
  selectedBlock,
  activeRuntimeId,
  buildNewInputMessage,
  chatMessagesStateRef,
  setChatMessages,
}: UseChatInputControllerParams) {
  const plugin = usePlugin()
  // 供 handleMainInputRunSlashCommand 打开的原生动作弹窗读取「当前」运行时——
  // 弹窗的 isActive() 在异步/稍后调用时需要实时值，不能依赖闭包捕获的
  // activeRuntimeId（每次渲染才更新一次）。写入方式与 chatMessagesStateRef 等
  // 既有 ref 一致：渲染期间直接赋值。
  const activeRuntimeIdRef = useRef(activeRuntimeId)
  activeRuntimeIdRef.current = activeRuntimeId
  const [inputMessage, setInputMessageState] = useState<ChatUserMessage>(() => {
    if (seededInputMessage) {
      return seededInputMessage
    }
    const newMessage = buildNewInputMessage(initialReasoningLevel)
    if (selectedBlock) {
      newMessage.mentionables = [
        ...newMessage.mentionables,
        createSelectionBlockMentionable(selectedBlock),
      ]
    }
    return newMessage
  })
  const inputDraftHolderRef = useRef<ChatInputDraftHolder | null>(null)
  if (!inputDraftHolderRef.current) {
    inputDraftHolderRef.current = new ChatInputDraftHolder(inputMessage)
  }
  const inputDraftHolder = inputDraftHolderRef.current
  const inputDraftRevisionRef = useRef(seededInputDraftRevision ?? 0)
  const bumpInputDraftRevision = useCallback(() => {
    inputDraftRevisionRef.current += 1
  }, [])
  const [inputReplacementVersion, setInputReplacementVersion] = useState(0)
  const inputMessageRef = useRef(inputMessage)
  const assistantQuoteSequenceRef = useRef(new Map<string, number>())
  const getLatestInputMessage = useCallback(
    () => inputDraftHolder.get(),
    [inputDraftHolder],
  )
  const getLatestInputContent = useCallback(
    () => getLatestInputMessage().content,
    [getLatestInputMessage],
  )
  const setInputMessage = useCallback(
    (updater: (message: ChatUserMessage) => ChatUserMessage) => {
      const nextMessage = inputDraftHolder.update(updater)
      bumpInputDraftRevision()
      inputMessageRef.current = nextMessage
      setInputMessageState(nextMessage)
    },
    [bumpInputDraftRevision, inputDraftHolder],
  )
  const previousInputRuntimeIdRef = useRef(activeRuntimeId)
  useEffect(() => {
    if (previousInputRuntimeIdRef.current === activeRuntimeId) return
    previousInputRuntimeIdRef.current = activeRuntimeId
    setInputMessage((message) =>
      (message.selectedSkills?.length ?? 0) > 0
        ? { ...message, selectedSkills: [] }
        : message,
    )
  }, [activeRuntimeId, setInputMessage])
  const replaceInputMessage = useCallback(
    (message: ChatUserMessage) => {
      const nextMessage = inputDraftHolder.replace(message)
      bumpInputDraftRevision()
      inputMessageRef.current = nextMessage
      setInputMessageState(nextMessage)
      setInputReplacementVersion(inputDraftHolder.getReplacementVersion())
    },
    [bumpInputDraftRevision, inputDraftHolder],
  )

  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null)
  const [addedBlockKey, setAddedBlockKey] = useState<string | null>(null)

  const chatUserInputRefs = useRef<Map<string, ChatUserInputRef>>(new Map())
  const registerChatUserInputRef = useCallback(
    (id: string, ref: ChatUserInputRef | null) => {
      if (ref) {
        chatUserInputRefs.current.set(id, ref)
      } else {
        chatUserInputRefs.current.delete(id)
      }
    },
    [],
  )

  const addMentionableToFocusedMessage = useCallback(
    (mentionable: Mentionable) => {
      setAddedBlockKey(null)

      if (!focusedMessageId || focusedMessageId === inputMessage.id) {
        setInputMessage((prevInputMessage) => {
          const mentionables = addOrUpdateMentionable(
            prevInputMessage.mentionables,
            mentionable,
          )
          if (mentionables === prevInputMessage.mentionables)
            return prevInputMessage
          return {
            ...prevInputMessage,
            mentionables,
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

          const mentionables = addOrUpdateMentionable(
            message.mentionables,
            mentionable,
          )
          if (mentionables === message.mentionables) return message

          return {
            ...message,
            mentionables,
            promptContent: null,
          }
        }),
      )
    },
    [focusedMessageId, inputMessage.id, setChatMessages, setInputMessage],
  )

  const handleQuoteAssistantSelection = useCallback(
    ({
      id,
      annotationNumber,
      conversationId,
      messageId,
      content,
      comment,
      selector,
    }: {
      id?: string
      annotationNumber?: number
      messageId: string
      conversationId: string
      content: string
      comment?: string
      selector?: MentionableAssistantQuote['selector']
    }) => {
      const targetsInput =
        !focusedMessageId || focusedMessageId === inputMessage.id
      const targetMessageId = targetsInput ? inputMessage.id : focusedMessageId
      const targetMentionables = targetsInput
        ? inputMessageRef.current.mentionables
        : (chatMessagesStateRef.current.find(
            (message): message is ChatUserMessage =>
              message.role === 'user' && message.id === targetMessageId,
          )?.mentionables ?? [])
      const existingQuote = targetMentionables.find(
        (mentionable): mentionable is MentionableAssistantQuote =>
          mentionable.type === 'assistant-quote' && mentionable.id === id,
      )
      const existingQuoteFallbackNumber = targetMentionables
        .filter(
          (mentionable): mentionable is MentionableAssistantQuote =>
            mentionable.type === 'assistant-quote',
        )
        .findIndex((mentionable) => mentionable.id === id)
      const knownSequence = Math.max(
        assistantQuoteSequenceRef.current.get(targetMessageId) ?? 0,
        getMaxAssistantQuoteNumber(targetMentionables),
      )
      const resolvedAnnotationNumber =
        existingQuote?.annotationNumber ??
        (existingQuoteFallbackNumber >= 0
          ? existingQuoteFallbackNumber + 1
          : Math.max(annotationNumber ?? 0, knownSequence + 1))
      assistantQuoteSequenceRef.current.set(
        targetMessageId,
        Math.max(knownSequence, resolvedAnnotationNumber),
      )
      addMentionableToFocusedMessage(
        createAssistantQuoteMentionable({
          id,
          annotationNumber: resolvedAnnotationNumber,
          conversationId,
          messageId,
          content,
          comment,
          selector,
        }),
      )
      if (!id) {
        window.requestAnimationFrame(() => {
          chatUserInputRefs.current.get(targetMessageId)?.focus()
        })
      }
    },
    [
      addMentionableToFocusedMessage,
      chatMessagesStateRef,
      focusedMessageId,
      inputMessage.id,
    ],
  )

  const handleDeleteAssistantQuote = useCallback(
    (id: string) => {
      const removeQuote = (mentionables: Mentionable[]) =>
        mentionables.filter(
          (mentionable) =>
            mentionable.type !== 'assistant-quote' || mentionable.id !== id,
        )

      const targetsInput =
        !focusedMessageId || focusedMessageId === inputMessage.id
      const targetMessageId = targetsInput ? inputMessage.id : focusedMessageId
      const targetMentionables = targetsInput
        ? inputMessageRef.current.mentionables
        : (chatMessagesStateRef.current.find(
            (message): message is ChatUserMessage =>
              message.role === 'user' && message.id === targetMessageId,
          )?.mentionables ?? [])
      assistantQuoteSequenceRef.current.set(
        targetMessageId,
        Math.max(
          assistantQuoteSequenceRef.current.get(targetMessageId) ?? 0,
          getMaxAssistantQuoteNumber(targetMentionables),
        ),
      )

      if (targetsInput) {
        setInputMessage((message) => ({
          ...message,
          mentionables: removeQuote(message.mentionables),
        }))
        return
      }

      setChatMessages((messages) =>
        messages.map((message) =>
          message.role === 'user' && message.id === focusedMessageId
            ? { ...message, mentionables: removeQuote(message.mentionables) }
            : message,
        ),
      )
    },
    [
      chatMessagesStateRef,
      focusedMessageId,
      inputMessage.id,
      setChatMessages,
      setInputMessage,
    ],
  )

  const buildSelectionMentionable = useCallback(
    (selection: MentionableBlockData): MentionableBlock =>
      createSelectionBlockMentionable(selection),
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
    (selectedBlockData: MentionableBlockData) => {
      if (!focusedMessageId) return

      const mentionable = buildSelectionMentionable(selectedBlockData)
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
      setChatMessages,
      setInputMessage,
    ],
  )

  const syncSelectionMentionableToInput = useCallback(
    (selectedBlockData: MentionableBlockData) => {
      const mentionable = buildSelectionMentionable(selectedBlockData)
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
    [buildSelectionMentionable, removeSelectionMentionable, setInputMessage],
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
    [removeSelectionMentionable, setInputMessage],
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
    [setInputMessage],
  )

  // === 以下依赖 CLI/会话侧稍后才产生的值,统一经 lateStateRef 注入 ===
  const lateStateRef = useRef<ChatInputLateState | null>(null)
  const getLate = useCallback((): ChatInputLateState => {
    const late = lateStateRef.current
    if (!late) {
      throw new Error(
        '[YOLO] useChatInputController: accessed before Chat.tsx hydrated lateStateRef',
      )
    }
    return late
  }, [])

  const buildInputMessageForSubmit = useCallback(
    (content: ChatUserMessage['content']): ChatUserMessage => {
      const latestInputMessage = getLatestInputMessage()
      const mentionables = latestInputMessage.mentionables
      return {
        ...latestInputMessage,
        content,
        reasoningLevel: getLate().reasoningLevel,
        mentionables,
        selectedSkills: latestInputMessage.selectedSkills ?? [],
        selectedModelIds: extractSelectedModelIds(mentionables),
      }
    },
    [getLate, getLatestInputMessage],
  )

  const clearSelectionMentionable = useCallback(() => {
    if (!focusedMessageId) return
    const late = getLate()

    if (focusedMessageId === inputMessage.id) {
      const nextMentionables = removeSelectionMentionable(
        inputMessageRef.current.mentionables,
      )
      late.releaseHighlightIds(
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
      late.releaseHighlightIds(
        collectRemovedSelectionHighlightIds(
          focusedMessage.mentionables,
          nextMentionables,
        ),
      )
    }

    late.updateHistoricalUserMessage(focusedMessageId, (message) => {
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
    chatMessagesStateRef,
    focusedMessageId,
    getLate,
    inputMessage.id,
    removeSelectionMentionable,
    setInputMessage,
  ])

  // 从所有消息中删除指定的 mentionable，并清空 promptContent 以便重新编译
  const handleMentionableDeleteFromAll = useCallback(
    (mentionable: ChatUserMessage['mentionables'][number]) => {
      const late = getLate()
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
      late.releaseHighlightIds(idsToRelease)

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

        return late.isUserMessageEffectivelyEmpty(nextMessage)
          ? []
          : [nextMessage]
      })
      const nextAssistantGroupBoundaryMessageIds =
        late.buildAssistantGroupBoundaryMessageIdsAfterUserRemoval(
          sourceMessages,
          nextMessages,
          late.assistantGroupBoundaryMessageIds,
        )

      if (didChangeHistory) {
        chatMessagesStateRef.current = nextMessages
        setChatMessages(nextMessages)
        late.setAssistantGroupBoundaryMessageIds(
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
      late.setMessageModelMap(
        (prev) =>
          new Map(
            Array.from(prev.entries()).filter(([messageId]) =>
              retainedUserMessageIds.has(messageId),
            ),
          ),
      )
      late.setMessageReasoningMap(
        (prev) =>
          new Map(
            Array.from(prev.entries()).filter(([messageId]) =>
              retainedUserMessageIds.has(messageId),
            ),
          ),
      )

      const nextActiveBranchByUserMessageId = new Map(
        Array.from(
          late.activeBranchByUserMessageIdRef.current.entries(),
        ).filter(([messageId]) => retainedUserMessageIds.has(messageId)),
      )
      late.activeBranchByUserMessageIdRef.current =
        nextActiveBranchByUserMessageId
      late.setActiveBranchByUserMessageId(nextActiveBranchByUserMessageId)

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
        void late.deleteConversation(late.currentConversationId)
        return
      }

      void late.persistConversation(
        nextMessages,
        nextAssistantGroupBoundaryMessageIds,
      )
    },
    [
      chatMessagesStateRef,
      getLate,
      inputMessage.id,
      setChatMessages,
      setInputMessage,
    ],
  )

  const handleMainInputRef = useCallback(
    (ref: ChatUserInputRef | null) => {
      registerChatUserInputRef(inputMessage.id, ref)
    },
    [inputMessage.id, registerChatUserInputRef],
  )

  const handleMainInputChange = useCallback<ChatUserInputProps['onChange']>(
    (content) => {
      inputDraftHolder.updateContent(content)
      bumpInputDraftRevision()
      inputMessageRef.current = inputDraftHolder.get()
    },
    [bumpInputDraftRevision, inputDraftHolder],
  )

  const handleMainInputSubmit = useCallback<ChatUserInputProps['onSubmit']>(
    (content) => {
      const late = getLate()
      if (
        editorStateToPlainText(content).trim() === '' &&
        inputMessageRef.current.mentionables.length === 0 &&
        (inputMessageRef.current.selectedSkills?.length ?? 0) === 0
      ) {
        return
      }

      if (activeRuntimeId !== 'yolo') {
        const runtimeId = activeRuntimeId
        const controller = late.cliConversationController
        const coordinator = late.cliOperationCoordinator
        const scope = late.cliRuntimeScope
        if (
          !controller ||
          !coordinator ||
          !scope ||
          isCliConversationActive(controller.getSnapshot())
        ) {
          return
        }

        const draftRevision = inputDraftRevisionRef.current
        const messageForSubmit = buildInputMessageForSubmit(content)
        const submission = coordinator.beginSubmission(draftRevision)
        if (!submission) return

        void (async () => {
          try {
            const environmentContext = await buildCliEnvironmentContext({
              app: late.app,
              settings: late.settings,
              currentFile: late.activeFile,
              currentFileViewState: late.activeViewState,
            })
            const result = await submitCliComposerTurn({
              settings: late.settings,
              scope,
              controller,
              runtimeId,
              userMessage: messageForSubmit,
              environmentContext,
              permissionProfile: {
                mode: late.cliChatMode,
                yoloEnabled:
                  late.cliChatMode === 'plan' ? false : late.cliYoloEnabled,
              },
              signal: submission.signal,
              onSendStarted: () => coordinator.markSending(submission.token),
              onPresented: (presentedMessage) => {
                coordinator.markPresented(submission.token, presentedMessage)
              },
              onAccepted: (acceptedMessage) => {
                if (
                  coordinator.markAccepted(submission.token, acceptedMessage) &&
                  late.chatMountedRef.current
                ) {
                  const acceptedDraft = coordinator.getSnapshot().acceptedDraft
                  if (acceptedDraft) late.consumeAcceptedCliDraft(acceptedDraft)
                }
              },
            })
            const historyConversationId = late.cliConversationId ?? uuidv4()
            await late.createOrTouchCliConversation(
              historyConversationId,
              {
                runtimeId: result.sessionRef.runtimeId,
                nativeSessionId: result.sessionRef.nativeSessionId,
                ...(result.sessionRef.sessionPathHint
                  ? { sessionPathHint: result.sessionRef.sessionPathHint }
                  : {}),
              },
              late.conversationOverrides,
            )
            if (
              late.cliConversationId === null &&
              late.chatMountedRef.current
            ) {
              late.setCliConversationId(historyConversationId)
            }
            void late
              .generateConversationTitle(historyConversationId, [
                result.userMessage,
              ])
              .then((title) => {
                if (title) {
                  late.syncCliConversationTitle(historyConversationId, title)
                }
              })
            if (late.chatMountedRef.current) {
              if (result.overlayError) {
                console.warn('[YOLO] Failed to save CLI display metadata', {
                  conversationId: historyConversationId,
                  error: result.overlayError.message,
                })
              }
            }
          } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
              return
            }
            if (late.chatMountedRef.current) {
              new Notice(
                late
                  .t(
                    'chat.cliSurface.submitError',
                    'Could not send the CLI message: {message}',
                  )
                  .replace(
                    '{message}',
                    error instanceof Error ? error.message : String(error),
                  ),
              )
            }
          } finally {
            coordinator.finishSubmission(submission.token)
          }
        })()
        return
      }

      // 新用户回合进入对话:在此固定当前时间。同时覆盖随后两条出口
      // ——入队(running 分支)与普通提交——保证两者用的都是入队/提交
      // 那一刻的时间,而非 drain 时刻。
      const messageForSubmit = stampUserMessageTimeContext(
        buildInputMessageForSubmit(content),
        resolveAssistantTimeContextEnabled(
          late.selectedAssistant,
          late.settings,
        ),
      )

      // ask_user_question parks the agent in a paused state that may outlive
      // the run itself. A new message must answer that panel first.
      if (late.currentConversationRunSummary.isWaitingUserInput) {
        new Notice(
          late.t(
            'chat.queueMessage.blockedAwaitingInput',
            '请先在对话中回答模型的提问，再发送新消息。',
          ),
        )
        return
      }

      if (late.currentConversationRunSummary.isWaitingApproval) {
        new Notice(
          late.t(
            'chat.queueMessage.blockedApproval',
            '请先批准或拒绝待审批工具，再发送新消息。',
          ),
        )
        return
      }

      // While the live loop is queueable, route the message through
      // AgentService so it can be injected at the next safe LLM boundary.
      if (late.currentConversationRunSummary.isQueueable) {
        const enqueueResult = late.agentService.enqueueUserMessage(
          late.currentConversationId,
          messageForSubmit,
        )
        if (enqueueResult === 'enqueued') {
          late.setMessageReasoningMap((prev) => {
            const next = new Map(prev)
            next.set(inputMessage.id, late.reasoningLevel)
            return next
          })
          late.commitSentSelectionHighlights(messageForSubmit.mentionables)
          if (late.queuedMessageEditState) {
            late.setReasoningLevel(
              late.queuedMessageEditState.preservedReasoningLevel,
            )
            late.conversationReasoningLevelRef.current.set(
              late.currentConversationId,
              late.queuedMessageEditState.preservedReasoningLevel,
            )
            replaceInputMessage(
              late.queuedMessageEditState.preservedInputMessage,
            )
            late.setQueuedMessageEditState(null)
          } else {
            replaceInputMessage(buildNewInputMessage(late.reasoningLevel))
          }
          return
        }
        if (enqueueResult === 'blocked_awaiting_approval') {
          new Notice(
            late.t(
              'chat.queueMessage.blockedApproval',
              '请先批准或拒绝待审批工具，再发送新消息。',
            ),
          )
          return
        }
        // 'idle' -> fall through to the normal submit path below.
      }

      if (late.currentConversationRunSummary.isActive) {
        new Notice(
          late.t(
            'chat.queueMessage.blockedActiveTool',
            '请等待当前工具调用完成后再发送新消息。',
          ),
        )
        return
      }

      const nextMessageModelMap = new Map(late.messageModelMap)
      nextMessageModelMap.set(inputMessage.id, late.conversationModelId)
      void late.handleUserMessageSubmit({
        inputChatMessages: [...late.chatMessages, messageForSubmit],
        requestChatMessages: [...late.displayedChatMessages, messageForSubmit],
        persistedMessageModelMap: nextMessageModelMap,
      })
      late.setMessageModelMap(nextMessageModelMap)
      late.setMessageReasoningMap((prev) => {
        const next = new Map(prev)
        next.set(inputMessage.id, late.reasoningLevel)
        return next
      })
      late.commitSentSelectionHighlights(messageForSubmit.mentionables)
      if (late.queuedMessageEditState) {
        late.setReasoningLevel(
          late.queuedMessageEditState.preservedReasoningLevel,
        )
        late.conversationReasoningLevelRef.current.set(
          late.currentConversationId,
          late.queuedMessageEditState.preservedReasoningLevel,
        )
        replaceInputMessage(late.queuedMessageEditState.preservedInputMessage)
        late.setQueuedMessageEditState(null)
      } else {
        replaceInputMessage(buildNewInputMessage(late.reasoningLevel))
      }
    },
    [
      activeRuntimeId,
      buildInputMessageForSubmit,
      buildNewInputMessage,
      getLate,
      inputMessage.id,
      replaceInputMessage,
    ],
  )

  const handleMainInputFocus = useCallback(() => {
    setFocusedMessageId(inputMessageRef.current.id)
  }, [])

  const handleMainInputMentionablesChange = useCallback<
    ChatUserInputProps['setMentionables']
  >(
    (mentionables) => {
      const late = getLate()
      late.releaseHighlightIds(
        collectRemovedSelectionHighlightIds(
          inputMessageRef.current.mentionables,
          mentionables,
        ),
      )
      setInputMessage((prevInputMessage) => ({
        ...prevInputMessage,
        mentionables,
      }))
    },
    [getLate, setInputMessage],
  )

  const handleMainInputSelectedSkillsChange = useCallback<
    NonNullable<ChatUserInputProps['setSelectedSkills']>
  >(
    (selectedSkills) => {
      setInputMessage((prevInputMessage) => ({
        ...prevInputMessage,
        selectedSkills,
        promptContent: null,
        snapshotRef: undefined,
      }))
    },
    [setInputMessage],
  )
  const handleMainInputRuntimeSkillsChange = useCallback<
    NonNullable<ChatUserInputProps['setSelectedSkills']>
  >(
    (selectedSkills) => {
      handleMainInputSelectedSkillsChange(
        activeRuntimeId === 'yolo' ? selectedSkills : selectedSkills.slice(-1),
      )
    },
    [activeRuntimeId, handleMainInputSelectedSkillsChange],
  )

  const handleMainInputMentionableDelete = useCallback(
    (mentionable: Mentionable) => {
      if (activeRuntimeId === 'yolo') {
        handleMentionableDeleteFromAll(mentionable)
        return
      }
      const mentionableKey = getMentionableKey(
        serializeMentionable(mentionable),
      )
      handleMainInputMentionablesChange(
        inputMessageRef.current.mentionables.filter(
          (candidate) =>
            getMentionableKey(serializeMentionable(candidate)) !==
            mentionableKey,
        ),
      )
    },
    [
      activeRuntimeId,
      handleMainInputMentionablesChange,
      handleMentionableDeleteFromAll,
    ],
  )

  const handleMainInputModelChange = useCallback<
    NonNullable<ChatUserInputProps['onModelChange']>
  >(
    (id) => {
      const late = getLate()
      const conversationId = late.currentConversationId
      late.setConversationModelId(id)
      late.conversationModelIdRef.current.set(conversationId, id)
      const nextReasoningLevel = late.getReasoningLevelForModelId(id)
      late.setReasoningLevel(nextReasoningLevel)
      late.conversationReasoningLevelRef.current.set(
        conversationId,
        nextReasoningLevel,
      )
      setInputMessage((prev) => ({
        ...prev,
        reasoningLevel: nextReasoningLevel,
      }))
    },
    [getLate, setInputMessage],
  )

  const handleMainInputReasoningChange = useCallback<
    NonNullable<ChatUserInputProps['onReasoningChange']>
  >(
    (level) => {
      const late = getLate()
      const conversationId = late.currentConversationId
      const modelId = late.conversationModelId
      late.setReasoningLevel(level)
      late.conversationReasoningLevelRef.current.set(conversationId, level)
      void late.persistReasoningLevelForModel(modelId, level)
      setInputMessage((prev) => ({
        ...prev,
        reasoningLevel: level,
      }))
    },
    [getLate, setInputMessage],
  )

  const handleMainInputRunSlashCommand = useCallback<
    NonNullable<ChatUserInputProps['onRunSlashCommand']>
  >(
    (command) => {
      const late = getLate()
      if (command.id === 'open-plugin-manager') {
        // 打开弹窗是纯 UI 导航，不改变会话状态，因此不经
        // cliOperationCoordinator.transition。
        const modal = new ClaudePluginManagerModal(late.app, plugin, {
          controller: late.cliConversationController,
          isActive: () => activeRuntimeIdRef.current === 'claude-code',
          refreshCliSkills: late.refreshCliSkills,
        })
        modal.open()
        return
      }
      if (command.id === 'open-mcp-servers') {
        if (activeRuntimeId !== 'claude-code' && activeRuntimeId !== 'codex') {
          return
        }
        const runtimeIdAtOpen = activeRuntimeId
        const modal = new McpServerStatusModal(late.app, plugin, {
          runtimeId: runtimeIdAtOpen,
          controller: late.cliConversationController,
          isActive: () => activeRuntimeIdRef.current === runtimeIdAtOpen,
        })
        modal.open()
        return
      }
      if (command.id !== 'compact-context') return
      if (
        activeRuntimeId === 'yolo' ||
        !late.cliConversationController ||
        !late.cliOperationCoordinator ||
        !late.cliRuntimeScope
      ) {
        void late.handleManualContextCompaction()
        return
      }
      if (
        isCliConversationActive(late.cliConversationController.getSnapshot())
      ) {
        new Notice(
          late.t(
            'chat.compaction.runActive',
            '请等待当前回复完成后再压缩上下文。',
          ),
        )
        return
      }
      if (late.cliConversationController.getSnapshot().messages.length === 0) {
        new Notice(
          late.t('chat.compaction.empty', '当前还没有可压缩的对话内容。'),
        )
        return
      }
      const controller = late.cliConversationController
      const coordinator = late.cliOperationCoordinator
      const scope = late.cliRuntimeScope
      void coordinator
        .transition(controller, async (isCurrent) => {
          await prepareCliConversation({
            controller,
            scope,
            runtimeId: activeRuntimeId,
            settings: late.cliPreferenceSettingsRef.current,
            permissionProfile: {
              mode: late.cliChatMode,
              yoloEnabled:
                late.cliChatMode === 'plan' ? false : late.cliYoloEnabled,
            },
          })
          if (!isCurrent()) return
          await controller.compact()
        })
        .catch((error) => {
          new Notice(
            late.t('chat.compaction.failed', '上下文压缩失败，请稍后重试。'),
          )
          console.error('Failed to compact native CLI context', error)
        })
    },
    [activeRuntimeId, getLate, plugin],
  )

  const handleMainInputAbort = useCallback(() => {
    const late = getLate()
    if (
      activeRuntimeId !== 'yolo' &&
      late.cliConversationController &&
      late.cliOperationCoordinator
    ) {
      void late.cliOperationCoordinator
        .cancelCurrentOperation(late.cliConversationController)
        .catch((error) => {
          new Notice(
            late
              .t(
                'chat.cliSurface.cancelError',
                'Could not stop the CLI run: {message}',
              )
              .replace(
                '{message}',
                error instanceof Error ? error.message : String(error),
              ),
          )
        })
      return
    }
    late.abortConversationRun(late.currentConversationId)
  }, [activeRuntimeId, getLate])

  // === ChatRef 委托的 selection/input 便捷方法 ===
  const addSelectionToChat = useCallback(
    (selectedBlockData: MentionableBlockData) => {
      const mentionable = createSelectionBlockMentionable({
        ...selectedBlockData,
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
    [focusedMessageId, inputMessage.id, setChatMessages, setInputMessage],
  )

  const addFileToChat = useCallback(
    (file: TFile) => {
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
    [focusedMessageId, inputMessage.id, setChatMessages, setInputMessage],
  )

  const addFolderToChat = useCallback(
    (folder: TFolder) => {
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
    [focusedMessageId, inputMessage.id, setChatMessages, setInputMessage],
  )

  const addImageToChat = useCallback(
    (image: MentionableImage) => {
      addMentionableToFocusedMessage(image)
    },
    [addMentionableToFocusedMessage],
  )

  const insertTextToInput = useCallback(
    (text: string) => {
      if (!focusedMessageId) return
      const inputRef = chatUserInputRefs.current.get(focusedMessageId)
      if (inputRef) {
        inputRef.insertText(text)
      }
    },
    [focusedMessageId],
  )

  const appendTextToInput = useCallback(
    (text: string) => {
      if (!text) return
      chatUserInputRefs.current.get(inputMessage.id)?.appendText(text)
    },
    [inputMessage.id],
  )

  const setMainInputText = useCallback(
    (text: string) => {
      chatUserInputRefs.current.get(inputMessage.id)?.replaceText(text)
    },
    [inputMessage.id],
  )

  const focusMessage = useCallback(() => {
    if (!focusedMessageId) return
    chatUserInputRefs.current.get(focusedMessageId)?.focus()
  }, [focusedMessageId])

  const focusMainInput = useCallback(() => {
    chatUserInputRefs.current.get(inputMessage.id)?.focus()
  }, [inputMessage.id])

  const submitMainInput = useCallback(() => {
    chatUserInputRefs.current.get(inputMessage.id)?.submit()
  }, [inputMessage.id])

  return {
    inputMessage,
    inputMessageRef,
    inputDraftHolderRef,
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

    addMentionableToFocusedMessage,
    handleQuoteAssistantSelection,
    handleDeleteAssistantQuote,

    buildSelectionMentionable,
    removeSelectionMentionable,
    syncSelectionMentionable,
    syncSelectionMentionableToInput,
    syncWebSelectionMentionableToInput,
    upsertSelectionMentionableInMainInput,
    clearSelectionMentionable,
    handleMentionableDeleteFromAll,

    buildInputMessageForSubmit,

    handleMainInputRef,
    handleMainInputChange,
    handleMainInputSubmit,
    handleMainInputFocus,
    handleMainInputMentionablesChange,
    handleMainInputSelectedSkillsChange,
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

    lateStateRef,
  }
}
