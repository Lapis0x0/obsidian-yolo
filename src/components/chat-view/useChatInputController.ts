import { Notice, TFile, TFolder } from 'obsidian'
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

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
import { useSettings } from '../../contexts/settings-context'
import { resolveAssistantTimeContextEnabled } from '../../core/agent/assistant-capabilities'
import type { AgentConversationRunSummary } from '../../core/agent/service'
import {
  type ChatRuntimeId,
  type CliChatMode,
  type CliConversationController,
  type CliRuntimeScope,
  RUNTIME_CAPABILITIES,
  isCliRuntime,
} from '../../core/cli-runtime'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { ChatMessage, ChatUserMessage } from '../../types/chat'
import type {
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
import { ClaudePluginManagerModal } from '../settings/modals/ClaudePluginManagerModal'
import { McpServerStatusModal } from '../settings/modals/McpServerStatusModal'

import { ChatInputDraftHolder } from './chat-input/chatInputDraft'
import type {
  ChatUserInputProps,
  ChatUserInputRef,
} from './chat-input/ChatUserInput'
import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'
import type { ChatSessionController } from './ChatSessionController'
import {
  type CliChatOperationCoordinator,
  isCliConversationActive,
  prepareCliConversation,
} from './cliChatIntegration'
import type { ConversationPreferencesController } from './ConversationPreferencesController'

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

/**
 * `message.content`/`mentionables`/`selectedSkills` 全空即视为空消息。纯
 * 函数——不经 hook，供本文件直接调用（`useYoloChatSession.ts` 保留一份
 * 独立实现，见其文件内注释：两处都是同一逻辑的五行纯函数，共享会造成一条
 * controller/hook 之外的横向依赖，得不偿失）。
 */
function isUserMessageEffectivelyEmpty(
  message: Pick<ChatUserMessage, 'content' | 'mentionables' | 'selectedSkills'>,
): boolean {
  const textContent = message.content
    ? editorStateToPlainText(message.content).trim()
    : ''
  return (
    textContent.length === 0 &&
    message.mentionables.length === 0 &&
    (message.selectedSkills?.length ?? 0) === 0
  )
}

/**
 * 提交/中止/压缩收归 `ChatSessionController` 后（架构治理第三步分期
 * C2），剩余字段全部是**真正**在 hook 调用顺序上晚于本 hook 才产生的值——
 * CLI 编排（useCliRuntimeOrchestration）、选区高亮会话
 * （useChatHighlightSession）、运行态摘要（useChatStreamManager）。偏好/
 * 消息态/持久化/环境类字段已清零：`app`/`settings`/`t` 本 hook 直接调用
 * `useApp()`/`useSettings()`/`useLanguage()`；`activeFile`/`activeViewState`/
 * `currentConversationId`/`assistantGroupBoundaryMessageIds`/
 * `queuedMessageEditState`/`chatMountedRef`/`getReasoningLevelForModelId`/
 * `persistReasoningLevelForModel` 在 Chat.tsx 中产生于本 hook 调用之前，
 * 直接作为 `UseChatInputControllerParams` 的普通字段传入；消息编辑/持久化
 * 工具（`updateHistoricalUserMessage`/`persist`/
 * `buildAssistantGroupBoundaryMessageIdsAfterUserRemoval`）改为直接调用
 * `sessionController` 的公开命令。
 */
export type ChatInputLateState = {
  releaseHighlightIds: (ids: Iterable<string>) => void
  commitSentSelectionHighlights: (mentionables: Mentionable[]) => void
  cliChatMode: CliChatMode
  cliConversationController: CliConversationController | null
  cliOperationCoordinator: CliChatOperationCoordinator | null
  cliRuntimeScope: CliRuntimeScope | undefined
  cliYoloEnabled: boolean
  cliPreferenceSettingsRef: MutableRefObject<YoloSettings>
  /** Forces the CLI skills list to re-fetch, e.g. after the Claude plugin manager mutates plugins. */
  refreshCliSkills: () => void
  currentConversationRunSummary: Pick<
    AgentConversationRunSummary,
    'isActive' | 'isQueueable' | 'isWaitingApproval' | 'isWaitingUserInput'
  >
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
  /**
   * 会话级偏好七件套的唯一 owner——跨渲染稳定的 controller 实例（在
   * useChatRuntimePreferences 中构造，早于本 hook 调用），事件处理器直接
   * 调用其命令 API，不再经 lateStateRef 读写。见架构治理第三步分期 C1。
   */
  preferencesController: ConversationPreferencesController
  /**
   * 消息态八件套 + 提交/中止/压缩命令的唯一 owner——同样构造于本 hook 调用
   * 之前，事件处理器直接调用其命令 API。见架构治理第三步分期 C2。
   */
  sessionController: ChatSessionController
  currentConversationId: string
  assistantGroupBoundaryMessageIds: string[]
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
  getReasoningLevelForModelId: (modelId?: string | null) => ReasoningLevel
  persistReasoningLevelForModel: (
    modelId: string,
    level: ReasoningLevel,
  ) => Promise<void>
}

/**
 * 输入栏控制器：草稿状态、mentionable 增删、编辑器/网页选区同步、
 * 提交前的消息构建、以及 ChatUserInput 的全部事件处理器。
 *
 * 本 hook 必须在 useCliRuntimeOrchestration 之前调用——后者消费本 hook
 * 的 getLatestInputMessage/replaceInputMessage/inputDraftRevisionRef。
 * 提交/中止/压缩自身已收归 `sessionController`（架构治理第三步分期
 * C2）：`handleMainInputSubmit`/`handleMainInputAbort` 只做草稿采集 +
 * 结果到 UI 反应（Notice/输入框重建）的翻译，控制器方法内部按依赖顺序
 * 普通函数调用，不受 hooks 顺序限制。剩余处理器（CLI 编排相关的
 * slash 命令分支等）仍需要 CLI 编排 hook 在本 hook 之后才产生的值,
 * 经 `ChatInputLateState`（现已大幅缩减）读取——Chat.tsx 在渲染的稍后
 * 位置（CLI hook 就绪之后）写入最新快照。
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
  preferencesController,
  sessionController,
  currentConversationId,
  assistantGroupBoundaryMessageIds,
  queuedMessageEditState,
  setQueuedMessageEditState,
  getReasoningLevelForModelId,
  persistReasoningLevelForModel,
}: UseChatInputControllerParams) {
  const plugin = usePlugin()
  const app = useApp()
  const { settings } = useSettings()
  const { t } = useLanguage()
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

  /**
   * Highest annotation number already spoken for on `targetMessageId`.
   *
   * The sequence only moves forward while annotations exist, so deleting one
   * never renumbers its siblings — the model must not see "批注2" point at
   * different text than it did a turn ago.
   */
  const resolveKnownAnnotationSequence = useCallback(
    (targetMessageId: string, targetMentionables: Mentionable[]): number =>
      Math.max(
        assistantQuoteSequenceRef.current.get(targetMessageId) ?? 0,
        getMaxAssistantQuoteNumber(targetMentionables),
      ),
    [],
  )

  /**
   * Drop the high-water mark once `remaining` holds no numbered annotation, so
   * the next one starts back at 批注1. Without it an input emptied by sending —
   * or by deleting its last annotation — would keep handing out ever-larger
   * numbers, leaving a lone "批注4" with no 1–3 anywhere.
   *
   * Called from the delete paths rather than from allocation: deletion is an
   * explicit user action whose post-state is known exactly here, whereas
   * allocation reads `inputMessageRef`, which only refreshes on render — a
   * momentarily stale read there would look like "no annotations left" and
   * silently restart the numbering mid-message.
   */
  const releaseAnnotationSequenceIfEmpty = useCallback(
    (targetMessageId: string, remaining: Mentionable[]) => {
      if (getMaxAssistantQuoteNumber(remaining) === 0) {
        assistantQuoteSequenceRef.current.delete(targetMessageId)
      }
    },
    [],
  )
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
      const knownSequence = resolveKnownAnnotationSequence(
        targetMessageId,
        targetMentionables,
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
      resolveKnownAnnotationSequence,
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
        resolveKnownAnnotationSequence(targetMessageId, targetMentionables),
      )
      releaseAnnotationSequenceIfEmpty(
        targetMessageId,
        removeQuote(targetMentionables),
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
      releaseAnnotationSequenceIfEmpty,
      resolveKnownAnnotationSequence,
      setChatMessages,
      setInputMessage,
    ],
  )

  /**
   * PDF multi-quote annotation (docs/plans/2026-08-16-pdf-annotation-quotes.md).
   * Inserts a `block` mentionable that carries an `annotationNumber` — drawn
   * from the same shared pool as assistant-quote annotations (architecture
   * decision A) — plus an empty `comment` for the PDF-side bubble editor to
   * fill in. Returns the resolved number so the caller (ultimately
   * `pdfSelectionHighlightController`) can render "批注N" on the bubble
   * without ever assigning the number itself.
   *
   * Deliberately does NOT go through `addMentionableToFocusedMessage` /
   * `addOrUpdateMentionable`: that path dedupes blocks by `getMentionableKey`
   * at insertion time, which is correct for the existing add-to-sidebar
   * "reference this text" flow but wrong here — two distinct annotations
   * that happen to select the same repeated substring on a page (same
   * file/line/page/contentHash) must both survive as separate mentionables,
   * the same way assistant quotes stay distinct via their own `id`. This is
   * only half the fix, though: `getMentionableKey`'s `block` branch also
   * folds `annotationNumber` into the key, so every *other* place that keys
   * blocks (input-mirroring in `MessageInputCore`, delete-by-key) treats
   * same-text annotations as distinct too — without that, both entries
   * would survive in this array but collide everywhere downstream.
   */
  const handleQuotePdfSelection = useCallback(
    (selectedBlock: MentionableBlockData): number => {
      const targetsInput =
        !focusedMessageId || focusedMessageId === inputMessage.id
      const targetMessageId = targetsInput ? inputMessage.id : focusedMessageId
      const targetMentionables = targetsInput
        ? inputMessageRef.current.mentionables
        : (chatMessagesStateRef.current.find(
            (message): message is ChatUserMessage =>
              message.role === 'user' && message.id === targetMessageId,
          )?.mentionables ?? [])
      const knownSequence = resolveKnownAnnotationSequence(
        targetMessageId,
        targetMentionables,
      )
      const annotationNumber = knownSequence + 1
      assistantQuoteSequenceRef.current.set(targetMessageId, annotationNumber)

      const mentionable = createSelectionBlockMentionable({
        ...selectedBlock,
        source: 'selection-pinned',
        comment: selectedBlock.comment ?? '',
        annotationNumber,
      })

      setAddedBlockKey(null)
      if (targetsInput) {
        setInputMessage((prevInputMessage) => ({
          ...prevInputMessage,
          mentionables: [...prevInputMessage.mentionables, mentionable],
          promptContent: null,
        }))
      } else {
        setChatMessages((prevChatHistory) =>
          prevChatHistory.map((message) =>
            message.id === targetMessageId && message.role === 'user'
              ? {
                  ...message,
                  mentionables: [...message.mentionables, mentionable],
                  promptContent: null,
                }
              : message,
          ),
        )
      }
      return annotationNumber
    },
    [
      chatMessagesStateRef,
      focusedMessageId,
      inputMessage.id,
      resolveKnownAnnotationSequence,
      setChatMessages,
      setInputMessage,
    ],
  )

  /**
   * The one deps channel between the PDF-side bubble editor (rendered
   * imperatively by `pdfSelectionHighlightController`, not React) and chat
   * mentionable state — architecture decision B. `patch: null` removes the
   * mentionable (bubble right-click delete, or Esc on a still-new draft);
   * otherwise patches its `comment` on every keystroke, mirroring
   * `handleCommentChange` for assistant quotes.
   *
   * Targets whichever message actually holds a `block` mentionable with this
   * `highlightId` — the main input, or one of the historical user messages —
   * found by searching, not by `focusedMessageId`. The bubble can be edited
   * long after focus has moved to a different message (or a different chat
   * leaf entirely — see `chatViewNavigator.updatePdfQuoteMention`, which
   * broadcasts to every open leaf and relies on this search to no-op on the
   * ones that don't own the id).
   */
  const updatePdfQuoteMention = useCallback(
    (highlightId: string, patch: { comment: string } | null) => {
      const hasHighlight = (mentionables: Mentionable[]): boolean =>
        mentionables.some(
          (mentionable) =>
            mentionable.type === 'block' &&
            mentionable.highlightId === highlightId,
        )
      const applyPatch = (mentionables: Mentionable[]): Mentionable[] => {
        if (patch === null) {
          return mentionables.filter(
            (mentionable) =>
              !(
                mentionable.type === 'block' &&
                mentionable.highlightId === highlightId
              ),
          )
        }
        return mentionables.map((mentionable) =>
          mentionable.type === 'block' &&
          mentionable.highlightId === highlightId
            ? { ...mentionable, comment: patch.comment }
            : mentionable,
        )
      }

      if (hasHighlight(inputMessageRef.current.mentionables)) {
        if (patch === null) {
          releaseAnnotationSequenceIfEmpty(
            inputMessageRef.current.id,
            applyPatch(inputMessageRef.current.mentionables),
          )
        }
        setInputMessage((prevInputMessage) => ({
          ...prevInputMessage,
          mentionables: applyPatch(prevInputMessage.mentionables),
        }))
        return
      }

      if (patch === null) {
        const owner = chatMessagesStateRef.current.find(
          (message): message is ChatUserMessage =>
            message.role === 'user' && hasHighlight(message.mentionables),
        )
        if (owner) {
          releaseAnnotationSequenceIfEmpty(
            owner.id,
            applyPatch(owner.mentionables),
          )
        }
      }

      setChatMessages((prevChatHistory) =>
        prevChatHistory.map((message) =>
          message.role === 'user' && hasHighlight(message.mentionables)
            ? { ...message, mentionables: applyPatch(message.mentionables) }
            : message,
        ),
      )
    },
    [
      chatMessagesStateRef,
      releaseAnnotationSequenceIfEmpty,
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
        reasoningLevel: preferencesController.getSnapshot().reasoningLevel,
        mentionables,
        selectedSkills: latestInputMessage.selectedSkills ?? [],
        selectedModelIds: extractSelectedModelIds(mentionables),
      }
    },
    [getLatestInputMessage, preferencesController],
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

    sessionController.updateHistoricalUserMessage(
      focusedMessageId,
      (message) => {
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
      },
    )
  }, [
    chatMessagesStateRef,
    focusedMessageId,
    getLate,
    inputMessage.id,
    removeSelectionMentionable,
    sessionController,
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

        return isUserMessageEffectivelyEmpty(nextMessage) ? [] : [nextMessage]
      })
      const nextAssistantGroupBoundaryMessageIds =
        sessionController.buildAssistantGroupBoundaryMessageIdsAfterUserRemoval(
          sourceMessages,
          nextMessages,
          assistantGroupBoundaryMessageIds,
        )

      if (didChangeHistory) {
        chatMessagesStateRef.current = nextMessages
        setChatMessages(nextMessages)
        sessionController.setAssistantGroupBoundaryMessageIds(
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
      sessionController.setMessageModelMap(
        (prev) =>
          new Map(
            Array.from(prev.entries()).filter(([messageId]) =>
              retainedUserMessageIds.has(messageId),
            ),
          ),
      )
      sessionController.setMessageReasoningMap(
        (prev) =>
          new Map(
            Array.from(prev.entries()).filter(([messageId]) =>
              retainedUserMessageIds.has(messageId),
            ),
          ),
      )

      const nextActiveBranchByUserMessageId = new Map(
        Array.from(
          sessionController.activeBranchByUserMessageIdRef.current.entries(),
        ).filter(([messageId]) => retainedUserMessageIds.has(messageId)),
      )
      sessionController.activeBranchByUserMessageIdRef.current =
        nextActiveBranchByUserMessageId
      sessionController.setActiveBranchByUserMessageId(
        nextActiveBranchByUserMessageId,
      )

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

      sessionController.syncAgentConversationMessages(nextMessages)
      void sessionController
        .persist(nextMessages, nextAssistantGroupBoundaryMessageIds)
        .then((ok) => {
          if (!ok) new Notice('Failed to save chat history')
        })
    },
    [
      assistantGroupBoundaryMessageIds,
      chatMessagesStateRef,
      getLate,
      inputMessage.id,
      sessionController,
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

  /**
   * Draft collection + result-to-UI translation only — the actual submit
   * orchestration (yolo gating, CLI turn submission) lives in
   * `sessionController.submit()` (架构治理第三步分期 C2). Notice text and
   * the post-submit input-box rebuild are UI concerns and stay here.
   */
  const handleMainInputSubmit = useCallback<ChatUserInputProps['onSubmit']>(
    (content) => {
      if (
        editorStateToPlainText(content).trim() === '' &&
        inputMessageRef.current.mentionables.length === 0 &&
        (inputMessageRef.current.selectedSkills?.length ?? 0) === 0
      ) {
        return
      }

      const late = getLate()
      const message = buildInputMessageForSubmit(content)
      const assistant =
        settings.assistants.find(
          (candidate) =>
            candidate.id ===
            preferencesController.getSnapshot().conversationAssistantId,
        ) ?? null

      const finishSubmitUi = (submittedMessage: ChatUserMessage) => {
        late.commitSentSelectionHighlights(submittedMessage.mentionables)
        if (queuedMessageEditState) {
          preferencesController.setReasoningLevel(
            queuedMessageEditState.preservedReasoningLevel,
          )
          preferencesController.conversationReasoningLevelRef.current.set(
            currentConversationId,
            queuedMessageEditState.preservedReasoningLevel,
          )
          replaceInputMessage(queuedMessageEditState.preservedInputMessage)
          setQueuedMessageEditState(null)
        } else {
          replaceInputMessage(
            buildNewInputMessage(
              preferencesController.getSnapshot().reasoningLevel,
            ),
          )
        }
      }

      const result = sessionController.submit({
        runtimeId: activeRuntimeId,
        message,
        assistantTimeContextEnabled: resolveAssistantTimeContextEnabled(
          assistant,
          settings,
        ),
        currentConversationRunSummary: late.currentConversationRunSummary,
      })

      switch (result.kind) {
        case 'cli_unavailable':
        case 'cli_busy':
        case 'cli_submission_blocked':
          // Mirrors the pre-C2 silent `return` — the composer stays as-is,
          // no Notice.
          return
        case 'cli_submitted':
          void result.settled.then((outcome) => {
            if (outcome.kind !== 'error') return
            new Notice(
              t(
                'chat.cliSurface.submitError',
                'Could not send the CLI message: {message}',
              ).replace('{message}', outcome.message),
            )
          })
          return
        case 'blocked_waiting_user_input':
          new Notice(
            t(
              'chat.queueMessage.blockedAwaitingInput',
              '请先在对话中回答模型的提问，再发送新消息。',
            ),
          )
          return
        case 'blocked_waiting_approval':
        case 'blocked_enqueue_awaiting_approval':
          new Notice(
            t(
              'chat.queueMessage.blockedApproval',
              '请先批准或拒绝待审批工具，再发送新消息。',
            ),
          )
          return
        case 'blocked_active_tool':
          new Notice(
            t(
              'chat.queueMessage.blockedActiveTool',
              '请等待当前工具调用完成后再发送新消息。',
            ),
          )
          return
        case 'enqueued':
        case 'submitted':
          finishSubmitUi(result.message)
          return
      }
    },
    [
      activeRuntimeId,
      buildInputMessageForSubmit,
      buildNewInputMessage,
      currentConversationId,
      getLate,
      preferencesController,
      queuedMessageEditState,
      replaceInputMessage,
      sessionController,
      setQueuedMessageEditState,
      settings,
      t,
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
      preferencesController.setConversationModelId(id)
      preferencesController.conversationModelIdRef.current.set(
        currentConversationId,
        id,
      )
      const nextReasoningLevel = getReasoningLevelForModelId(id)
      preferencesController.setReasoningLevel(nextReasoningLevel)
      preferencesController.conversationReasoningLevelRef.current.set(
        currentConversationId,
        nextReasoningLevel,
      )
      setInputMessage((prev) => ({
        ...prev,
        reasoningLevel: nextReasoningLevel,
      }))
    },
    [
      currentConversationId,
      getReasoningLevelForModelId,
      preferencesController,
      setInputMessage,
    ],
  )

  const handleMainInputReasoningChange = useCallback<
    NonNullable<ChatUserInputProps['onReasoningChange']>
  >(
    (level) => {
      const modelId = preferencesController.getSnapshot().conversationModelId
      preferencesController.setReasoningLevel(level)
      preferencesController.conversationReasoningLevelRef.current.set(
        currentConversationId,
        level,
      )
      void persistReasoningLevelForModel(modelId, level)
      setInputMessage((prev) => ({
        ...prev,
        reasoningLevel: level,
      }))
    },
    [
      currentConversationId,
      persistReasoningLevelForModel,
      preferencesController,
      setInputMessage,
    ],
  )

  const handleMainInputRunSlashCommand = useCallback<
    NonNullable<ChatUserInputProps['onRunSlashCommand']>
  >(
    (command) => {
      const late = getLate()
      if (command.id === 'open-plugin-manager') {
        // 打开弹窗是纯 UI 导航，不改变会话状态，因此不经
        // cliOperationCoordinator.transition。
        const modal = new ClaudePluginManagerModal(app, plugin, {
          controller: late.cliConversationController,
          isActive: () => activeRuntimeIdRef.current === 'claude-code',
          refreshCliSkills: late.refreshCliSkills,
        })
        modal.open()
        return
      }
      if (command.id === 'open-mcp-servers') {
        if (
          !isCliRuntime(activeRuntimeId) ||
          !RUNTIME_CAPABILITIES[activeRuntimeId].hasNativeMcpPanel
        ) {
          return
        }
        const runtimeIdAtOpen = activeRuntimeId
        const modal = new McpServerStatusModal(app, plugin, {
          runtimeId: runtimeIdAtOpen,
          controller: late.cliConversationController,
          isActive: () => activeRuntimeIdRef.current === runtimeIdAtOpen,
        })
        modal.open()
        return
      }
      if (command.id !== 'compact-context') return
      if (!RUNTIME_CAPABILITIES[activeRuntimeId].supportsContextCompaction) {
        return
      }
      if (
        activeRuntimeId === 'yolo' ||
        !late.cliConversationController ||
        !late.cliOperationCoordinator ||
        !late.cliRuntimeScope
      ) {
        void sessionController
          .compactContext({
            currentConversationRunSummary: late.currentConversationRunSummary,
          })
          .then((result) => {
            switch (result.kind) {
              case 'blocked_waiting_approval':
                new Notice(
                  t(
                    'chat.compaction.waitingApproval',
                    '请先处理当前待确认的工具调用，再压缩上下文。',
                  ),
                )
                return
              case 'blocked_active':
                new Notice(
                  t(
                    'chat.compaction.runActive',
                    '请等待当前回复完成后再压缩上下文。',
                  ),
                )
                return
              case 'empty':
                new Notice(
                  t('chat.compaction.empty', '当前还没有可压缩的对话内容。'),
                )
                return
              case 'compacted':
                new Notice(
                  t(
                    'chat.compaction.success',
                    '已压缩较早上下文，后续回复将基于摘要继续。',
                  ),
                )
                return
              case 'failed':
                new Notice(
                  t('chat.compaction.failed', '上下文压缩失败，请稍后重试。'),
                )
                return
            }
          })
        return
      }
      if (
        isCliConversationActive(late.cliConversationController.getSnapshot())
      ) {
        new Notice(
          t('chat.compaction.runActive', '请等待当前回复完成后再压缩上下文。'),
        )
        return
      }
      if (late.cliConversationController.getSnapshot().messages.length === 0) {
        new Notice(t('chat.compaction.empty', '当前还没有可压缩的对话内容。'))
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
            t('chat.compaction.failed', '上下文压缩失败，请稍后重试。'),
          )
          console.error('Failed to compact native CLI context', error)
        })
    },
    [activeRuntimeId, app, getLate, plugin, sessionController, t],
  )

  const handleMainInputAbort = useCallback(() => {
    const result = sessionController.abortRun({ runtimeId: activeRuntimeId })
    if (result.kind === 'cli_cancelling') {
      void result.settled.then((outcome) => {
        if (outcome.ok) return
        new Notice(
          t(
            'chat.cliSurface.cancelError',
            'Could not stop the CLI run: {message}',
          ).replace('{message}', outcome.message),
        )
      })
    }
    // 'yolo_aborted' / 'cli_unavailable' need no further UI reaction —
    // mirrors the pre-C2 behavior exactly (the yolo path never showed a
    // Notice, and `cli_unavailable` mirrors the old `if (controller &&
    // coordinator)` guard falling through silently).
  }, [activeRuntimeId, sessionController, t])

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
    handleQuotePdfSelection,
    updatePdfQuoteMention,

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
